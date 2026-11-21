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
  private readonly owners = new Map<string, number>();
  private sequence = 0;
  private readonly reads = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
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
        if (message.error) read.reject(new Error(message.error.message));
        else read.resolve(message.result);
      } else if (isRpcRequest(message)) {
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
      }
    });
    this.cancelTimer = this.schedule(() => {
      this.log("startup_timeout", {});
      this.retire();
    }, 15_000);
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

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.ready || this.stopped)
      return Promise.reject(new Error("Desktop Host is unavailable"));
    const id = `main:request:${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.reads.delete(id);
        reject(new Error("Desktop Host request timed out"));
      }, 15_000).unref();
      this.reads.set(id, { resolve, reject, timeout });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private rejectReads(): void {
    for (const read of this.reads.values()) {
      clearTimeout(read.timeout);
      read.reject(new Error("Desktop Host is unavailable"));
    }
    this.reads.clear();
  }

  setOwner(sessionId: string, webContentsId: number | null): void {
    if ((this.owners.get(sessionId) ?? null) === webContentsId) return;
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
