/**
 * Shared shapes for the Panel App bridge: the per-guest binding record, the
 * Host options Main injects, and the explicit internals the extracted
 * `panel-app-bridge-*` handler modules receive instead of reaching into the
 * class. Types only; behavior lives in panel-app-bridge.ts and its siblings.
 */
import type { WebContents } from "electron";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { Credential, InstalledPanelApp } from "@cjhyy/code-shell-core";
import type {
  PanelAutomationHost,
  PanelProjectScopeBinding,
  PanelResourceService,
  PanelTaskCookieHost,
  PanelToolJobService,
  ToolJobScope,
} from "@cjhyy/code-shell-server/panels";
import type { AgentBridge } from "./agent-bridge.js";
import type { ExternalRuntimeService } from "./external-runtime-service.js";
import type { PanelAppProtocolResource } from "./panel-app-protocol.js";
import type { PanelMediaService } from "./media/panel-media-service.js";
import type { PanelAppProcessService, PanelProcessOwner } from "./panel-app-process-service.js";
import type { PanelAgentTaskModelCatalog } from "./panel-app-agent-task-models.js";
import type {
  PanelAppBindInput,
  PanelAppCookieCredential,
  PanelAppDescriptor,
  PanelAppHostContext,
} from "../shared/panel-apps.js";

export interface GuestBinding {
  guest: WebContents;
  ownerWindowId: number;
  tabId?: string;
  lastBindInput?: PanelAppBindInput;
  /** Standalone views inherit authority from one immutable, trusted dock binding. */
  windowSourceGuestId?: number;
  windowSourceIdentity?: string;
  logicalOwnerWebContentsId?: number;
  resource: PanelAppProtocolResource;
  context: PanelAppHostContext;
  callTimes: number[];
  recordingWriteTimes: number[];
  notifyTimes: number[];
  bucket?: string;
  /** Project selected during prepare; immutable for this guest. */
  projectPath: string;
  projectScope?: PanelProjectScopeBinding;
  projectScopeRevoked?: boolean;
  bindGeneration?: number;
  bindController?: AbortController;
  /** A guest can keep project access, but must never retarget a session action. */
  sensitiveSessionId?: string;
  sensitiveSessionRevoked?: boolean;
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
  /** Trusted renderer→main execution routing; never exposed to the Panel guest. */
  execution: {
    /**
     * The project path the chat renderer routes its own runs by. External
     * runtimes key session reuse on cwd, so a Panel submission must present
     * the same value as a chat send or the two paths restart each other.
     */
    cwd: string;
    modelKey?: string;
    permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "dontAsk";
    planMode: boolean;
    hasGoal: boolean;
  };
}

export interface PanelAppWindowSource {
  guestId: number;
  ownerWindowId: number;
  descriptor: PanelAppDescriptor;
  bindInput: PanelAppBindInput;
}

export interface PendingAgentToolCall {
  guestId: number;
  releaseExecution(): void;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface PanelAppBridgeOptions {
  isTrustedHost(sender: WebContents): boolean;
  isWorkspaceTrusted(cwd: string): boolean;
  /** Rechecked on prepare, bind, Agent invocation, and every Host call. */
  isPanelAppBound(projectPath: string, appId: string): boolean;
  /** Main's project registry: `rootPath` is a registered root of the project at `projectPath`. */
  isProjectRoot?(projectPath: string, rootPath: string): boolean;
  /** Shared with paired Web; IDs are resolved by Main, never accepted from a guest. */
  resolveProjectScope?(
    projectPath: string,
    cwd: string,
  ): Promise<PanelProjectScopeBinding | undefined>;
  /** Verified application-owned Node; services never select a user PATH runtime. */
  resolveBackgroundServiceNode?(): Promise<string | null>;
  getAgentBridge(): AgentBridge | null;
  getExternalRuntimeService?(): ExternalRuntimeService | null;
  /** Canonical transcript handoff used only when a fresh external thread starts. */
  externalRuntimeInitialContext?(sessionId: string): Promise<string | undefined>;
  /** Secret-free configured text connections available to isolated Panel Tasks. */
  agentTaskModels?(cwd: string): PanelAgentTaskModelCatalog | Promise<PanelAgentTaskModelCatalog>;
  /** Shows a system notification; injected so tests avoid Electron Notification. */
  showNotification?(notification: { title: string; body: string }): boolean;
  /** Host-owned Cookie login operations. Cookie values never cross into the Panel guest. */
  cookieCredentials?: {
    /** Host-only vault access for versioned background task credentials. */
    taskCredentials?(cwd: string): Promise<Credential[]>;
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
    }): Promise<{ count: number } | { invalid: true }>;
    materialize?(input: {
      credentialId: string;
      cwd?: string;
    }): Promise<{ filePath: string; count: number; cleanup: () => void } | { invalid: true }>;
  };
  /** Project- and task-scoped recurring jobs. The Panel never receives jobs from another cwd. */
  automations?: {
    /** True only when create persists creationKey atomically with the job. */
    uniqueCreation?: boolean;
    /** Shared project Host for transactionally checked mutations. */
    conditional?: PanelAutomationHost;
    list(scope: { resumeSessionId: string }): Promise<
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
    create(
      input: {
        name: string;
        schedule: string;
        prompt: string;
        timezone?: string;
        permissionLevel: "full";
        creationKey?: string;
      },
      scope: { resumeSessionId: string },
    ): Promise<unknown>;
    update(
      id: string,
      patch: {
        name?: string;
        schedule?: string;
        prompt?: string;
        timezone?: string;
      },
      scope: { resumeSessionId: string },
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
    resourceTransferTimeoutMs: number;
    storageQuotaBytes: number;
    maxNotificationsPerWindow: number;
  }>;
}

/**
 * The bridge state and guards that extracted handler modules may use. Main
 * builds this from the live `PanelAppBridge` per call, so each member still
 * resolves the bridge's current method (tests may replace one) and every
 * authorization check runs exactly where it did before the split.
 */
export interface PanelAppBridgeInternals {
  readonly options: PanelAppBridgeOptions;
  readonly guests: ReadonlyMap<number, GuestBinding>;
  readonly processService: PanelAppProcessService;
  isResourceTransfersStopping(): boolean;
  requirePermission(binding: GuestBinding, permission: string): void;
  assertProjectBinding(binding: GuestBinding): void;
  trustedWorkspaceRoot(binding: GuestBinding): Promise<string>;
  isWithinWorkspace(root: string, candidate: string, allowRoot?: boolean): boolean;
  readBoundedWorkspaceFile(
    handle: FileHandle,
    maxBytes?: number,
  ): Promise<{ buffer: Buffer; metadata: Stats }>;
  writeWorkspaceFile(
    binding: GuestBinding,
    relativePath: string,
    content: Uint8Array,
    expectedModifiedAt: number | null | undefined,
    expectedRevision: string | undefined,
    maxExistingBytes: number,
  ): Promise<unknown>;
  processOwner(binding: GuestBinding): PanelProcessOwner;
  getTaskCookieHost(): PanelTaskCookieHost;
  confirmTaskCookie(
    binding: GuestBinding,
    input: unknown,
    entry: string,
    background?: boolean,
  ): Promise<void>;
  getResourceService(): PanelResourceService;
  getMediaService(): PanelMediaService;
  getToolJobService(): PanelToolJobService;
  installedToolApp(scope: ToolJobScope): Promise<InstalledPanelApp>;
  readonly pendingAgentToolCalls: Map<string, PendingAgentToolCall>;
  findAgentToolBinding(
    appDescriptorId: string,
    bucket: string,
    ownerWindowId: number,
  ): GuestBinding | undefined;
}
