import type { WechatLoginEvent } from "../../shared/wechat-login.js";
import type { AutomationRunNotice } from "../../host/composition/automation-run.js";
import type { LocalProject } from "../../preload/project-authority-types.js";
import { isSettingsChange, type SettingsChange } from "../../shared/settings-change.js";
import type { PreparedOperationKey } from "../../host/composition/operation-key.js";
import type { ShellBusinessOperations } from "../../shared/shell-business-contracts.js";
import type { SessionCatalogSnapshot } from "../../shared/session-catalog.js";
import {
  credentialCommands,
  type CredentialFileCommand,
} from "@cjhyy/code-shell-core/internal/storage";
import type { DesktopAgentMethod } from "../../shared/desktop-agent-methods.js";
import { isPrivateTaskCommand } from "../task-inbox/private-task-command.js";
import type { MessagePortMain, UtilityProcess } from "electron";
import type { ListDiskSessionsResult } from "@cjhyy/code-shell-server/storage";
import type { ListSessionOptions } from "../../shared/disk-session-query.js";
import {
  isRpcRequest,
  isRpcResponse,
  type DesktopHostControl,
  type DesktopHostIdentity,
} from "../../shared/desktop-host-protocol.js";
import type { HostStatus } from "./main-workbenches.js";

type HostChild = Pick<UtilityProcess, "postMessage" | "on" | "once" | "kill">;
const restartWindowMs = 60_000;
const maxRestarts = 3;
type Schedule = (callback: () => void, ms: number) => () => void;
const scheduleTimer: Schedule = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export class DesktopHostSupervisor {
  private child?: HostChild;
  private ready = false;
  private retiring = false;
  private stopped = false;
  private disposePromise?: Promise<void>;
  private cancelTimer?: () => void;
  private readonly restartTimes: number[] = [];
  private readonly readyWaiters = new Set<() => void>();
  readonly mimiExternalListeners = new Set<() => void>();
  readonly mimiRecordListeners = new Set<
    (domain: import("../../shared/mimi-records.js").MimiRecordDomain) => void
  >();
  readonly automationListeners = new Set<(notice: AutomationRunNotice) => void>();
  readonly catalogListeners = new Set<(snapshot: SessionCatalogSnapshot) => void>();
  private readonly owners = new Map<string, number>();
  private sequence = 0;
  readonly projectRegistryListeners = new Set<(projects: LocalProject[]) => Promise<void>>();
  wechatEvent?: (event: WechatLoginEvent) => void;
  settingsCommitted?: (effects: SettingsChange) => Promise<void>;
  private readonly reads = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout?: NodeJS.Timeout;
      effects?: Promise<void>;
    }
  >();
  private readonly reviewGuards = new Map<AbortController, string>();
  private readonly deleting = new Set<string>();
  private readonly streamViews = new Set<string>();

  constructor(
    private readonly fork: () => HostChild,
    private readonly getVersion: () => string,
    private readonly setStatus: (status: HostStatus | "ready") => void,
    private readonly log: (message: string, details: Record<string, unknown>) => void,
    private readonly schedule: Schedule = scheduleTimer,
    private readonly now = Date.now,
  ) {}

  prepareRunKey?: (wrapped: string | null, create: boolean) => Promise<PreparedOperationKey | null>;
  private async runKey(child: HostChild, id: string, create: boolean) {
    const current = () => child === this.child && this.ready && !this.retiring && !this.stopped;
    try {
      const wrapped = await this.request("host/readOperationWrappedKey", {});
      if (!current() || !this.prepareRunKey || !(wrapped === null || typeof wrapped === "string"))
        throw new Error("Operation key unavailable");
      const key = await this.prepareRunKey(wrapped, create);
      if (current()) this.send({ jsonrpc: "2.0", id, result: key });
    } catch {
      if (current())
        this.send({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Operation keyring unavailable" },
        });
    }
  }

  start(): void {
    if (this.child || this.cancelTimer || this.stopped) return;
    try {
      this.child = this.fork();
    } catch (error) {
      this.log("fork_failed", { error: String(error) });
      this.restart();
      return;
    }
    const child = this.child;
    this.retiring = false;
    child.on("error", (type, location) => this.log("fatal_error", { type, location }));
    child.once("exit", (code) => {
      if (child !== this.child) return;
      this.clearTimer();
      this.child = undefined;
      this.rejectReads();
      this.ready = false;
      if (!this.stopped) {
        this.log("exited", { code });
        this.restart();
      }
    });
    child.on("message", (message) => {
      if (child !== this.child || this.stopped || this.retiring) return;
      if (isRpcResponse(message) && typeof message.id === "string") {
        const read = this.reads.get(message.id);
        if (!read) return;
        clearTimeout(read.timeout);
        this.reads.delete(message.id);
        if (message.error)
          read.reject(Object.assign(new Error(message.error.message), message.error));
        else read.resolve(read.effects ? read.effects.then(() => message.result) : message.result);
      } else if (message?.type === "wechat-login-event" && this.ready) {
        this.wechatEvent?.(message.event);
      } else if (
        message?.type === "settings-committed" &&
        this.ready &&
        typeof message.requestId === "string" &&
        isSettingsChange(message.effects)
      ) {
        this.refreshNative(message.requestId, () => this.settingsCommitted?.(message.effects));
      } else if (
        message?.type === "project-registry-committed" &&
        this.ready &&
        typeof message.requestId === "string" &&
        Array.isArray(message.projects)
      ) {
        this.refreshNative(message.requestId, async () => {
          await Promise.all(
            [...this.projectRegistryListeners].map((notify) => notify(message.projects)),
          );
        });
      } else if (message?.type === "mimi-external-changed" && this.ready) {
        for (const listener of this.mimiExternalListeners) listener();
      } else if (
        message?.type === "mimi-records-changed" &&
        this.ready &&
        (message.domain === "memories" || message.domain === "journal" || message.domain === "work-inbox")
      ) {
        for (const listener of this.mimiRecordListeners) listener(message.domain);
      } else if (message?.type === "automation-notice" && this.ready) {
        for (const listener of this.automationListeners) listener(message.notice);
      } else if (message?.type === "session-catalog-changed" && this.ready) {
        for (const listener of this.catalogListeners) listener(message.snapshot);
      } else if (isRpcRequest(message)) {
        if (
          this.ready &&
          this.prepareRunKey &&
          message.method === "app/operationLedgerKey" &&
          typeof message.id === "string" &&
          message.id.startsWith("host:run-key:") &&
          typeof message.params?.create === "boolean" &&
          Object.keys(message.params).length === 1 &&
          this.reads.size < 512
        ) {
          void this.runKey(child, message.id, message.params.create);
          return;
        }
        const response =
          message.method !== "app/getVersion"
            ? { error: { code: -32601, message: "Method not found" } }
            : message.params !== undefined
              ? { error: { code: -32602, message: "Invalid params" } }
              : { result: this.getVersion() };
        this.send({ jsonrpc: "2.0", id: message.id, ...response });
      } else if (message?.type === "ready" && !this.ready) {
        this.clearTimer();
        this.ready = true;
        // The ordered control pipe delivers authority state to a fresh host before any ports.
        for (const [sessionId, webContentsId] of this.owners) {
          if (!this.post({ type: "owner", sessionId, webContentsId })) return;
        }
        for (const sessionId of this.streamViews)
          if (!this.post({ type: "stream-view", sessionId, enabled: true })) return;
        for (const sessionId of this.deleting) {
          if (!this.post({ type: "deleting", sessionId, deleting: true })) return;
        }
        this.setStatus("ready");
        for (const listener of this.mimiRecordListeners) {
          listener("memories");
          listener("journal");
          listener("work-inbox");
        }
        for (const wake of this.readyWaiters) wake();
        this.readyWaiters.clear();
      }
    });
    this.cancelTimer = this.schedule(() => {
      this.log("startup_timeout", {});
      this.retire();
    }, 15_000);
  }

  workbenchCommand(
    caller: DesktopHostIdentity,
    method: DesktopAgentMethod,
    params: Record<string, unknown>,
  ) {
    return this.request(
      "host/workbenchCommand",
      { caller, method, params },
      method === "agent/run" || (method === "agent/forkSession" && params.mode === "summary")
        ? 0
        : 30_000,
    );
  }
  readWorkbenchOutput(caller: DesktopHostIdentity, sessionId: string, sinceSeq: number) {
    return this.request("host/readWorkbenchOutput", { caller, sessionId, sinceSeq });
  }
  async listDiskSessions(options: ListSessionOptions): Promise<ListDiskSessionsResult> {
    const page = (await this.request("host/listDiskSessions", { ...options })) as
      | ListDiskSessionsResult
      | undefined;
    if (
      page &&
      Array.isArray(page.sessions) &&
      (page.nextCursor === null || typeof page.nextCursor === "string")
    )
      return page;
    throw new Error("Desktop Host returned an invalid session page");
  }

  async taskCommand<T>(
    command: string,
    payload?: unknown,
    caller?: DesktopHostIdentity,
  ): Promise<T | null> {
    if (!isPrivateTaskCommand(command)) throw new Error("Unknown task command");
    return (await this.request(command, { payload, ...(caller && { caller }) })) as T | null;
  }

  async credentialCommand<T>(
    command: CredentialFileCommand,
    payload: unknown,
    caller?: DesktopHostIdentity,
  ): Promise<T> {
    if (!credentialCommands.includes(command)) throw new Error("Unknown credential command");
    const result = await this.request(command, { payload, ...(caller && { caller }) });
    if (result === null || result === undefined)
      throw new Error("Credential storage is unavailable");
    return result as T;
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.stopped) throw new Error("Desktop Host is unavailable");
    if (!this.ready) {
      if (this.readyWaiters.size >= 512) throw new Error("Desktop Host startup queue is full");
      const timeout = AbortSignal.timeout(15_000);
      const pending = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const gate = Promise.withResolvers<void>();
      const cancel = () => gate.reject(pending.reason);
      this.readyWaiters.add(gate.resolve);
      pending.addEventListener("abort", cancel, { once: true });
      try {
        await gate.promise;
      } finally {
        this.readyWaiters.delete(gate.resolve);
        pending.removeEventListener("abort", cancel);
      }
    }
    signal?.throwIfAborted();
    if (!this.ready || this.stopped) throw new Error("Desktop Host is unavailable");
  }

  async callBusiness<K extends keyof ShellBusinessOperations>(
    method: K,
    input: ShellBusinessOperations[K]["input"],
    signal?: AbortSignal,
  ): Promise<ShellBusinessOperations[K]["result"]> {
    signal?.throwIfAborted();
    if (!this.ready || this.stopped) await this.waitUntilReady(signal);
    // Model-backed work owns its cancellation and can outlast a normal data read.
    const waitsForRun =
      method === "mimi/backfillSegments" ||
      method === "mimi/closeSegment" ||
      method === "automation/command" && (input as { method?: string }).method === "cancel";
    // GitHub downloads have per-request deadlines and may stage a whole bundle.
    // Local copies can wait for a Skill worker and the cross-process directory lock.
    const longRunning = waitsForRun || method === "im/wechatLogin" || method === "memory/dream" ||
      method === "sources/uploadPicked" || method === "skills/inspectGithub" ||
      method === "skills/installGithub" || method === "skills/installLocal" ||
      method === "skills/update" || method === "skills/uninstall";
    const timeout = longRunning ? 0 : method === "ccRoom/sessions" || method === "ccRoom/history" ? 120_000 : 15_000;
    const value = await this.request("host/business", { method, input }, timeout, signal);
    signal?.throwIfAborted();
    return value as ShellBusinessOperations[K]["result"];
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.ready || this.stopped)
      return Promise.reject(new Error("Desktop Host is unavailable"));
    const id = `main:request:${++this.sequence}`;
    const withdraw = () => {
      const pending = this.reads.get(id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      if (method === "host/business") {
        this.send({ type: "withdraw-business", id });
        // Deletion waits for the isolated Engine's final state write and browser
        // teardown, even when the caller cancelled the run. Host exit rejects it.
        if (
          params.method === "automation/command" &&
          (params.input as { method?: string })?.method === "cancel"
        )
          return;
      }
      this.reads.delete(id);
      pending.reject(new Error("Desktop Host request expired or document changed"));
    };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = timeoutMs > 0 ? setTimeout(withdraw, timeoutMs).unref() : undefined;
      signal?.addEventListener("abort", withdraw, { once: true });
      this.reads.set(id, { resolve, reject, timeout });
      this.send({ jsonrpc: "2.0", id, method, params });
    }).finally(() => signal?.removeEventListener("abort", withdraw));
  }

  private refreshNative(requestId: string, refresh: () => Promise<void> | void) {
    const read = this.reads.get(requestId);
    const job = Promise.resolve().then(refresh);
    // A document may leave after its write committed. Refresh the native view even then.
    void job.catch((error) => this.log("native_refresh_failed", { error: String(error) }));
    if (read) read.effects = job;
  }

  watchOperationOwner(sessionId: string, webContentsId: number) {
    const owner = this.owners.get(sessionId);
    if (
      !this.ready ||
      this.stopped ||
      this.deleting.has(sessionId) ||
      (owner !== undefined && owner !== webContentsId) ||
      this.reviewGuards.size >= 8
    )
      throw new Error("Operation review owner changed");
    const guard = new AbortController();
    this.reviewGuards.set(guard, sessionId);
    return { signal: guard.signal, release: () => this.reviewGuards.delete(guard) };
  }
  private invalidateReviews(sessionId?: string) {
    for (const [guard, id] of this.reviewGuards)
      if (sessionId === undefined || id === sessionId) {
        this.reviewGuards.delete(guard);
        guard.abort();
      }
  }

  private rejectReads(): void {
    this.invalidateReviews();
    for (const read of this.reads.values()) {
      clearTimeout(read.timeout);
      read.reject(new Error("Desktop Host is unavailable"));
    }
    this.reads.clear();
  }

  setOwner(sessionId: string, webContentsId: number | null): void {
    if ((this.owners.get(sessionId) ?? null) === webContentsId) return;
    this.invalidateReviews(sessionId);
    if (webContentsId === null) this.owners.delete(sessionId);
    else this.owners.set(sessionId, webContentsId);
    this.post({ type: "owner", sessionId, webContentsId });
  }

  setStreamView(sessionId: string, enabled: boolean): void {
    if (this.streamViews.has(sessionId) === enabled) return;
    if (enabled) this.streamViews.add(sessionId);
    else this.streamViews.delete(sessionId);
    this.post({ type: "stream-view", sessionId, enabled });
  }

  setDeleting(sessionId: string, deleting: boolean): void {
    if (this.deleting.has(sessionId) === deleting) return;
    this.invalidateReviews(sessionId);
    if (deleting) this.deleting.add(sessionId);
    else this.deleting.delete(sessionId);
    this.post({ type: "deleting", sessionId, deleting });
  }

  post(message: DesktopHostControl, ports?: MessagePortMain[]): boolean {
    return this.ready && this.send(message, ports);
  }

  private send(message: unknown, ports?: MessagePortMain[]): boolean {
    if (!this.child || this.stopped) return false;
    try {
      this.child.postMessage(message, ports);
      return true;
    } catch (error) {
      // A host that missed an authority change may no longer serve any window.
      this.log("send_failed", { error: String(error) });
      this.retire();
      return false;
    }
  }

  private retire(): void {
    this.clearTimer();
    this.ready = false;
    this.retiring = true;
    this.rejectReads();
    this.setStatus("reconnecting");
    const child = this.child;
    if (child && !child.kill()) child.once("spawn", () => child.kill());
  }

  private restart(): void {
    const now = this.now();
    while (this.restartTimes.length && this.restartTimes[0]! <= now - restartWindowMs) {
      this.restartTimes.shift();
    }
    const atLimit = this.restartTimes.length >= maxRestarts;
    const delay = atLimit
      ? this.restartTimes[0]! + restartWindowMs - now
      : 250 * 2 ** this.restartTimes.length;
    this.setStatus(atLimit ? "unavailable" : "reconnecting");
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = undefined;
      this.restartTimes.push(this.now());
      if (atLimit) this.setStatus("reconnecting");
      this.start();
    }, delay);
  }

  private clearTimer(): void {
    this.cancelTimer?.();
    this.cancelTimer = undefined;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    const canClose = this.ready && this.child && this.send({ type: "shutdown" });
    this.rejectReads();
    this.stopped = true;
    for (const wake of this.readyWaiters) wake();
    this.readyWaiters.clear();
    this.ready = false;
    this.clearTimer();
    const child = this.child;
    this.disposePromise = new Promise<void>((resolve, reject) => {
      if (!child) return resolve();
      const kill = () => {
        if (!child.kill()) child.once("spawn", () => child.kill());
      };
      let cancelGrace: (() => void) | undefined;
      const cancel = this.schedule(() => reject(new Error("Desktop Host did not exit")), 5_000);
      child.once("exit", () => {
        cancelGrace?.();
        cancel();
        resolve();
      });
      if (canClose) cancelGrace = this.schedule(kill, 2_000);
      else kill();
    });
    return this.disposePromise;
  }
}
