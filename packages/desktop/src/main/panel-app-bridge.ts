import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import { resolvePanelAppBindingProjectPath, validateToolArgsStrict } from "@cjhyy/code-shell-core";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { AgentBridge } from "./agent-bridge.js";
import { claimPanelHostOwnerForRun } from "./panel-host-routing.js";
import type { PanelAppProtocolResource } from "./panel-app-protocol.js";
import { preparePanelApp } from "./panel-app-protocol.js";
import {
  PANEL_APP_API_VERSION,
  type PanelAppBindInput,
  type PanelAppHostContext,
  type PanelAppAgentToolInvocation,
} from "../shared/panel-apps.js";

const MAX_PARAMS_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_CALLS_PER_WINDOW = 30;
const RATE_WINDOW_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;
const PANEL_AGENT_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_AGENT_PROMPT_CHARS = 20_000;
const STORAGE_QUOTA_BYTES = 256 * 1024;
const MAX_NOTIFICATIONS_PER_WINDOW = 5;
const MAX_WORKSPACE_READ_BYTES = 480 * 1024;
const MAX_WORKSPACE_WRITE_BYTES = 384 * 1024;
const MAX_WORKSPACE_LIST_ENTRIES = 200;
const MAX_WORKSPACE_LIST_RESULT_BYTES = 512 * 1024;
const AGENT_TOOL_GUEST_WAIT_MS = 4_000;
const WORKSPACE_TEXT_EXTENSIONS = new Set([
  ".css",
  ".csv",
  ".html",
  ".json",
  ".md",
  ".svg",
  ".tsv",
  ".txt",
  ".yaml",
  ".yml",
]);
const DENIED_WORKSPACE_SEGMENTS = new Set(["node_modules"]);

interface GuestBinding {
  guest: WebContents;
  ownerWindowId: number;
  resource: PanelAppProtocolResource;
  context: PanelAppHostContext;
  callTimes: number[];
  notifyTimes: number[];
  bucket?: string;
  /** Project selected during prepare; immutable for this guest. */
  projectPath: string;
  /** Active session/worktree root; available only after renderer binding. */
  cwd?: string;
  /**
   * A submitPrompt handed to the worker but not yet reflected in
   * `context.busy`.
   *
   * `context.busy` is pushed from the renderer, so it lags. Now that
   * submitPrompt returns as soon as the worker accepts (instead of awaiting the
   * agent), two calls in quick succession both saw `busy === false` and both
   * started a run. This flag closes that window from the moment we hand the run
   * over until the worker acknowledges it.
   */
  agentSubmitInFlight?: boolean;
}

interface PendingAgentToolCall {
  guestId: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PanelAppBridgeOptions {
  isTrustedHost(sender: WebContents): boolean;
  isWorkspaceTrusted(cwd: string): boolean;
  /** Rechecked on prepare, bind, Agent invocation, and every Host call. */
  isPanelAppBound(projectPath: string, appId: string): boolean;
  getAgentBridge(): AgentBridge | null;
  /** Shows a system notification; injected so tests avoid Electron Notification. */
  showNotification?(notification: { title: string; body: string }): boolean;
  limits?: Partial<{
    maxParamsBytes: number;
    maxResultBytes: number;
    maxCallsPerWindow: number;
    rateWindowMs: number;
    callTimeoutMs: number;
    storageQuotaBytes: number;
    maxNotificationsPerWindow: number;
  }>;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf-8");
}

function workspaceRevision(content: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Panel App call timed out")), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class PanelAppBridge {
  private readonly guests = new Map<number, GuestBinding>();
  private readonly storageQueues = new Map<string, Promise<void>>();
  private readonly workspaceWriteQueues = new Map<string, Promise<void>>();
  private readonly pendingAgentToolCalls = new Map<string, PendingAgentToolCall>();

  constructor(private readonly options: PanelAppBridgeOptions) {}

  registerIpc(): void {
    ipcMain.handle("panel-apps:prepare", (event, id: string, projectPath: string) => {
      this.assertTrustedHost(event.sender);
      if (typeof id !== "string" || !id.startsWith("panel-app:")) {
        throw new Error("invalid Panel App id");
      }
      if (typeof projectPath !== "string" || !projectPath || projectPath.length > 4096) {
        throw new Error("Panel App requires a valid project binding");
      }
      const bindingProjectPath = resolvePanelAppBindingProjectPath(projectPath);
      const appId = id.slice("panel-app:".length);
      if (!this.options.isPanelAppBound(bindingProjectPath, appId)) {
        throw new Error(`Panel App '${appId}' is not bound to this project`);
      }
      return preparePanelApp(id, bindingProjectPath);
    });
    ipcMain.handle("panel-apps:bind", (event, input: PanelAppBindInput) => {
      this.assertTrustedHost(event.sender);
      return this.bindGuest(event.sender, input);
    });
    ipcMain.handle("panel-apps:invoke-agent-tool", (event, input: PanelAppAgentToolInvocation) => {
      this.assertTrustedHost(event.sender);
      return this.invokeAgentTool(event.sender, input);
    });
    ipcMain.on("panel-app:agent-tool-response", (event, response: unknown) => {
      this.handleAgentToolResponse(event.sender, response);
    });
    ipcMain.handle("panel-app:get-context", (event) => this.contextFor(event.sender));
    ipcMain.handle("panel-app:call", (event, method: string, params?: unknown) =>
      this.call(event.sender, method, params),
    );
  }

  registerGuest(
    guest: WebContents,
    owner: BrowserWindow,
    resource: PanelAppProtocolResource,
    projectPath: string,
  ): void {
    const binding: GuestBinding = {
      guest,
      ownerWindowId: owner.id,
      resource,
      context: {
        appId: resource.descriptor.appId,
        visible: false,
        theme: "system",
        locale: "en",
        apiVersion: PANEL_APP_API_VERSION,
      },
      callTimes: [],
      notifyTimes: [],
      projectPath,
    };
    this.guests.set(guest.id, binding);
    guest.once("destroyed", () => this.revokeGuest(guest.id));
    guest.setWindowOpenHandler(() => ({ action: "deny" }));
    guest.on("will-navigate", (event, url) => {
      const expected = new URL(
        `cspanel://${resource.descriptor.hostId}/${resource.entry
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}`,
      ).toString();
      try {
        if (new URL(url).toString() !== expected) event.preventDefault();
      } catch {
        event.preventDefault();
      }
    });
  }

  revokeGuest(guestId: number): void {
    this.guests.delete(guestId);
    for (const [requestId, pending] of this.pendingAgentToolCalls) {
      if (pending.guestId !== guestId) continue;
      clearTimeout(pending.timer);
      this.pendingAgentToolCalls.delete(requestId);
      pending.reject(new Error("Panel App closed before its Agent tool completed"));
    }
  }

  revokeAppId(appId: string): void {
    for (const [guestId, binding] of this.guests) {
      if (binding.resource.descriptor.appId !== appId) continue;
      this.revokeGuest(guestId);
      if (!binding.guest.isDestroyed()) binding.guest.stop();
    }
  }

  private assertTrustedHost(sender: WebContents): void {
    if (!this.options.isTrustedHost(sender)) throw new Error("untrusted Panel App host sender");
  }

  private findAgentToolBinding(
    appDescriptorId: string,
    bucket: string,
    ownerWindowId: number,
  ): GuestBinding | undefined {
    return [...this.guests.values()]
      .filter(
        (binding) =>
          !binding.guest.isDestroyed() &&
          binding.ownerWindowId === ownerWindowId &&
          binding.resource.descriptor.id === appDescriptorId &&
          binding.bucket === bucket,
      )
      .sort((left, right) => Number(right.context.visible) - Number(left.context.visible))[0];
  }

  private waitForAgentToolBinding(
    appDescriptorId: string,
    bucket: string,
    ownerWindowId: number,
  ): Promise<GuestBinding> {
    const existing = this.findAgentToolBinding(appDescriptorId, bucket, ownerWindowId);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolveBinding, reject) => {
      const startedAt = Date.now();
      const check = (): void => {
        const binding = this.findAgentToolBinding(appDescriptorId, bucket, ownerWindowId);
        if (binding) {
          resolveBinding(binding);
          return;
        }
        if (Date.now() - startedAt >= AGENT_TOOL_GUEST_WAIT_MS) {
          reject(new Error(`Panel App '${appDescriptorId}' did not become ready`));
          return;
        }
        setTimeout(check, 50);
      };
      setTimeout(check, 0);
    });
  }

  private async invokeAgentTool(
    sender: WebContents,
    input: PanelAppAgentToolInvocation,
  ): Promise<unknown> {
    if (
      !input ||
      typeof input.appDescriptorId !== "string" ||
      !input.appDescriptorId.startsWith("panel-app:") ||
      typeof input.bucket !== "string" ||
      input.bucket.length === 0 ||
      input.bucket.length > 512 ||
      typeof input.toolName !== "string" ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(input.toolName) ||
      !input.arguments ||
      typeof input.arguments !== "object" ||
      Array.isArray(input.arguments)
    ) {
      throw new Error("invalid Panel App Agent tool invocation");
    }
    if (jsonBytes(input.arguments) > (this.options.limits?.maxParamsBytes ?? MAX_PARAMS_BYTES)) {
      throw new Error("Panel App Agent tool arguments are too large");
    }
    const owner = BrowserWindow.fromWebContents(sender);
    if (!owner) throw new Error("Panel App Agent tool requires a live host window");
    const binding = await this.waitForAgentToolBinding(
      input.appDescriptorId,
      input.bucket,
      owner.id,
    );
    this.assertProjectBinding(binding);
    const declaration = binding.resource.descriptor.agent?.tools.find(
      (tool) => tool.name === input.toolName,
    );
    if (!declaration) {
      throw new Error(`Panel App tool '${input.toolName}' is not declared`);
    }
    const validationError = validateToolArgsStrict(
      input.toolName,
      input.arguments,
      declaration.inputSchema,
    );
    if (validationError) {
      throw new Error(`Invalid Panel App tool input: ${validationError}`);
    }
    const requestId = randomUUID();
    const result = await new Promise<unknown>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pendingAgentToolCalls.delete(requestId);
        reject(new Error(`Panel App tool '${input.toolName}' timed out`));
      }, this.options.limits?.callTimeoutMs ?? CALL_TIMEOUT_MS);
      this.pendingAgentToolCalls.set(requestId, {
        guestId: binding.guest.id,
        resolve: resolveResult,
        reject,
        timer,
      });
      try {
        binding.guest.send("panel-app:agent-tool-request", {
          requestId,
          toolName: input.toolName,
          arguments: input.arguments,
        });
      } catch (error) {
        clearTimeout(timer);
        this.pendingAgentToolCalls.delete(requestId);
        reject(
          error instanceof Error
            ? error
            : new Error("Panel App closed before its Agent tool request was sent"),
        );
      }
    });
    if (jsonBytes(result) > (this.options.limits?.maxResultBytes ?? MAX_RESULT_BYTES)) {
      throw new Error("Panel App Agent tool result is too large");
    }
    return result;
  }

  private handleAgentToolResponse(sender: WebContents, raw: unknown): void {
    const response = raw as {
      requestId?: unknown;
      ok?: unknown;
      result?: unknown;
      error?: unknown;
    } | null;
    if (!response || typeof response.requestId !== "string") return;
    const pending = this.pendingAgentToolCalls.get(response.requestId);
    if (!pending || pending.guestId !== sender.id) return;
    this.pendingAgentToolCalls.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok === true) {
      pending.resolve(response.result ?? null);
      return;
    }
    pending.reject(
      new Error(
        typeof response.error === "string"
          ? response.error.slice(0, 1_000)
          : "Panel App tool failed",
      ),
    );
  }

  private bindGuest(sender: WebContents, input: PanelAppBindInput): boolean {
    if (
      !input ||
      !Number.isSafeInteger(input.guestId) ||
      input.guestId <= 0 ||
      typeof input.appDescriptorId !== "string" ||
      typeof input.tabId !== "string" ||
      input.tabId.length === 0 ||
      input.tabId.length > 512
    ) {
      throw new Error("invalid Panel App binding");
    }
    const binding = this.guests.get(input.guestId);
    const owner = BrowserWindow.fromWebContents(sender);
    if (!binding || !owner || binding.ownerWindowId !== owner.id) {
      throw new Error("Panel App guest does not belong to this window");
    }
    if (binding.resource.descriptor.id !== input.appDescriptorId) {
      throw new Error("Panel App descriptor does not match attached guest");
    }
    if (
      typeof input.bucket !== "string" ||
      input.bucket.length === 0 ||
      input.bucket.length > 512
    ) {
      throw new Error("invalid Panel App bucket");
    }
    if (
      (input.sessionId != null &&
        (typeof input.sessionId !== "string" || input.sessionId.length > 256)) ||
      (input.cwd != null &&
        (typeof input.cwd !== "string" || !input.cwd || input.cwd.length > 4096)) ||
      typeof input.projectPath !== "string" ||
      !input.projectPath ||
      input.projectPath.length > 4096
    ) {
      throw new Error("invalid Panel App context");
    }
    const bindingProjectPath = resolvePanelAppBindingProjectPath(input.projectPath);
    if (bindingProjectPath !== binding.projectPath) {
      throw new Error("Panel App project binding does not match its prepared scope");
    }
    if (input.cwd && resolvePanelAppBindingProjectPath(input.cwd) !== binding.projectPath) {
      throw new Error("Panel App workspace does not belong to its bound project");
    }
    this.assertProjectBinding(binding);
    binding.bucket = input.bucket;
    binding.cwd = typeof input.cwd === "string" && input.cwd.length > 0 ? input.cwd : undefined;
    binding.context = {
      appId: binding.resource.descriptor.appId,
      visible: input.visible === true,
      theme: input.theme === "light" || input.theme === "dark" ? input.theme : "system",
      locale: typeof input.locale === "string" ? input.locale.slice(0, 16) : "en",
      apiVersion: PANEL_APP_API_VERSION,
      ...(binding.resource.descriptor.permissions.includes("context.session") && input.sessionId
        ? { sessionId: input.sessionId, busy: input.busy === true }
        : {}),
      ...(binding.resource.descriptor.permissions.includes("context.workspace") && input.cwd
        ? { cwd: input.cwd, trusted: this.options.isWorkspaceTrusted(input.cwd) }
        : {}),
    };
    if (!binding.guest.isDestroyed()) {
      binding.guest.send("panel-app:event", {
        event: "context.changed",
        payload: binding.context,
      });
    }
    return true;
  }

  private bindingFor(sender: WebContents): GuestBinding {
    const binding = this.guests.get(sender.id);
    if (!binding || binding.guest !== sender) throw new Error("Panel App scope is not bound");
    return binding;
  }

  private contextFor(sender: WebContents): PanelAppHostContext {
    const binding = this.bindingFor(sender);
    this.assertProjectBinding(binding);
    return { ...binding.context };
  }

  private async call(sender: WebContents, method: string, params?: unknown): Promise<unknown> {
    const binding = this.bindingFor(sender);
    this.assertProjectBinding(binding);
    if (!binding.bucket) throw new Error("Panel App scope is not bound");
    if (typeof method !== "string" || method.length > 64) throw new Error("invalid bridge method");
    const limits = this.options.limits;
    const paramsLimit =
      limits?.maxParamsBytes ??
      (method === "workspace.writeText"
        ? MAX_WORKSPACE_WRITE_BYTES * 6 + 8 * 1024
        : method === "storage.set"
          ? (limits?.storageQuotaBytes ?? STORAGE_QUOTA_BYTES) + 8 * 1024
          : MAX_PARAMS_BYTES);
    if (jsonBytes(params) > paramsLimit) {
      throw new Error("Panel App params are too large");
    }
    const now = Date.now();
    binding.callTimes = binding.callTimes.filter(
      (time) => now - time < (limits?.rateWindowMs ?? RATE_WINDOW_MS),
    );
    if (binding.callTimes.length >= (limits?.maxCallsPerWindow ?? MAX_CALLS_PER_WINDOW)) {
      throw new Error("Panel App rate limit exceeded");
    }
    binding.callTimes.push(now);

    const operation = this.dispatch(binding, method, params);
    const result = await withTimeout(operation, limits?.callTimeoutMs ?? CALL_TIMEOUT_MS);
    const resultLimit =
      limits?.maxResultBytes ??
      (method === "workspace.readText"
        ? MAX_WORKSPACE_READ_BYTES * 6 + 8 * 1024
        : method === "workspace.list"
          ? MAX_WORKSPACE_LIST_RESULT_BYTES
          : MAX_RESULT_BYTES);
    if (jsonBytes(result) > resultLimit) {
      throw new Error("Panel App result is too large");
    }
    return result;
  }

  private requirePermission(binding: GuestBinding, permission: string): void {
    if (!binding.resource.descriptor.permissions.includes(permission as never)) {
      throw new Error(`Panel App permission denied: ${permission}`);
    }
  }

  private assertProjectBinding(binding: GuestBinding): void {
    if (!this.options.isPanelAppBound(binding.projectPath, binding.resource.descriptor.appId)) {
      throw new Error(
        `Panel App '${binding.resource.descriptor.appId}' is no longer bound to this project`,
      );
    }
  }

  private async dispatch(binding: GuestBinding, method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case "storage.get":
        this.requirePermission(binding, "storage");
        return this.storageGet(binding, params);
      case "storage.set":
        this.requirePermission(binding, "storage");
        return this.storageSet(binding, params);
      case "storage.delete":
        this.requirePermission(binding, "storage");
        return this.storageDelete(binding, params);
      case "external.open":
        this.requirePermission(binding, "external.open");
        return this.openExternal(binding, params);
      case "agent.submitPrompt":
        this.requirePermission(binding, "agent.submitPrompt");
        return this.submitPrompt(binding, params);
      case "workspace.info":
        this.requirePermission(binding, "workspace.info");
        return this.workspaceInfo(binding);
      case "workspace.list":
        this.requirePermission(binding, "workspace.read");
        return this.workspaceList(binding, params);
      case "workspace.readText":
        this.requirePermission(binding, "workspace.read");
        return this.workspaceReadText(binding, params);
      case "workspace.writeText":
        this.requirePermission(binding, "workspace.write");
        return this.workspaceWriteText(binding, params);
      case "notifications.send":
        this.requirePermission(binding, "notifications.send");
        return this.sendNotification(binding, params);
      default:
        throw new Error(`unknown Panel App method: ${method}`);
    }
  }

  private storagePath(binding: GuestBinding): string {
    const namespace = createHash("sha256")
      .update("codeshell-panel-app-storage-v2")
      .update("\0")
      .update(binding.resource.descriptor.appId)
      .update("\0")
      .update(binding.projectPath)
      .digest("hex");
    return join(app.getPath("userData"), "panel-app-storage", `${namespace}.json`);
  }

  private async readStorage(binding: GuestBinding): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(await readFile(this.storagePath(binding), "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  private storageKey(params: unknown): string {
    const key = (params as { key?: unknown } | null)?.key;
    if (typeof key !== "string" || !/^[a-zA-Z0-9._-]{1,80}$/.test(key)) {
      throw new Error("storage key must match [a-zA-Z0-9._-]{1,80}");
    }
    return key;
  }

  private async storageGet(binding: GuestBinding, params: unknown): Promise<unknown> {
    return (await this.readStorage(binding))[this.storageKey(params)] ?? null;
  }

  private async storageSet(binding: GuestBinding, params: unknown): Promise<boolean> {
    const key = this.storageKey(params);
    const value = (params as { value?: unknown }).value;
    const encodedValue = JSON.stringify(value);
    if (encodedValue === undefined) throw new Error("Panel App storage only accepts JSON values");
    const jsonValue = JSON.parse(encodedValue) as unknown;
    return this.withStorageMutation(binding, async (file) => {
      const storage = await this.readStorage(binding);
      storage[key] = jsonValue;
      await this.writeStorage(file, storage);
      return true;
    });
  }

  private async storageDelete(binding: GuestBinding, params: unknown): Promise<boolean> {
    const key = this.storageKey(params);
    return this.withStorageMutation(binding, async (file) => {
      const storage = await this.readStorage(binding);
      const existed = Object.prototype.hasOwnProperty.call(storage, key);
      delete storage[key];
      await this.writeStorage(file, storage);
      return existed;
    });
  }

  private async writeStorage(file: string, storage: Record<string, unknown>): Promise<void> {
    const serialized = `${JSON.stringify(storage)}\n`;
    if (
      Buffer.byteLength(serialized, "utf-8") >
      (this.options.limits?.storageQuotaBytes ?? STORAGE_QUOTA_BYTES)
    ) {
      throw new Error("Panel App storage quota exceeded");
    }
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, serialized, { encoding: "utf-8", mode: 0o600 });
      await rename(temporary, file);
      await chmod(file, 0o600).catch(() => undefined);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async withStorageMutation<T>(
    binding: GuestBinding,
    mutate: (file: string) => Promise<T>,
  ): Promise<T> {
    const file = this.storagePath(binding);
    const ready = (this.storageQueues.get(file) ?? Promise.resolve()).catch(() => undefined);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = ready.then(() => gate);
    this.storageQueues.set(file, tail);
    await ready;
    try {
      return await mutate(file);
    } finally {
      release();
      if (this.storageQueues.get(file) === tail) this.storageQueues.delete(file);
    }
  }

  private async openExternal(binding: GuestBinding, params: unknown): Promise<boolean> {
    const rawUrl = (params as { url?: unknown } | null)?.url;
    let url: URL;
    try {
      url = new URL(typeof rawUrl === "string" ? rawUrl : "");
    } catch {
      throw new Error("external.open only accepts https URLs");
    }
    if (
      typeof rawUrl !== "string" ||
      rawUrl.length > 2048 ||
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error("external.open only accepts https URLs");
    }
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    const decision = await dialog.showMessageBox(owner, {
      type: "question",
      buttons: ["Open", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: binding.resource.descriptor.title,
      message: "Open this link in your system browser?",
      detail: url.toString(),
      noLink: true,
    });
    if (decision.response !== 0) return false;
    await shell.openExternal(url.toString());
    return true;
  }

  private async submitPrompt(binding: GuestBinding, params: unknown): Promise<unknown> {
    const input = params as { prompt?: unknown; displayText?: unknown } | null;
    const task = input?.prompt;
    if (
      typeof task !== "string" ||
      task.trim().length === 0 ||
      task.length > MAX_AGENT_PROMPT_CHARS
    ) {
      throw new Error("agent.submitPrompt requires a non-empty prompt up to 20000 characters");
    }
    if (
      input?.displayText !== undefined &&
      (typeof input.displayText !== "string" ||
        input.displayText.trim().length === 0 ||
        input.displayText.length > MAX_AGENT_PROMPT_CHARS)
    ) {
      throw new Error(
        "agent.submitPrompt displayText must be non-empty and up to 20000 characters",
      );
    }
    const { sessionId, cwd } = binding.context;
    if (!sessionId) throw new Error("agent.submitPrompt requires context.session permission");
    // Reject on EITHER the renderer-reported busy state or our own in-flight
    // reservation. The reservation covers the gap where a run has been handed to
    // the worker but `context.busy` has not been pushed back yet.
    if (binding.context.busy || binding.agentSubmitInFlight) {
      throw new Error("the target session is busy");
    }
    const bridge = this.options.getAgentBridge();
    if (!bridge) throw new Error("agent worker is unavailable");

    const appLabel = binding.resource.descriptor.title.trim();
    const prefix = appLabel ? `【${appLabel}】 ` : "";
    const requestedDisplayText =
      typeof input?.displayText === "string" ? input.displayText.trim() : task.trim();
    const displayText = `${prefix}${requestedDisplayText.slice(
      0,
      MAX_AGENT_PROMPT_CHARS - prefix.length,
    )}`;
    const clientMessageId = `panel:${binding.resource.descriptor.appId}:${randomUUID()}`;

    // Panel App submissions originate in main, so they never cross the
    // renderer agent:msg path that normally claims the session's unique host
    // window. Claim it explicitly before dispatch; the worker may invoke a
    // mutating Panel tool immediately after accepting the run.
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    claimPanelHostOwnerForRun(bridge, sessionId, owner);

    // Claim the slot BEFORE the await point. Everything above is synchronous, so
    // no second call can interleave between the check and this assignment.
    binding.agentSubmitInFlight = true;

    void bridge
      .requestWorker(
        "agent/run",
        {
          task: task.trim(),
          displayText,
          clientMessageId,
          sessionId,
          cwd,
          bucket: binding.bucket,
        },
        PANEL_AGENT_RUN_TIMEOUT_MS,
        // This RPC is a fire-and-forget backstop, not the completion signal —
        // real progress arrives on the session stream. The 24h timeout exists
        // only so the correlation is eventually reclaimed, so release it as soon
        // as the worker is known to be gone instead of holding it for a day.
        { settleOnExit: true, failFast: true },
      )
      .then((result) => {
        // Release once the worker has answered. By now either the run finished
        // or it failed; in the success case `context.busy` has long since been
        // pushed by the renderer, so there is no gap to re-open.
        binding.agentSubmitInFlight = false;
        if (result.ok) return;
        bridge.ingestExternalEvent(sessionId, {
          type: "error",
          error: `Panel App request failed: ${result.message}`,
        });
      })
      .catch((error: unknown) => {
        // Must also release on failure, or one dropped request would wedge the
        // panel into a permanent "session is busy".
        binding.agentSubmitInFlight = false;
        bridge.ingestExternalEvent(sessionId, {
          type: "error",
          error: `Panel App request failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });

    return { accepted: true, clientMessageId };
  }

  /** Read-only workspace metadata. Git branch is best-effort via .git/HEAD (no exec). */
  private async workspaceInfo(binding: GuestBinding): Promise<unknown> {
    const cwd = binding.cwd;
    if (!cwd) return { name: null, root: null, trusted: false, gitBranch: null };
    let gitBranch: string | null = null;
    try {
      const root = await realpath(cwd);
      const gitPath = join(root, ".git");
      const gitMetadata = await lstat(gitPath);
      if (gitMetadata.isSymbolicLink() || !gitMetadata.isDirectory()) {
        throw new Error("git metadata is not a regular directory");
      }
      const canonicalGitPath = await realpath(gitPath);
      if (!this.isWithinWorkspace(root, canonicalGitPath)) {
        throw new Error("git metadata escapes the workspace");
      }
      const headPath = join(canonicalGitPath, "HEAD");
      const headMetadata = await lstat(headPath);
      if (headMetadata.isSymbolicLink() || !headMetadata.isFile() || headMetadata.size > 4 * 1024) {
        throw new Error("git HEAD is unavailable");
      }
      const handle = await open(headPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      let head: string;
      try {
        const { buffer } = await this.readBoundedWorkspaceFile(handle, 4 * 1024);
        head = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } finally {
        await handle.close();
      }
      const match = /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
      const candidate = match?.[1];
      gitBranch =
        candidate && candidate.length <= 255 && !/[\u0000-\u001f\u007f]/u.test(candidate)
          ? candidate
          : null;
    } catch {
      // Non-Git workspaces intentionally report no branch.
    }
    return {
      name: basename(cwd),
      root: cwd,
      trusted: this.options.isWorkspaceTrusted(cwd),
      gitBranch,
    };
  }

  private workspaceRelativePath(params: unknown, allowRoot = false): string {
    const rawPath = (params as { path?: unknown } | null)?.path;
    if (allowRoot && (rawPath === undefined || rawPath === "" || rawPath === ".")) return ".";
    if (
      typeof rawPath !== "string" ||
      rawPath.length === 0 ||
      rawPath.length > 512 ||
      isAbsolute(rawPath) ||
      rawPath.includes(":") ||
      rawPath.includes("\\") ||
      /[\u0000-\u001f\u007f]/u.test(rawPath)
    ) {
      throw new Error("workspace path must be a safe relative path");
    }
    const segments = rawPath.split("/");
    if (segments.some((segment) => !this.isAllowedWorkspaceSegment(segment))) {
      throw new Error("workspace path must be a safe relative path");
    }
    return segments.join("/");
  }

  private isAllowedWorkspaceSegment(segment: string): boolean {
    const windowsBaseName = (segment.split(".", 1)[0] ?? "").trimEnd().toUpperCase();
    const windowsDeviceName = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(windowsBaseName);
    return (
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith(".") &&
      !DENIED_WORKSPACE_SEGMENTS.has(segment.toLowerCase()) &&
      !segment.includes(":") &&
      !segment.includes("\\") &&
      !/[. ]$/u.test(segment) &&
      !windowsDeviceName &&
      !/[\u0000-\u001f\u007f]/u.test(segment)
    );
  }

  private requireWorkspaceFileExtension(relativePath: string): void {
    if (!WORKSPACE_TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) {
      throw new Error("workspace file type is not allowed");
    }
  }

  private async trustedWorkspaceRoot(binding: GuestBinding): Promise<string> {
    const cwd = binding.cwd;
    if (!cwd || !this.options.isWorkspaceTrusted(cwd)) {
      throw new Error("workspace file access requires a trusted workspace");
    }
    const root = await realpath(cwd);
    if (!(await stat(root)).isDirectory()) throw new Error("workspace root is unavailable");
    return root;
  }

  private isWithinWorkspace(root: string, candidate: string, allowRoot = false): boolean {
    if (allowRoot && candidate === root) return true;
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return candidate.startsWith(prefix);
  }

  private async resolveExistingWorkspacePath(root: string, relativePath: string): Promise<string> {
    if (relativePath === ".") return root;
    let current = root;
    for (const segment of relativePath.split("/")) {
      const candidate = join(current, segment);
      const metadata = await lstat(candidate);
      if (metadata.isSymbolicLink()) {
        throw new Error("workspace path contains an unsafe symbolic link");
      }
      const canonical = await realpath(candidate);
      if (!this.isWithinWorkspace(root, canonical)) {
        throw new Error("workspace path escapes the root");
      }
      current = canonical;
    }
    return current;
  }

  private async workspaceList(binding: GuestBinding, params: unknown): Promise<unknown> {
    const relativePath = this.workspaceRelativePath(params, true);
    const root = await this.trustedWorkspaceRoot(binding);
    let directory: string;
    try {
      directory = await this.resolveExistingWorkspacePath(root, relativePath);
      if (
        !this.isWithinWorkspace(root, directory, true) ||
        !(await stat(directory)).isDirectory()
      ) {
        throw new Error("workspace directory is unavailable");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { path: relativePath, entries: [], truncated: false };
      }
      throw error;
    }
    const entries: Array<{
      name: string;
      path: string;
      kind: "directory" | "file";
      size?: number;
      modifiedAt?: number;
    }> = [];
    const candidates = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (entry) =>
          this.isAllowedWorkspaceSegment(entry.name) &&
          !entry.isSymbolicLink() &&
          (entry.isDirectory() ||
            (entry.isFile() && WORKSPACE_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))),
      )
      .filter((entry) => {
        const childRelative = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
        return childRelative.length <= 512;
      })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of candidates.slice(0, MAX_WORKSPACE_LIST_ENTRIES)) {
      const childRelative = relativePath === "." ? entry.name : `${relativePath}/${entry.name}`;
      let metadata: Stats;
      try {
        metadata = await lstat(join(directory, entry.name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        entries.push({ name: entry.name, path: childRelative, kind: "directory" });
        continue;
      }
      if (!metadata.isFile()) continue;
      entries.push({
        name: entry.name,
        path: childRelative,
        kind: "file",
        size: metadata.size,
        modifiedAt: metadata.mtimeMs,
      });
    }
    return {
      path: relativePath,
      entries,
      truncated: candidates.length > MAX_WORKSPACE_LIST_ENTRIES,
    };
  }

  private async workspaceReadText(binding: GuestBinding, params: unknown): Promise<unknown> {
    const relativePath = this.workspaceRelativePath(params);
    this.requireWorkspaceFileExtension(relativePath);
    const root = await this.trustedWorkspaceRoot(binding);
    const target = await this.resolveExistingWorkspacePath(root, relativePath);
    if (!this.isWithinWorkspace(root, target)) throw new Error("workspace path escapes the root");
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { buffer, metadata } = await this.readBoundedWorkspaceFile(handle);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch (error) {
        throw new Error("workspace file is not valid UTF-8 text", { cause: error });
      }
      return {
        path: relativePath,
        content,
        size: buffer.length,
        modifiedAt: metadata.mtimeMs,
        revision: workspaceRevision(buffer),
      };
    } finally {
      await handle.close();
    }
  }

  private async readBoundedWorkspaceFile(
    handle: FileHandle,
    maxBytes = MAX_WORKSPACE_READ_BYTES,
  ): Promise<{ buffer: Buffer; metadata: Stats }> {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error("workspace path is not a file");
    if (metadata.size > maxBytes) throw new Error("workspace file is too large");
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error("workspace file is too large");
    return { buffer: buffer.subarray(0, bytesRead), metadata };
  }

  private async ensureWorkspaceDirectory(root: string, relativeDirectory: string): Promise<string> {
    if (relativeDirectory === ".") return root;
    let current = root;
    for (const segment of relativeDirectory.split(/[\\/]/)) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error("workspace path contains an unsafe directory");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try {
          await mkdir(current, { mode: 0o755 });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          const metadata = await lstat(current);
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error("workspace path contains an unsafe directory", {
              cause: mkdirError,
            });
          }
        }
      }
      const canonical = await realpath(current);
      if (!this.isWithinWorkspace(root, canonical)) {
        throw new Error("workspace path escapes the root");
      }
      current = canonical;
    }
    return current;
  }

  private async workspaceWriteText(binding: GuestBinding, params: unknown): Promise<unknown> {
    const relativePath = this.workspaceRelativePath(params);
    this.requireWorkspaceFileExtension(relativePath);
    const content = (params as { content?: unknown } | null)?.content;
    const expectedModifiedAt = (params as { expectedModifiedAt?: unknown } | null)
      ?.expectedModifiedAt;
    const expectedRevision = (params as { expectedRevision?: unknown } | null)?.expectedRevision;
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content, "utf-8") > MAX_WORKSPACE_WRITE_BYTES
    ) {
      throw new Error(`workspace text must be at most ${MAX_WORKSPACE_WRITE_BYTES} bytes`);
    }
    if (
      expectedModifiedAt !== undefined &&
      expectedModifiedAt !== null &&
      (typeof expectedModifiedAt !== "number" || !Number.isFinite(expectedModifiedAt))
    ) {
      throw new Error("expectedModifiedAt must be a number, null, or omitted");
    }
    if (
      expectedRevision !== undefined &&
      (typeof expectedRevision !== "string" || !/^sha256:[0-9a-f]{64}$/.test(expectedRevision))
    ) {
      throw new Error("expectedRevision must be a sha256 revision or omitted");
    }
    if (expectedModifiedAt === undefined && expectedRevision === undefined) {
      throw new Error(
        "workspace.writeText requires expectedModifiedAt or expectedRevision to prevent blind overwrites",
      );
    }
    const root = await this.trustedWorkspaceRoot(binding);
    const target = resolve(root, ...relativePath.split("/"));
    if (!this.isWithinWorkspace(root, target)) throw new Error("workspace path escapes the root");
    return this.withWorkspaceWrite(target, async () => {
      const parent = await this.ensureWorkspaceDirectory(root, dirname(relativePath));
      const canonicalTarget = join(parent, basename(relativePath));
      let currentModifiedAt: number | null = null;
      let currentRevision: string | null = null;
      let targetMode = 0o644;
      try {
        const metadata = await lstat(canonicalTarget);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error("workspace target is not a regular file");
        }
        currentModifiedAt = metadata.mtimeMs;
        targetMode = metadata.mode & 0o777;
        if (expectedRevision !== undefined) {
          const handle = await open(canonicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            currentRevision = workspaceRevision(
              (await this.readBoundedWorkspaceFile(handle)).buffer,
            );
          } finally {
            await handle.close();
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const hasExpectation = expectedModifiedAt !== undefined;
      const conflicts =
        expectedRevision !== undefined
          ? currentRevision !== expectedRevision
          : hasExpectation &&
            ((expectedModifiedAt === null && currentModifiedAt !== null) ||
              (typeof expectedModifiedAt === "number" &&
                (currentModifiedAt === null ||
                  Math.abs(currentModifiedAt - expectedModifiedAt) > 0.001)));
      if (conflicts) throw new Error("workspace file changed since it was opened");

      const temporary = join(parent, `.${basename(relativePath)}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, content, { encoding: "utf-8", mode: 0o600 });
        const createOnly = expectedRevision === undefined && expectedModifiedAt === null;
        if (createOnly) {
          try {
            await link(temporary, canonicalTarget);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              throw new Error("workspace file changed since it was opened", { cause: error });
            }
            throw error;
          }
          await rm(temporary, { force: true }).catch(() => undefined);
        } else {
          await rename(temporary, canonicalTarget);
        }
        await chmod(canonicalTarget, targetMode).catch(() => undefined);
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      const metadata = await stat(canonicalTarget);
      return {
        path: relativePath,
        size: metadata.size,
        modifiedAt: metadata.mtimeMs,
        revision: workspaceRevision(content),
      };
    });
  }

  private async withWorkspaceWrite<T>(file: string, mutate: () => Promise<T>): Promise<T> {
    const ready = (this.workspaceWriteQueues.get(file) ?? Promise.resolve()).catch(() => undefined);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const tail = ready.then(() => gate);
    this.workspaceWriteQueues.set(file, tail);
    await ready;
    try {
      return await mutate();
    } finally {
      release();
      if (this.workspaceWriteQueues.get(file) === tail) this.workspaceWriteQueues.delete(file);
    }
  }

  private sendNotification(binding: GuestBinding, params: unknown): boolean {
    const body = (params as { body?: unknown } | null)?.body;
    const title = (params as { title?: unknown } | null)?.title;
    if (typeof body !== "string" || body.trim().length === 0 || body.length > 500) {
      throw new Error("notifications.send requires a non-empty body up to 500 characters");
    }
    if (
      title !== undefined &&
      (typeof title !== "string" || title.length === 0 || title.length > 80)
    ) {
      throw new Error("notifications.send title must be 1-80 characters");
    }
    const limits = this.options.limits;
    const now = Date.now();
    binding.notifyTimes = binding.notifyTimes.filter(
      (time) => now - time < (limits?.rateWindowMs ?? RATE_WINDOW_MS),
    );
    if (
      binding.notifyTimes.length >=
      (limits?.maxNotificationsPerWindow ?? MAX_NOTIFICATIONS_PER_WINDOW)
    ) {
      throw new Error("Panel App notification limit exceeded");
    }
    binding.notifyTimes.push(now);
    const show = this.options.showNotification;
    if (!show) throw new Error("system notifications are unavailable");
    // The trusted app title always prefixes the shown title so one Panel App
    // cannot impersonate CodeShell or another app.
    return show({
      title: title
        ? `${binding.resource.descriptor.title}: ${title}`
        : binding.resource.descriptor.title,
      body: body.trim(),
    });
  }
}
