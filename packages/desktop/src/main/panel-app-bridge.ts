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
import { PanelAppProcessService, type PanelProcessOwner } from "./panel-app-process-service.js";
import {
  PANEL_APP_API_VERSION,
  type PanelAppBindInput,
  type PanelAppCookieCredential,
  type PanelAppHostContext,
  type PanelAppAgentToolInvocation,
} from "../shared/panel-apps.js";

const MAX_PARAMS_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 256 * 1024;
const MAX_CALLS_PER_WINDOW = 30;
const RATE_WINDOW_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;
const PDF_EXPORT_TIMEOUT_MS = 30_000;
const AUDIO_TRANSCRIBE_TIMEOUT_MS = 180_000;
const COOKIE_LOGIN_TIMEOUT_MS = 30 * 60 * 1_000;
const PROCESS_CONSENT_TIMEOUT_MS = 30 * 60 * 1_000;
const PANEL_AGENT_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_AGENT_PROMPT_CHARS = 20_000;
const STORAGE_QUOTA_BYTES = 256 * 1024;
const MAX_NOTIFICATIONS_PER_WINDOW = 5;
const MAX_WORKSPACE_READ_BYTES = 480 * 1024;
const MAX_WORKSPACE_WRITE_BYTES = 384 * 1024;
const MAX_WORKSPACE_PDF_BYTES = 20 * 1024 * 1024;
const MAX_WORKSPACE_LIST_ENTRIES = 200;
const MAX_WORKSPACE_LIST_RESULT_BYTES = 512 * 1024;
const MAX_AUDIO_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPT_CHARS = 20_000;
const AGENT_TOOL_GUEST_WAIT_MS = 4_000;
const AUDIO_MIME_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
]);
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
  /** Host-owned Cookie login operations. Cookie values never cross into the Panel guest. */
  cookieCredentials?: {
    list(cwd?: string): Promise<PanelAppCookieCredential[]>;
    loginAndSave(input: {
      appId: string;
      providerId: string;
      providerLabel: string;
      url: string;
      cwd?: string;
      bucket?: string;
    }): Promise<
      | {
          ok: true;
          credential: PanelAppCookieCredential;
          cookieCount: number;
          restoredCount: number;
        }
      | { ok: false; cancelled?: boolean; error?: string }
    >;
    restore(input: {
      credentialId: string;
      cwd?: string;
      bucket?: string;
    }): Promise<{ count: number }>;
  };
  /** Project- and task-scoped recurring jobs. The Panel never receives jobs from another cwd. */
  automations?: {
    list(): Promise<
      Array<{
        id: string;
        name: string;
        schedule: string;
        prompt: string;
        enabled: boolean;
        cwd: string | null;
        timezone: string | null;
        permissionLevel: string | null;
        lastRun: number | null;
        nextRun: number | null;
        runCount: number;
        resumeSessionId: string | null;
      }>
    >;
    create(input: {
      name: string;
      schedule: string;
      prompt: string;
      cwd: string;
      timezone?: string;
      permissionLevel: "full";
      resumeSessionId: string;
    }): Promise<unknown>;
    update(
      id: string,
      patch: {
        name?: string;
        schedule?: string;
        prompt?: string;
        timezone?: string;
      },
    ): Promise<unknown>;
    pause(id: string): Promise<boolean>;
    resume(id: string): Promise<boolean>;
    delete(id: string): Promise<boolean>;
    runNow(id: string): Promise<boolean>;
  };
  /** Host-owned microphone consent and speech-to-text. Audio is never persisted by the bridge. */
  audioTranscription?: {
    status(cwd: string): {
      available: boolean;
      source: "connection" | "fallback" | "none";
      model?: string;
    };
    requestMicrophoneAccess(): Promise<{ granted: boolean }>;
    transcribe(input: {
      cwd: string;
      audio: Uint8Array;
      mimeType: string;
      language?: string;
    }): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  };
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
  private readonly processService: PanelAppProcessService;

  constructor(private readonly options: PanelAppBridgeOptions) {
    this.processService = new PanelAppProcessService({
      confirmExecution: async ({ guestId, appTitle, executable, executablePath }) => {
        const owner = this.guests.get(guestId);
        const window = owner ? BrowserWindow.fromId(owner.ownerWindowId) : null;
        if (!window || window.isDestroyed()) throw new Error("owner window is unavailable");
        const decision = await dialog.showMessageBox(window, {
          type: "warning",
          buttons: ["Allow", "Cancel"],
          defaultId: 1,
          cancelId: 1,
          title: appTitle,
          message: `${appTitle} wants to run ${executable}`,
          detail:
            `${executablePath}\n\n` +
            "CodeShell will run it without a shell. This approval lasts until CodeShell restarts or the app updates.",
          noLink: true,
        });
        return decision.response === 0;
      },
    });
  }

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
    this.processService.revokeGuest(guestId);
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
    const result = await withTimeout(
      operation,
      limits?.callTimeoutMs ??
        (method === "workspace.exportPdf"
          ? PDF_EXPORT_TIMEOUT_MS
          : method === "audio.transcribe"
            ? AUDIO_TRANSCRIBE_TIMEOUT_MS
            : method === "credentials.cookies.loginAndSave"
              ? COOKIE_LOGIN_TIMEOUT_MS
              : method === "filesystem.pickDirectory" || method === "process.spawn"
                ? PROCESS_CONSENT_TIMEOUT_MS
                : CALL_TIMEOUT_MS),
    );
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
      case "workspace.exportPdf":
        this.requirePermission(binding, "workspace.write");
        return this.workspaceExportPdf(binding, params);
      case "notifications.send":
        this.requirePermission(binding, "notifications.send");
        return this.sendNotification(binding, params);
      case "audio.status":
        this.requirePermission(binding, "audio.transcribe");
        return this.panelAudioStatus(binding);
      case "audio.requestMicrophoneAccess":
        this.requirePermission(binding, "audio.transcribe");
        return this.requestPanelMicrophoneAccess(binding);
      case "audio.transcribe":
        this.requirePermission(binding, "audio.transcribe");
        return this.transcribePanelAudio(binding, params);
      case "credentials.cookies.list":
        this.requirePermission(binding, "credentials.cookies");
        return this.listCookieCredentials(binding, params);
      case "credentials.cookies.loginAndSave":
        this.requirePermission(binding, "credentials.cookies");
        return this.loginAndSaveCookieCredential(binding, params);
      case "credentials.cookies.restore":
        this.requirePermission(binding, "credentials.cookies");
        return this.restoreCookieCredential(binding, params);
      case "automations.list":
        this.requirePermission(binding, "automations.manage");
        return this.listPanelAutomations(binding);
      case "automations.create":
        this.requirePermission(binding, "automations.manage");
        return this.createPanelAutomation(binding, params);
      case "automations.update":
        this.requirePermission(binding, "automations.manage");
        return this.updatePanelAutomation(binding, params);
      case "automations.pause":
      case "automations.resume":
      case "automations.delete":
      case "automations.runNow":
        this.requirePermission(binding, "automations.manage");
        return this.controlPanelAutomation(binding, method, params);
      case "process.find":
        this.requirePermission(binding, "process");
        return this.processService.findExecutable(this.processOwner(binding), params);
      case "process.spawn":
        this.requirePermission(binding, "process");
        return this.processService.start(this.processOwner(binding), params);
      case "process.cancel":
        this.requirePermission(binding, "process");
        return this.processService.cancel(this.processOwner(binding), params);
      case "filesystem.getKnownDirectory":
        this.requirePermission(binding, "process");
        return this.getKnownProcessDirectory(binding, params);
      case "filesystem.pickDirectory":
        this.requirePermission(binding, "process");
        return this.pickProcessDirectory(binding);
      case "filesystem.openDirectory":
        this.requirePermission(binding, "process");
        return this.openProcessDirectory(binding, params);
      default:
        throw new Error(`unknown Panel App method: ${method}`);
    }
  }

  private processOwner(binding: GuestBinding): PanelProcessOwner {
    return {
      guestId: binding.guest.id,
      appId: binding.resource.descriptor.appId,
      appTitle: binding.resource.descriptor.title,
      revision: binding.resource.descriptor.revision,
      send: (event, payload) => {
        if (binding.guest.isDestroyed()) return;
        binding.guest.send("panel-app:event", { event, payload });
      },
    };
  }

  private getKnownProcessDirectory(binding: GuestBinding, params: unknown): Promise<unknown> {
    const name = (params as { name?: unknown } | null)?.name;
    if (name !== "downloads") throw new Error("unsupported known directory");
    return this.processService.grantDirectory(this.processOwner(binding), app.getPath("downloads"));
  }

  private async pickProcessDirectory(binding: GuestBinding): Promise<unknown> {
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    const selected = await dialog.showOpenDialog(owner, {
      title: "Choose output directory",
      defaultPath: app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
    return this.processService.grantDirectory(this.processOwner(binding), selected.filePaths[0]);
  }

  private async openProcessDirectory(binding: GuestBinding, params: unknown): Promise<boolean> {
    const handle = (params as { handle?: unknown } | null)?.handle;
    const path = this.processService.directoryPath(this.processOwner(binding), handle);
    const error = await shell.openPath(path);
    if (error) throw new Error(`failed to open directory: ${error}`);
    return true;
  }

  private panelAudioHost(binding: GuestBinding) {
    const host = this.options.audioTranscription;
    if (!host) throw new Error("Panel App audio transcription host is unavailable");
    if (!binding.context.cwd || !binding.context.trusted) {
      throw new Error("Panel App audio transcription requires a trusted workspace");
    }
    return host;
  }

  private panelAudioStatus(binding: GuestBinding): unknown {
    const host = this.panelAudioHost(binding);
    return host.status(binding.context.cwd!);
  }

  private requestPanelMicrophoneAccess(binding: GuestBinding): Promise<{ granted: boolean }> {
    return this.panelAudioHost(binding).requestMicrophoneAccess();
  }

  private async transcribePanelAudio(
    binding: GuestBinding,
    params: unknown,
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const input = params as {
      audio?: unknown;
      mimeType?: unknown;
      language?: unknown;
    } | null;
    if (!(input?.audio instanceof ArrayBuffer)) {
      throw new Error("audio.transcribe requires raw ArrayBuffer audio");
    }
    if (input.audio.byteLength === 0 || input.audio.byteLength > MAX_AUDIO_TRANSCRIBE_BYTES) {
      throw new Error("audio.transcribe audio must be between 1 byte and 25 MiB");
    }
    const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim().toLowerCase() : "";
    const baseMimeType = mimeType.split(";", 1)[0] ?? "";
    if (!AUDIO_MIME_TYPES.has(baseMimeType)) {
      throw new Error("audio.transcribe MIME type is not supported");
    }
    const language =
      typeof input.language === "string" && input.language.trim()
        ? input.language.trim()
        : undefined;
    if (language && !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i.test(language)) {
      throw new Error("audio.transcribe language must be an ISO language tag");
    }
    const host = this.panelAudioHost(binding);
    const result = await host.transcribe({
      cwd: binding.context.cwd!,
      audio: new Uint8Array(input.audio),
      mimeType,
      ...(language ? { language } : {}),
    });
    if (!result.ok) return result;
    const text = result.text.trim();
    if (!text) return { ok: false, error: "transcription returned no text" };
    if (text.length > MAX_TRANSCRIPT_CHARS) {
      return { ok: false, error: "transcription exceeds the 20000 character limit" };
    }
    return { ok: true, text };
  }

  private panelAutomationHost(binding: GuestBinding) {
    const host = this.options.automations;
    if (!host) throw new Error("Panel App automation host is unavailable");
    if (!binding.context.cwd || !binding.context.sessionId) {
      throw new Error("Panel App automations require a bound project and task");
    }
    if (!binding.context.trusted) {
      throw new Error("Panel App automations require a trusted workspace");
    }
    return host;
  }

  private isPanelAutomationInScope(
    binding: GuestBinding,
    automation: { cwd: string | null; resumeSessionId: string | null },
  ): boolean {
    return Boolean(
      binding.context.cwd &&
      binding.context.sessionId &&
      automation.cwd &&
      resolve(automation.cwd) === resolve(binding.context.cwd) &&
      automation.resumeSessionId === binding.context.sessionId,
    );
  }

  private automationId(params: unknown): string {
    const id = (params as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || !id.trim() || id.length > 128) {
      throw new Error("Panel App automation id is invalid");
    }
    return id.trim();
  }

  private async listPanelAutomations(binding: GuestBinding): Promise<unknown> {
    const host = this.panelAutomationHost(binding);
    const jobs = await host.list();
    return {
      automations: jobs.filter((job) => this.isPanelAutomationInScope(binding, job)),
    };
  }

  private async requireScopedPanelAutomation(binding: GuestBinding, id: string) {
    const host = this.panelAutomationHost(binding);
    const automation = (await host.list()).find((job) => job.id === id);
    if (!automation || !this.isPanelAutomationInScope(binding, automation)) {
      throw new Error("Panel App automation is not available in this project task");
    }
    return { host, automation };
  }

  private async createPanelAutomation(binding: GuestBinding, params: unknown): Promise<unknown> {
    const host = this.panelAutomationHost(binding);
    const input = params as {
      name?: unknown;
      schedule?: unknown;
      prompt?: unknown;
      timezone?: unknown;
    } | null;
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    const schedule = typeof input?.schedule === "string" ? input.schedule.trim() : "";
    const prompt = typeof input?.prompt === "string" ? input.prompt.trim() : "";
    const timezone = typeof input?.timezone === "string" ? input.timezone.trim() : undefined;
    if (!name || name.length > 120 || !schedule || schedule.length > 128) {
      throw new Error("Panel App automation requires a valid name and schedule");
    }
    if (!prompt || prompt.length > MAX_AGENT_PROMPT_CHARS) {
      throw new Error("Panel App automation prompt must be between 1 and 20000 characters");
    }
    if (timezone !== undefined && (!timezone || timezone.length > 120)) {
      throw new Error("Panel App automation timezone is invalid");
    }
    return host.create({
      name,
      schedule,
      prompt,
      cwd: binding.context.cwd!,
      ...(timezone ? { timezone } : {}),
      permissionLevel: "full",
      resumeSessionId: binding.context.sessionId!,
    });
  }

  private async updatePanelAutomation(binding: GuestBinding, params: unknown): Promise<unknown> {
    const id = this.automationId(params);
    const { host } = await this.requireScopedPanelAutomation(binding, id);
    const input = params as {
      name?: unknown;
      schedule?: unknown;
      prompt?: unknown;
      timezone?: unknown;
    };
    const patch: { name?: string; schedule?: string; prompt?: string; timezone?: string } = {};
    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 120) {
        throw new Error("Panel App automation name is invalid");
      }
      patch.name = input.name.trim();
    }
    if (input.schedule !== undefined) {
      if (
        typeof input.schedule !== "string" ||
        !input.schedule.trim() ||
        input.schedule.length > 128
      ) {
        throw new Error("Panel App automation schedule is invalid");
      }
      patch.schedule = input.schedule.trim();
    }
    if (input.prompt !== undefined) {
      if (
        typeof input.prompt !== "string" ||
        !input.prompt.trim() ||
        input.prompt.length > MAX_AGENT_PROMPT_CHARS
      ) {
        throw new Error("Panel App automation prompt is invalid");
      }
      patch.prompt = input.prompt.trim();
    }
    if (input.timezone !== undefined) {
      if (
        typeof input.timezone !== "string" ||
        !input.timezone.trim() ||
        input.timezone.length > 120
      ) {
        throw new Error("Panel App automation timezone is invalid");
      }
      patch.timezone = input.timezone.trim();
    }
    if (!Object.keys(patch).length) throw new Error("Panel App automation update is empty");
    return host.update(id, patch);
  }

  private async controlPanelAutomation(
    binding: GuestBinding,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.automationId(params);
    const { host } = await this.requireScopedPanelAutomation(binding, id);
    if (method === "automations.pause") return { ok: await host.pause(id) };
    if (method === "automations.resume") return { ok: await host.resume(id) };
    if (method === "automations.delete") return { ok: await host.delete(id) };
    if (method === "automations.runNow") return { ok: await host.runNow(id) };
    throw new Error("Unknown Panel App automation action");
  }

  private cookieCredentialUrl(params: unknown): URL {
    const rawUrl = (params as { url?: unknown } | null)?.url;
    let url: URL;
    try {
      url = new URL(typeof rawUrl === "string" ? rawUrl : "");
    } catch {
      throw new Error("Cookie login requires a valid https URL");
    }
    if (
      typeof rawUrl !== "string" ||
      rawUrl.length > 2_048 ||
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      throw new Error("Cookie login requires a valid https URL");
    }
    return url;
  }

  /**
   * Match a login URL against a saved credential's domain, one direction only:
   * the requested host must BE the credential domain or sit beneath it.
   *
   * The reverse test (credential domain ends with the requested host) must not
   * be reintroduced — it let a short host claim every longer credential, so
   * `https://com` matched `evil.com` and `zhipin.com` matched
   * `mail.zhipin.com`. Since only `credential.label` (often a phone number or
   * email) crosses back to the guest, a bad match silently leaks accounts.
   *
   * Requiring a dot in the credential domain keeps a bare eTLD entry (`com`,
   * `cn`) from matching an entire suffix.
   */
  private cookieCredentialDomainMatches(url: URL, credential: PanelAppCookieCredential): boolean {
    const target = url.hostname.toLowerCase().replace(/^www\./, "");
    const domain = String(credential.domain || "")
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split(":")[0];
    if (!domain || !domain.includes(".") || !target) return false;
    return target === domain || target.endsWith(`.${domain}`);
  }

  /**
   * Reading real credentials is at least as sensitive as writing workspace
   * files, so it takes the same trust gate those paths use
   * (`trustedWorkspaceRoot`) rather than only checking that a cwd is bound.
   */
  private cookieCredentialHost(binding: GuestBinding) {
    const host = this.options.cookieCredentials;
    if (!host) throw new Error("Cookie login is unavailable in this CodeShell host");
    if (!binding.cwd) throw new Error("Cookie login requires an active project-bound task");
    if (!this.options.isWorkspaceTrusted(binding.cwd)) {
      throw new Error("Cookie login requires a trusted workspace");
    }
    return host;
  }

  private async listCookieCredentials(
    binding: GuestBinding,
    params: unknown,
  ): Promise<{ accounts: PanelAppCookieCredential[] }> {
    const url = this.cookieCredentialUrl(params);
    const host = this.cookieCredentialHost(binding);
    const accounts = (await host.list(binding.cwd)).filter((credential) =>
      this.cookieCredentialDomainMatches(url, credential),
    );
    return { accounts };
  }

  private async loginAndSaveCookieCredential(
    binding: GuestBinding,
    params: unknown,
  ): Promise<unknown> {
    const input = params as {
      providerId?: unknown;
      providerLabel?: unknown;
      url?: unknown;
    } | null;
    const providerId = typeof input?.providerId === "string" ? input.providerId.trim() : "";
    const providerLabel =
      typeof input?.providerLabel === "string" ? input.providerLabel.trim() : "";
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(providerId)) {
      throw new Error("Cookie login requires a valid provider id");
    }
    if (!providerLabel || providerLabel.length > 80) {
      throw new Error("Cookie login requires a provider label up to 80 characters");
    }
    const url = this.cookieCredentialUrl(params);
    const host = this.cookieCredentialHost(binding);
    return host.loginAndSave({
      appId: binding.resource.descriptor.appId,
      providerId,
      providerLabel,
      url: url.toString(),
      cwd: binding.cwd,
      bucket: binding.bucket,
    });
  }

  private async restoreCookieCredential(binding: GuestBinding, params: unknown): Promise<unknown> {
    const input = params as { credentialId?: unknown; providerLabel?: unknown } | null;
    const credentialId = typeof input?.credentialId === "string" ? input.credentialId.trim() : "";
    const providerLabel =
      typeof input?.providerLabel === "string" ? input.providerLabel.trim() : "招聘渠道";
    if (!credentialId || credentialId.length > 160) {
      throw new Error("Cookie restore requires a saved credential id");
    }
    const host = this.cookieCredentialHost(binding);
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    const decision = await dialog.showMessageBox(owner, {
      type: "question",
      buttons: ["Restore login", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      title: binding.resource.descriptor.title,
      message: `Restore the saved login for ${providerLabel || "this channel"}?`,
      detail:
        "CodeShell will inject the selected Cookie credential into this task's browser. The Panel App cannot read the Cookie value.",
      noLink: true,
    });
    if (decision.response !== 0) return { restored: false, cancelled: true };
    const result = await host.restore({
      credentialId,
      cwd: binding.cwd,
      bucket: binding.bucket,
    });
    return { restored: true, count: result.count };
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
    return this.writeWorkspaceFile(
      binding,
      relativePath,
      Buffer.from(content, "utf-8"),
      expectedModifiedAt,
      expectedRevision,
      MAX_WORKSPACE_READ_BYTES,
    );
  }

  private async workspaceExportPdf(binding: GuestBinding, params: unknown): Promise<unknown> {
    const relativePath = this.workspaceRelativePath(params);
    if (extname(relativePath).toLowerCase() !== ".pdf") {
      throw new Error("workspace.exportPdf requires a .pdf path");
    }
    const expectedModifiedAt = (params as { expectedModifiedAt?: unknown } | null)
      ?.expectedModifiedAt;
    const expectedRevision = (params as { expectedRevision?: unknown } | null)?.expectedRevision;
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
        "workspace.exportPdf requires expectedModifiedAt or expectedRevision to prevent blind overwrites",
      );
    }
    if (binding.guest.isDestroyed()) throw new Error("Panel App is no longer available");
    const pdf = await binding.guest.printToPDF({
      pageSize: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      generateTaggedPDF: true,
      generateDocumentOutline: true,
    });
    if (
      pdf.length < 8 ||
      pdf.length > MAX_WORKSPACE_PDF_BYTES ||
      pdf.subarray(0, 5).toString("ascii") !== "%PDF-"
    ) {
      throw new Error(`exported PDF must be between 8 and ${MAX_WORKSPACE_PDF_BYTES} bytes`);
    }
    return this.writeWorkspaceFile(
      binding,
      relativePath,
      pdf,
      expectedModifiedAt,
      expectedRevision,
      MAX_WORKSPACE_PDF_BYTES,
    );
  }

  private async writeWorkspaceFile(
    binding: GuestBinding,
    relativePath: string,
    content: Uint8Array,
    expectedModifiedAt: number | null | undefined,
    expectedRevision: string | undefined,
    maxExistingBytes: number,
  ): Promise<unknown> {
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
              (await this.readBoundedWorkspaceFile(handle, maxExistingBytes)).buffer,
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
        await writeFile(temporary, content, { mode: 0o600 });
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
