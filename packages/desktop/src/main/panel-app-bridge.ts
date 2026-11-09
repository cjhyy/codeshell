import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from "electron";
import {
  type InstalledPanelApp,
  resolvePanelAppBindingProjectPath,
  sessionsRoot,
} from "@cjhyy/code-shell-core";
import { acquireLockOnPath, acquireWorkspaceWriteLock } from "@cjhyy/code-shell-core/internal";
import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  linkSync,
  lstatSync,
  realpathSync,
  renameSync,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  stat,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { claimPanelHostOwnerForRun } from "./panel-host-routing.js";
import { parseExternalRuntimeModelKey } from "../shared/external-runtime-models.js";
import type { PanelAppProtocolResource } from "./panel-app-protocol.js";
import {
  preparePanelApp,
  setPanelAppMediaReader,
  setPanelAppResourceAuthorizer,
  setPanelAppCaptureAuthorizer,
  revokePanelAppMediaReads,
} from "./panel-app-protocol.js";
import {
  panelExecutionGate,
  panelExecutionProject,
  type PanelExecutionScope,
  PanelModelTraceService,
  PanelToolJobService,
  PanelBackgroundService,
  backgroundServiceLimits,
  type BackgroundServiceScope,
  PanelTaskCookieHost,
  taskCookieFromInput,
  createSharedPanelToolHost,
  createPanelDirectoryProjectScope,
  desktopPanelDirectoryBookmarks,
  type SharedPanelToolHost,
  createPanelToolExecutor,
  toolJobLimits,
  type ToolJobScope,
  PanelResourceService,
  panelConnections,
  PanelBridgeError,
  panelBridgeFailure,
  panelAutomationCreationKey,
} from "@cjhyy/code-shell-server/panels";
import { installedPanelAppRevision } from "./panel-apps-service.js";
import type { PanelAppInspectionCache } from "./panel-app-inspection-cache.js";
import {
  isPanelAppDescriptorSelected,
  projectPanelAppInspectionCache,
} from "./panel-app-project-packages.js";
import { desktopPanelCapabilities } from "./panel-app-capabilities.js";
import { PanelMediaService } from "./media/panel-media-service.js";
import {
  PanelAppProcessService,
  panelExecutableDirectories,
  panelProcessInfo,
  type PanelProcessOwner,
} from "./panel-app-process-service.js";
import {
  DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES,
  panelAppStorageKey,
  panelAppStorageSnapshot,
  panelAppStorageChange,
  applyPanelAppStorageChange,
  panelAppStorageQuotaBytes,
  preparePanelAppStorage,
  readPanelAppStorage,
  writePanelAppStorage,
} from "./panel-app-storage-store.js";
import {
  PanelAppAgentTaskService,
  type PanelAgentTaskOwner,
  type PanelAgentTaskStartInput,
} from "./panel-app-agent-task-service.js";
import { PanelAgentTaskOwnership } from "./panel-app-agent-task-ownership.js";
import {
  PANEL_APP_API_VERSION,
  type PanelAppBindInput,
  type PanelAppHostContext,
  type PanelAppAgentToolInvocation,
  type PanelAppPermission,
  type PanelAppWindowTarget,
} from "../shared/panel-apps.js";
import type {
  GuestBinding,
  PanelAppBridgeInternals,
  PanelAppBridgeOptions,
  PanelAppWindowSource,
  PendingAgentToolCall,
} from "./panel-app-bridge-types.js";
import {
  CALL_TIMEOUT_MS,
  COOKIE_LOGIN_TIMEOUT_MS,
  AUDIO_TRANSCRIBE_TIMEOUT_MS,
  MAX_AGENT_PROMPT_CHARS,
  MAX_CALLS_PER_WINDOW,
  MAX_PARAMS_BYTES,
  MAX_RESULT_BYTES,
  MAX_WORKSPACE_LIST_RESULT_BYTES,
  MAX_WORKSPACE_READ_BYTES,
  MAX_WORKSPACE_WRITE_BYTES,
  PANEL_AGENT_RUN_TIMEOUT_MS,
  PANEL_GUEST_SCOPE_WAIT_MS,
  PDF_EXPORT_TIMEOUT_MS,
  PROCESS_CONSENT_TIMEOUT_MS,
  RATE_WINDOW_MS,
  RESOURCE_TRANSFER_METHODS,
  RESOURCE_TRANSFER_TIMEOUT_MS,
  jsonBytes,
  withTimeout,
  workspaceRevision,
} from "./panel-app-bridge-support.js";
import { createPanelAgentTaskRuntime } from "./panel-app-bridge-agent-tasks.js";
import {
  panelWorkspaceExportPdf,
  panelWorkspaceInfo,
  panelWorkspaceList,
  panelWorkspaceOpenPath,
  panelWorkspaceReadText,
  panelWorkspaceRevealPath,
  panelWorkspaceWriteText,
} from "./panel-app-bridge-workspace.js";
import {
  cookieCredentialUrl,
  panelAuthorizeConnections,
  panelAuthorizeCookieCredentialForProcess,
  panelListCookieCredentials,
  panelLoginAndSaveCookieCredential,
  panelRestoreCookieCredential,
} from "./panel-app-bridge-credentials.js";
import {
  panelAudioStatus,
  panelOpenExternal,
  panelRequestMicrophoneAccess,
  panelSendNotification,
  panelTranscribeAudio,
} from "./panel-app-bridge-system.js";
import { panelDispatchMedia, panelPickResourceReferences } from "./panel-app-bridge-media.js";
import { panelDispatchToolJobs, panelToolJobSummary } from "./panel-app-bridge-tool-jobs.js";
import {
  panelHandleAgentToolResponse,
  panelInvokeAgentTool,
} from "./panel-app-bridge-agent-tools.js";

export type { PanelAppBridgeOptions, PanelAppWindowSource } from "./panel-app-bridge-types.js";

export class PanelAppBridge {
  private readonly guests = new Map<number, GuestBinding>();
  private readonly windowSourceListeners = new Map<
    number,
    Set<{ onChanged(): void; onRevoked(): void }>
  >();
  private readonly storageQueues = new Map<string, Promise<void>>();
  private readonly workspaceWriteQueues = new Map<string, Promise<void>>();
  private readonly pendingAgentToolCalls = new Map<string, PendingAgentToolCall>();
  private readonly processService: PanelAppProcessService;
  private readonly modelTraces = new PanelModelTraceService({
    storageDir: join(sessionsRoot(), ".model-traces"),
  });
  private readonly directoryBookmarks = desktopPanelDirectoryBookmarks(app.getPath("userData"));
  private readonly agentTaskService: PanelAppAgentTaskService;
  private readonly agentTaskOwnership: PanelAgentTaskOwnership;
  private mediaService?: PanelMediaService;
  private resourceService?: PanelResourceService;
  private resourceTransfersStopping = false;
  private readonly resourceTransfers = new Map<
    AbortController,
    { guestId: number; settled: Promise<void> }
  >();
  private toolJobService?: PanelToolJobService;
  private backgroundService?: PanelBackgroundService;
  private unsubscribeBackgroundAvailability?: () => void;
  private backgroundInitializationError?: string;
  private taskCookieHost?: PanelTaskCookieHost;
  private nextToolOwner = -1;
  private readonly toolOwners = new Map<
    number,
    { scope: ToolJobScope; appTitle: string; taskId: string }
  >();

  constructor(private readonly options: PanelAppBridgeOptions) {
    setPanelAppResourceAuthorizer((resource, projectPath) =>
      isPanelAppDescriptorSelected(resource.descriptor, projectPath),
    );
    setPanelAppCaptureAuthorizer(
      (scope) =>
        options.isPanelAppBound(scope.projectPath, scope.appId) &&
        options.isWorkspaceTrusted(scope.projectPath),
    );
    setPanelAppMediaReader(async (scope, id, request) => {
      if (
        !options.isPanelAppBound(scope.projectPath, scope.appId) ||
        !options.isWorkspaceTrusted(scope.projectPath)
      )
        throw new Error("Media scope is no longer authorized");
      return this.getResourceService().openRead(scope, id, request);
    });
    this.processService = new PanelAppProcessService({
      modelTraces: this.modelTraces,
      modelTraceOwner: (owner) => {
        const task = this.toolOwners.get(owner.guestId);
        if (task)
          return {
            appId: owner.appId,
            revision: owner.revision,
            workspacePath: task.scope.projectPath,
            traceId: task.taskId,
            taskId: task.taskId,
          };
        const binding = this.guests.get(owner.guestId);
        if (!binding || binding.resource.descriptor.revision !== owner.revision) return undefined;
        this.assertLiveProjectBinding(binding);
        return {
          appId: owner.appId,
          revision: owner.revision,
          workspacePath: binding.cwd ?? binding.projectPath,
          sessionId: binding.context.sessionId,
        };
      },
      acquireExecution: (owner) => {
        const projectPath =
          this.toolOwners.get(owner.guestId)?.scope.projectPath ??
          this.guests.get(owner.guestId)?.projectPath;
        if (!projectPath)
          throw new PanelBridgeError("REVOKED", "Panel execution owner is unavailable");
        // A native task's process has no Panel instance; a guest's process names its guest.
        return panelExecutionGate.enter({
          appId: owner.appId,
          projectPath,
          holder: this.guests.has(owner.guestId)
            ? { kind: "process", guestId: owner.guestId }
            : { kind: "process" },
        });
      },
      allowAuthorizedProcessWithoutPrompt: true,
      isOwnerAuthorized: async (owner) => {
        const task = this.toolOwners.get(owner.guestId);
        if (task) return !!(await this.installedToolApp(task.scope).catch(() => null));
        const binding = this.guests.get(owner.guestId);
        return (
          !!binding &&
          !binding.guest.isDestroyed() &&
          binding.resource.descriptor.appId === owner.appId &&
          binding.resource.descriptor.revision === owner.revision &&
          this.options.isPanelAppBound(binding.projectPath, owner.appId) &&
          isPanelAppDescriptorSelected(binding.resource.descriptor, binding.projectPath) &&
          this.options.isWorkspaceTrusted(binding.cwd ?? binding.projectPath)
        );
      },
      resolvePackageEntry: async (owner, name) => {
        const task = this.toolOwners.get(owner.guestId);
        if (task) {
          const installed = await this.installedToolApp(task.scope);
          const entry = installed.nativeEntries?.[name];
          if (!entry)
            throw new PanelBridgeError("NOT_SUPPORTED", "Installed tool entry is missing");
          return { path: join(installed.installPath, entry.entry), sha256: entry.sha256 };
        }
        const binding = this.guests.get(owner.guestId);
        const entry = binding?.resource.descriptor.nativeEntries?.[name];
        if (!binding || !entry || binding.resource.descriptor.revision !== owner.revision)
          throw new PanelBridgeError("REVOKED", "Installed tool entry is unavailable");
        return { path: join(binding.resource.root, entry.entry), sha256: entry.sha256 };
      },
      extraPathDirectories: () =>
        panelExecutableDirectories(this.managedBinDirectory(), { home: app.getPath("home") }),
      // Desktop installation, declared process permission and trusted project binding
      // already authorize Panel execution. ProcessService still enforces handles,
      // package entry hashes, safe arguments and revocation before every spawn.
      confirmExecution: async () => true,
    });
    this.agentTaskOwnership = new PanelAgentTaskOwnership({
      activeOwner: (sessionId) => this.agentTaskService.activeOwner(sessionId),
      currentBridge: () => this.options.getAgentBridge(),
      isPanelAppBound: (projectPath, appId) => this.options.isPanelAppBound(projectPath, appId),
      isWorkspaceTrusted: (cwd) => this.options.isWorkspaceTrusted(cwd),
    });
    this.agentTaskService = new PanelAppAgentTaskService(
      createPanelAgentTaskRuntime({
        getAgentBridge: () => this.options.getAgentBridge(),
        trackOwnership: (sessionId, bridge) => this.agentTaskOwnership.track(sessionId, bridge),
      }),
      (owner, task) => {
        for (const binding of this.guests.values()) {
          if (
            binding.guest.isDestroyed() ||
            binding.resource.descriptor.appId !== owner.appId ||
            binding.projectPath !== owner.projectPath
          ) {
            continue;
          }
          binding.guest.send("panel-app:event", {
            event: "agent.task.changed",
            payload: task,
          });
        }
      },
    );
  }

  /** Main-only signing authority for an executing Panel task. */
  hasActiveAgentTaskOwner(sessionId: string): boolean {
    return this.agentTaskOwnership.hasActiveOwner(sessionId);
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
      this.call(event.sender, method, params).catch(panelBridgeFailure),
    );
  }

  /** Restore durable media work after Host trust has been loaded, independent of guests. */
  async initializeMedia(): Promise<void> {
    const failures: unknown[] = [];
    // Each component retains its original failure, but cannot prevent unrelated
    // recovery. In particular, damaged Cookie state must not suppress services.
    for (const component of [
      () => this.getResourceService(),
      () => this.getToolJobService(),
      () => this.getMediaService(),
      ...(this.options.cookieCredentials?.taskCredentials ? [() => this.getTaskCookieHost()] : []),
    ]) {
      if (this.resourceTransfersStopping) break;
      try {
        await component().initialize();
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.resourceTransfersStopping && process.platform !== "win32") {
      try {
        await this.getBackgroundService().initialize();
        this.backgroundInitializationError = undefined;
      } catch (error) {
        this.backgroundInitializationError = String(error);
        console.warn("Panel background services unavailable:", error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Panel component initialization failed");
  }

  async shutdownMedia(): Promise<void> {
    this.resourceTransfersStopping = true;
    this.refreshBackgroundServiceContexts();
    this.unsubscribeBackgroundAvailability?.();
    this.unsubscribeBackgroundAvailability = undefined;
    for (const guestId of [...this.windowSourceListeners.keys()]) this.revokeWindowSource(guestId);
    for (const binding of this.guests.values()) binding.bindController?.abort();
    revokePanelAppMediaReads();
    for (const controller of this.resourceTransfers.keys()) controller.abort();
    await Promise.all([...this.resourceTransfers.values()].map(({ settled }) => settled));
    const failures: unknown[] = [];
    for (const service of [
      this.backgroundService,
      this.toolJobService,
      this.taskCookieHost,
      this.mediaService,
      this.resourceService,
    ]) {
      try {
        await service?.shutdown();
      } catch (error) {
        failures.push(error);
      }
    }
    this.modelTraces.closeAll();
    if (failures.length) throw new AggregateError(failures, "Panel shutdown incomplete");
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
      recordingWriteTimes: [],
      notifyTimes: [],
      projectPath,
      execution: {
        cwd: projectPath,
        permissionMode: "default",
        planMode: false,
        hasGoal: false,
      },
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
    this.modelTraces.cancelOwner(`guest:${guestId}`);
    this.guests.get(guestId)?.bindController?.abort();
    for (const [controller, transfer] of this.resourceTransfers)
      if (transfer.guestId === guestId) controller.abort();
    this.backgroundService?.detachGuest(guestId);
    this.processService.revokeGuest(guestId);
    this.guests.delete(guestId);
    this.revokeWindowSource(guestId);
    for (const [requestId, pending] of this.pendingAgentToolCalls) {
      if (pending.guestId !== guestId) continue;
      clearTimeout(pending.timer);
      this.pendingAgentToolCalls.delete(requestId);
      pending.releaseExecution();
      pending.reject(new Error("Panel App closed before its Agent tool completed"));
    }
  }

  /** Where a Panel instance lives, so a refused change can name it. Trusted main data. */
  describeGuest(
    guestId: number,
  ): { tabId?: string; bucket?: string; sessionId?: string } | undefined {
    const binding = this.guests.get(guestId);
    if (!binding) return undefined;
    const sessionId = binding.lastBindInput?.sessionId;
    return {
      ...(binding.tabId ? { tabId: binding.tabId } : {}),
      ...(binding.bucket ? { bucket: binding.bucket } : {}),
      ...(typeof sessionId === "string" && sessionId ? { sessionId } : {}),
    };
  }

  /**
   * Before a reviewed package change: close every instance of this app in the projects the
   * change affects (idle ones too, or their polling re-enters the gate) and stop their Host
   * work. Open tabs reload into the new package once the update changes their revision.
   */
  async closeForPackageChange(
    appId: string,
    matches: (scope: PanelExecutionScope) => boolean,
  ): Promise<void> {
    const projects = new Set(
      panelExecutionGate.blockers(matches).map((blocker) => blocker.projectPath),
    );
    for (const [guestId, binding] of this.guests) {
      if (binding.resource.descriptor.appId !== appId) continue;
      const projectPath = panelExecutionProject(binding.projectPath);
      if (!matches({ appId, projectPath })) continue;
      projects.add(projectPath);
      this.revokeGuest(guestId);
      if (!binding.guest.isDestroyed()) binding.guest.stop();
    }
    await this.backgroundService?.drain(matches);
    this.agentTaskService.cancelApp(appId, projects);
    await Promise.all(
      [...projects].map((project) =>
        this.toolJobService?.cancelApp(appId, project).catch(() => {}),
      ),
    );
  }

  revokeAppId(appId: string): void {
    void this.backgroundService?.revoke(appId).catch(() => {});
    revokePanelAppMediaReads(appId);
    this.agentTaskService.cancelApp(appId);
    void this.mediaService?.cancelApp(appId).catch(() => {});
    void this.toolJobService?.cancelApp(appId).catch(() => {});
    void this.resourceService?.cancelApp(appId).catch(() => {});
    for (const [guestId, binding] of this.guests) {
      if (binding.resource.descriptor.appId !== appId) continue;
      this.revokeGuest(guestId);
      if (!binding.guest.isDestroyed()) binding.guest.stop();
    }
  }

  private assertTrustedHost(sender: WebContents): void {
    if (!this.options.isTrustedHost(sender)) throw new Error("untrusted Panel App host sender");
  }

  /** Resolve only a dock guest already bound by this trusted main window. */
  getWindowSource(sender: WebContents, target: PanelAppWindowTarget): PanelAppWindowSource {
    this.assertTrustedHost(sender);
    if (
      !target ||
      [target.appDescriptorId, target.tabId, target.bucket].some(
        (value) =>
          typeof value !== "string" || !value || value.length > 512 || value.includes("\0"),
      )
    )
      throw new Error("invalid Panel App window target");
    const owner = BrowserWindow.fromWebContents(sender);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    const candidates = [...this.guests.values()].filter(
      (binding) =>
        binding.windowSourceGuestId === undefined &&
        binding.ownerWindowId === owner.id &&
        binding.resource.descriptor.id === target.appDescriptorId &&
        binding.tabId === target.tabId &&
        binding.bucket === target.bucket,
    );
    if (candidates.length !== 1) throw new Error("Panel App window source is unavailable");
    const source = candidates[0]!;
    this.assertWindowSource(source);
    return {
      guestId: source.guest.id,
      ownerWindowId: source.ownerWindowId,
      descriptor: structuredClone(source.resource.descriptor),
      bindInput: { ...source.lastBindInput! },
    };
  }

  /** Main-only binding: the new guest cannot supply its own Session or permissions. */
  async bindWindowGuest(guestId: number, sourceGuestId: number): Promise<boolean> {
    const source = this.guests.get(sourceGuestId);
    if (!source) throw new Error("Panel App window source is unavailable");
    const sourceOwner = this.assertWindowSource(source);
    const binding = this.guests.get(guestId);
    const owner = binding ? BrowserWindow.fromId(binding.ownerWindowId) : null;
    if (
      !binding ||
      binding === source ||
      binding.guest.isDestroyed() ||
      !owner ||
      owner.isDestroyed() ||
      owner.id === sourceOwner.id ||
      binding.resource.descriptor.id !== source.resource.descriptor.id ||
      binding.resource.descriptor.hostId !== source.resource.descriptor.hostId ||
      binding.resource.descriptor.revision !== source.resource.descriptor.revision ||
      binding.projectPath !== source.projectPath ||
      (binding.windowSourceGuestId === undefined && binding.lastBindInput)
    )
      throw new Error("Panel App window guest does not match its source");
    const identity = this.windowSourceIdentity(source);
    if (
      binding.windowSourceGuestId !== undefined &&
      (binding.windowSourceGuestId !== sourceGuestId || binding.windowSourceIdentity !== identity)
    ) {
      this.revokeGuest(guestId);
      throw new Error("Panel App window source changed");
    }
    this.assertProjectBinding(binding);
    binding.windowSourceGuestId = sourceGuestId;
    binding.windowSourceIdentity = identity;
    binding.logicalOwnerWebContentsId = sourceOwner.webContents.id;
    binding.tabId = source.tabId;
    binding.bucket = source.bucket;
    binding.cwd = source.cwd;
    binding.projectScope = source.projectScope;
    binding.sensitiveSessionId = source.sensitiveSessionId;
    binding.sensitiveSessionRevoked = source.sensitiveSessionRevoked;
    binding.execution = { ...source.execution };
    binding.context = {
      ...source.context,
      visible: owner.isVisible() && !owner.isMinimized(),
    };
    binding.lastBindInput = {
      ...source.lastBindInput!,
      guestId,
      visible: binding.context.visible,
    };
    if (binding.guest.getURL())
      binding.guest.send("panel-app:event", { event: "context.changed", payload: binding.context });
    if (binding.resource.descriptor.permissions.includes("agent.task"))
      this.agentTaskService.rebind(this.agentTaskOwner(binding));
    return true;
  }

  subscribeWindowSource(
    sourceGuestId: number,
    onChanged: () => void,
    onRevoked: () => void,
  ): () => void {
    const source = this.guests.get(sourceGuestId);
    if (!source) throw new Error("Panel App window source is unavailable");
    this.assertWindowSource(source);
    const listeners = this.windowSourceListeners.get(sourceGuestId) ?? new Set();
    const listener = { onChanged, onRevoked };
    listeners.add(listener);
    this.windowSourceListeners.set(sourceGuestId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this.windowSourceListeners.get(sourceGuestId) === listeners)
        this.windowSourceListeners.delete(sourceGuestId);
    };
  }

  private windowSourceIdentity(binding: GuestBinding): string {
    return JSON.stringify([
      binding.resource.descriptor.id,
      binding.resource.descriptor.hostId,
      binding.resource.descriptor.revision,
      binding.projectPath,
      binding.cwd,
      binding.tabId,
      binding.bucket,
      binding.lastBindInput?.sessionId || null,
    ]);
  }

  private assertWindowSource(binding: GuestBinding): BrowserWindow {
    if (binding.windowSourceGuestId !== undefined || !binding.lastBindInput)
      throw new Error("Panel App window requires a bound dock source");
    this.assertLiveProjectBinding(binding);
    if (binding.sensitiveSessionRevoked) throw new Error("Panel App window source session changed");
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    this.assertTrustedHost(owner.webContents);
    return owner;
  }

  private revokeWindowSource(sourceGuestId: number): void {
    const listeners = this.windowSourceListeners.get(sourceGuestId);
    this.windowSourceListeners.delete(sourceGuestId);
    for (const binding of [...this.guests.values()]) {
      if (binding.windowSourceGuestId === sourceGuestId) this.revokeGuest(binding.guest.id);
    }
    for (const listener of listeners ?? []) {
      try {
        listener.onRevoked();
      } catch {
        // One closing window must not prevent other derived scopes from being revoked.
      }
    }
  }

  private sessionOwnerWindow(binding: GuestBinding): BrowserWindow | null {
    const source = this.guests.get(binding.windowSourceGuestId ?? binding.guest.id);
    const owner = source ? BrowserWindow.fromId(source.ownerWindowId) : null;
    if (
      !owner ||
      owner.isDestroyed() ||
      (binding.logicalOwnerWebContentsId !== undefined &&
        binding.logicalOwnerWebContentsId !== owner.webContents.id)
    )
      return null;
    return owner;
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
          binding.windowSourceGuestId === undefined &&
          binding.ownerWindowId === ownerWindowId &&
          binding.resource.descriptor.id === appDescriptorId &&
          binding.bucket === bucket,
      )
      .sort((left, right) => Number(right.context.visible) - Number(left.context.visible))[0];
  }

  private invokeAgentTool(sender: WebContents, input: PanelAppAgentToolInvocation) {
    return panelInvokeAgentTool(this.internals(), sender, input);
  }

  private handleAgentToolResponse(sender: WebContents, raw: unknown): void {
    panelHandleAgentToolResponse(this.internals(), sender, raw);
  }

  private async bindGuest(sender: WebContents, input: PanelAppBindInput): Promise<boolean> {
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
    if (this.resourceTransfersStopping) throw new Error("Panel App Host is stopping");
    const binding = this.guests.get(input.guestId);
    const owner = BrowserWindow.fromWebContents(sender);
    if (
      !binding ||
      !owner ||
      binding.ownerWindowId !== owner.id ||
      binding.windowSourceGuestId !== undefined
    ) {
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
    if (
      (input.modelKey != null &&
        (typeof input.modelKey !== "string" ||
          !input.modelKey ||
          input.modelKey.length > 512 ||
          input.modelKey.includes("\0"))) ||
      (input.permissionMode !== undefined &&
        input.permissionMode !== "default" &&
        input.permissionMode !== "acceptEdits" &&
        input.permissionMode !== "bypassPermissions" &&
        input.permissionMode !== "dontAsk")
    ) {
      throw new Error("invalid Panel App execution context");
    }
    const bindingProjectPath = resolvePanelAppBindingProjectPath(input.projectPath);
    if (bindingProjectPath !== binding.projectPath) {
      throw new Error("Panel App project binding does not match its prepared scope");
    }
    // Identity and storage stay with the bound project; a Session on another
    // registered root of that project executes there (Main's registry proves it).
    const workspaceRoot = input.cwd && resolvePanelAppBindingProjectPath(input.cwd);
    if (
      workspaceRoot &&
      workspaceRoot !== binding.projectPath &&
      !this.options.isProjectRoot?.(binding.projectPath, workspaceRoot)
    ) {
      throw new Error("Panel App workspace does not belong to its bound project");
    }
    this.assertProjectBinding(binding);
    // Installed panels are already bound to a verified project. A new chat may
    // not have a session workspace yet, but that must not remove project access.
    const cwd = input.cwd ?? binding.projectPath;
    input = { ...input };
    binding.bindController?.abort();
    const controller = new AbortController();
    binding.bindController = controller;
    const generation = (binding.bindGeneration ?? 0) + 1;
    binding.bindGeneration = generation;
    // Busy/theme/Session updates reuse their frozen proof. Its guard still
    // rereads registry and mount identities; no repeated Git subprocess probe.
    let projectScope = binding.cwd === cwd ? binding.projectScope : undefined;
    if (
      !projectScope &&
      binding.resource.descriptor.permissions.includes("context.workspace") &&
      this.options.resolveProjectScope
    ) {
      let onAbort: (() => void) | undefined;
      try {
        projectScope = await Promise.race([
          this.options.resolveProjectScope(binding.projectPath, cwd),
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(new Error("Panel App binding was superseded or closed"));
            controller.signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
      } finally {
        if (onAbort) controller.signal.removeEventListener("abort", onAbort);
      }
    }
    this.assertTrustedHost(sender);
    if (
      controller.signal.aborted ||
      binding.bindGeneration !== generation ||
      this.guests.get(binding.guest.id) !== binding ||
      binding.guest.isDestroyed() ||
      owner.isDestroyed() ||
      BrowserWindow.fromWebContents(sender) !== owner ||
      this.resourceTransfersStopping
    )
      throw new Error("Panel App binding was superseded or closed");
    this.assertProjectBinding(binding);
    projectScope?.assertCurrent();
    if (
      binding.projectScope &&
      (!projectScope || !isDeepStrictEqual(binding.projectScope.scope, projectScope.scope))
    ) {
      binding.projectScopeRevoked = true;
      this.revokeWindowSource(binding.guest.id);
      throw new Error("Panel project scope changed; reopen the panel");
    }
    const previousIdentity = binding.lastBindInput ? this.windowSourceIdentity(binding) : null;
    binding.projectScope ??= projectScope;
    const sessionId = input.sessionId || undefined;
    if (binding.sensitiveSessionId && binding.sensitiveSessionId !== sessionId)
      binding.sensitiveSessionRevoked = true;
    binding.sensitiveSessionId ??= sessionId;
    binding.bucket = input.bucket;
    binding.tabId = input.tabId;
    if (binding.cwd && (binding.cwd !== cwd || binding.context.sessionId !== sessionId))
      this.modelTraces.cancelOwner(`guest:${binding.guest.id}`);
    binding.cwd = cwd;
    binding.lastBindInput = { ...input };
    binding.execution = {
      cwd: input.projectPath,
      ...(typeof input.modelKey === "string" ? { modelKey: input.modelKey } : {}),
      permissionMode: input.permissionMode ?? "default",
      planMode: input.planMode === true,
      hasGoal: input.hasGoal === true,
    };
    binding.context = {
      appId: binding.resource.descriptor.appId,
      visible: input.visible === true,
      theme: input.theme === "light" || input.theme === "dark" ? input.theme : "system",
      locale: typeof input.locale === "string" ? input.locale.slice(0, 16) : "en",
      apiVersion: PANEL_APP_API_VERSION,
      ...this.capabilitiesFor(binding),
      ...(binding.resource.descriptor.permissions.includes("context.session") && input.sessionId
        ? { sessionId: input.sessionId, busy: input.busy === true }
        : {}),
      ...(binding.resource.descriptor.permissions.includes("context.workspace")
        ? {
            cwd,
            trusted: this.options.isWorkspaceTrusted(cwd),
            ...(binding.projectScope ? { projectScope: { ...binding.projectScope.scope } } : {}),
          }
        : {}),
    };
    if (!binding.guest.isDestroyed()) {
      binding.guest.send("panel-app:event", {
        event: "context.changed",
        payload: binding.context,
      });
    }
    if (binding.resource.descriptor.permissions.includes("agent.task")) {
      this.agentTaskService.rebind(this.agentTaskOwner(binding));
    }
    if (previousIdentity !== null && previousIdentity !== this.windowSourceIdentity(binding)) {
      this.revokeWindowSource(binding.guest.id);
    } else {
      for (const listener of this.windowSourceListeners.get(binding.guest.id) ?? []) {
        try {
          listener.onChanged();
        } catch {
          // A view update cannot invalidate the trusted source binding.
        }
      }
    }
    return true;
  }

  private bindingFor(sender: WebContents): GuestBinding {
    const binding = this.guests.get(sender.id);
    if (!binding || binding.guest !== sender) throw new Error("Panel App scope is not bound");
    return binding;
  }

  private waitForBoundGuest(binding: GuestBinding): Promise<GuestBinding> {
    if (binding.bucket) return Promise.resolve(binding);
    return new Promise((resolveBinding, reject) => {
      const startedAt = Date.now();
      const check = (): void => {
        const current = this.guests.get(binding.guest.id);
        if (current !== binding || binding.guest.isDestroyed()) {
          reject(new Error("Panel App closed before its project scope was bound"));
          return;
        }
        if (binding.bucket) {
          resolveBinding(binding);
          return;
        }
        if (Date.now() - startedAt >= PANEL_GUEST_SCOPE_WAIT_MS) {
          reject(new Error("Panel App project scope binding timed out"));
          return;
        }
        setTimeout(check, 25);
      };
      setTimeout(check, 0);
    });
  }

  private contextFor(sender: WebContents): PanelAppHostContext | Promise<PanelAppHostContext> {
    const binding = this.bindingFor(sender);
    const readContext = (bound: GuestBinding): PanelAppHostContext => {
      this.assertProjectBinding(bound);
      return { ...bound.context, ...this.capabilitiesFor(bound) };
    };
    return binding.bucket
      ? readContext(binding)
      : this.waitForBoundGuest(binding).then(readContext);
  }

  private async call(sender: WebContents, method: string, params?: unknown): Promise<unknown> {
    const binding = await this.waitForBoundGuest(this.bindingFor(sender));
    this.assertProjectBinding(binding);
    if (typeof method !== "string" || method.length > 64) throw new Error("invalid bridge method");
    if (this.resourceTransfersStopping && RESOURCE_TRANSFER_METHODS.has(method))
      throw new PanelBridgeError("REVOKED", "Resource transfers are shutting down");
    const limits = this.options.limits;
    const paramsLimit =
      limits?.maxParamsBytes ??
      (method === "media.document.set" || method === "media.render" || method === "tasks.start"
        ? 2 * 1024 * 1024 + 8 * 1024
        : method.startsWith("modelTraces.")
          ? 256 * 1024
          : method === "services.configure"
            ? backgroundServiceLimits.maxConfigBytes + 4096
            : method === "process.write"
              ? 128 * 1024
              : method === "workspace.writeText"
                ? MAX_WORKSPACE_WRITE_BYTES * 6 + 8 * 1024
                : method === "storage.set" || method === "storage.compareAndSet"
                  ? this.storageQuotaBytes() + 8 * 1024
                  : MAX_PARAMS_BYTES);
    if (
      jsonBytes(params) >
      (method === "services.configure"
        ? Math.min(paramsLimit, backgroundServiceLimits.maxConfigBytes + 4096)
        : paramsLimit)
    ) {
      throw new PanelBridgeError("PARAMS_TOO_LARGE", "Panel App params are too large");
    }
    const now = Date.now();
    // Bounded media transfer chunks share a budget so they cannot starve UI calls.
    const chunk = [
      "media.recording.write",
      "media.assets.read",
      "resources.upload.write",
      "resources.read",
      "process.write",
      "process.get",
    ].includes(method);
    const timestamps = (chunk ? binding.recordingWriteTimes : binding.callTimes).filter(
      (time) => now - time < (limits?.rateWindowMs ?? RATE_WINDOW_MS),
    );
    if (timestamps.length >= (limits?.maxCallsPerWindow ?? (chunk ? 512 : MAX_CALLS_PER_WINDOW)))
      throw new PanelBridgeError(
        "RATE_LIMITED",
        "Panel App rate limit exceeded",
        Math.max(1, (timestamps[0] ?? now) + (limits?.rateWindowMs ?? RATE_WINDOW_MS) - now),
      );
    timestamps.push(now);
    if (chunk) binding.recordingWriteTimes = timestamps;
    else binding.callTimes = timestamps;

    // Whole-file custody can outlast a normal UI RPC. Keep it guest-owned and
    // cancellable so a deadline or revoked guest cannot leave a copy running.
    const transfer = RESOURCE_TRANSFER_METHODS.has(method) ? new AbortController() : undefined;
    const operation = panelExecutionGate.run(
      {
        appId: binding.resource.descriptor.appId,
        projectPath: binding.projectPath,
        holder: { kind: "panel-call", guestId: binding.guest.id },
      },
      () => this.dispatch(binding, method, params, transfer?.signal),
    );
    if (transfer) {
      const settled = operation
        .then(
          () => {},
          () => {},
        )
        .finally(() => this.resourceTransfers.delete(transfer));
      this.resourceTransfers.set(transfer, { guestId: binding.guest.id, settled });
    }
    const result = await withTimeout(
      operation,
      (transfer
        ? (limits?.resourceTransferTimeoutMs ?? RESOURCE_TRANSFER_TIMEOUT_MS)
        : undefined) ??
        limits?.callTimeoutMs ??
        (method === "workspace.exportPdf"
          ? PDF_EXPORT_TIMEOUT_MS
          : method === "audio.transcribe"
            ? AUDIO_TRANSCRIBE_TIMEOUT_MS
            : method === "credentials.cookies.loginAndSave"
              ? COOKIE_LOGIN_TIMEOUT_MS
              : method === "media.recording.finish" ||
                  method === "media.import" ||
                  method === "media.export" ||
                  method === "filesystem.pickDirectory" ||
                  method === "process.spawn" ||
                  method === "tasks.start" ||
                  method === "tasks.retry" ||
                  method === "credentials.connections.authorizeProcess" ||
                  method === "credentials.cookies.authorizeProcess"
                ? PROCESS_CONSENT_TIMEOUT_MS
                : method.startsWith("services.")
                  ? 45_000
                  : CALL_TIMEOUT_MS),
      transfer ? () => transfer.abort() : undefined,
    );
    const resultLimit =
      limits?.maxResultBytes ??
      (method === "tasks.get" ||
      method === "tasks.find" ||
      method === "tasks.start" ||
      method === "tasks.retry" ||
      method === "tasks.cancel"
        ? 5 * 1024 * 1024
        : method === "services.read"
          ? 1024 * 1024 + 4096
          : method === "process.get"
            ? 2 * 1024 * 1024
            : method === "media.document.get"
              ? 2 * 1024 * 1024 + 8 * 1024
              : method === "workspace.readText"
                ? MAX_WORKSPACE_READ_BYTES * 6 + 8 * 1024
                : method === "workspace.list"
                  ? MAX_WORKSPACE_LIST_RESULT_BYTES
                  : method === "storage.getSnapshot" || method === "storage.compareAndSet"
                    ? this.storageQuotaBytes() + 8192
                    : MAX_RESULT_BYTES);
    if (jsonBytes(result) > resultLimit) {
      throw new PanelBridgeError("RESULT_TOO_LARGE", "Panel App result is too large");
    }
    // An operation may await file/process work while its guest or mounted root
    // is revoked. Do not disclose a result from a proof that no longer holds.
    this.assertLiveProjectBinding(binding);
    if (method === "agent.submitPrompt" || method.startsWith("automations."))
      this.assertSessionBinding(binding);
    return result;
  }

  private requirePermission(binding: GuestBinding, permission: string): void {
    if (!binding.resource.descriptor.permissions.includes(permission as never)) {
      throw new PanelBridgeError("PERMISSION_DENIED", `Panel App permission denied: ${permission}`);
    }
  }

  private assertProjectBinding(binding: GuestBinding): void {
    if (binding.projectScopeRevoked)
      throw new Error("Panel project scope was revoked; reopen the panel");
    try {
      binding.projectScope?.assertCurrent();
    } catch (cause) {
      binding.projectScopeRevoked = true;
      throw cause;
    }
    if (
      !this.options.isPanelAppBound(binding.projectPath, binding.resource.descriptor.appId) ||
      !isPanelAppDescriptorSelected(binding.resource.descriptor, binding.projectPath)
    ) {
      throw new Error(
        `Panel App '${binding.resource.descriptor.appId}' is no longer bound to this project`,
      );
    }
  }

  private assertSessionBinding(binding: GuestBinding): void {
    this.assertLiveProjectBinding(binding);
    if (binding.sensitiveSessionRevoked || binding.sensitiveSessionId !== binding.context.sessionId)
      throw new PanelBridgeError("SESSION_CHANGED", "Panel session changed; reopen the panel");
  }

  private assertLiveProjectBinding(binding: GuestBinding): void {
    this.assertProjectBinding(binding);
    if (
      this.guests.get(binding.guest.id) !== binding ||
      binding.guest.isDestroyed() ||
      this.resourceTransfersStopping
    )
      throw new PanelBridgeError("REVOKED", "Panel App scope is no longer bound");
    if (binding.windowSourceGuestId !== undefined) {
      const source = this.guests.get(binding.windowSourceGuestId);
      if (!source || binding.windowSourceIdentity !== this.windowSourceIdentity(source))
        throw new PanelBridgeError("REVOKED", "Panel App window source changed");
      this.assertWindowSource(source);
    }
  }

  private capabilitiesFor(binding: GuestBinding) {
    return desktopPanelCapabilities(binding.resource.descriptor.permissions, {
      resources: this.getResourceService().capabilities(),
      services:
        !this.resourceTransfersStopping &&
        this.backgroundService?.isAvailable() === true &&
        process.platform !== "win32" &&
        !!binding.resource.descriptor.backgroundServices,
      tasks: {
        available: true,
        directoryBookmarks: true,
        queueControl: true,
        ...toolJobLimits,
        ownership: "project",
        executionRevision: binding.resource.descriptor.revision,
        sharedAcrossDevices: true,
        continuesAfterDisconnect: true,
        continuesAfterLogout: true,
      },
      audio: !!this.options.audioTranscription,
      cookies: !!this.options.cookieCredentials,
      taskCookies: !!this.options.cookieCredentials?.taskCredentials,
      automations: !!this.options.automations,
      automationUniqueCreate: this.options.automations?.uniqueCreation === true,
      automationConditionalMutations:
        this.options.automations?.conditional?.conditionalMutations === true,
      mediaMethods: [
        "media.status",
        "media.import",
        "media.export",
        "media.assets.list",
        "media.assets.get",
        "media.assets.read",
        "media.document.get",
        "media.document.set",
        "media.recording.begin",
        "media.recording.write",
        "media.recording.get",
        "media.recording.finish",
        "media.recording.cancel",
        "media.jobs.list",
        "media.jobs.get",
        "media.jobs.cancel",
        "media.jobs.retry",
        "media.jobs.recipe",
        "media.document.versions",
        "media.transcript",
        "media.analysis",
        "media.reveal",
      ],
      limits: this.options.limits,
    });
  }

  private refreshBackgroundServiceContexts(): void {
    // Synchronous validation + delivery cannot cross an asynchronous rebind or
    // package change. Each guest retains its own authorized context and scope.
    for (const binding of this.guests.values()) {
      if (!binding.bucket || binding.guest.isDestroyed()) continue;
      try {
        this.assertProjectBinding(binding);
        if (binding.windowSourceGuestId !== undefined) {
          const source = this.guests.get(binding.windowSourceGuestId);
          if (!source || binding.windowSourceIdentity !== this.windowSourceIdentity(source))
            continue;
          this.assertWindowSource(source);
        }
        const context = { ...binding.context, ...this.capabilitiesFor(binding) };
        if (isDeepStrictEqual(context, binding.context)) continue;
        binding.context = context;
        binding.guest.send("panel-app:event", { event: "context.changed", payload: context });
      } catch {
        // A revoked/destroyed guest must neither receive updates nor prevent
        // another still-authorized project from observing availability.
      }
    }
  }

  private async installedToolApp(scope: ToolJobScope) {
    if (
      !this.options.isPanelAppBound(scope.projectPath, scope.appId) ||
      !this.options.isWorkspaceTrusted(scope.projectPath)
    )
      throw new PanelBridgeError("REVOKED", "Tool task authorization was revoked");
    const installed = await this.projectToolApps(scope.projectPath).get(scope.appId);
    if (
      !installed ||
      installedPanelAppRevision(installed) !== scope.revision ||
      !installed.permissions.includes("process") ||
      !installed.permissions.includes("resources")
    )
      throw new PanelBridgeError("REVOKED", "Installed tool task version or permissions changed");
    return installed;
  }

  private readonly installedToolApps = new Map<string, PanelAppInspectionCache>();
  private projectToolApps(projectPath: string): PanelAppInspectionCache {
    let cache = this.installedToolApps.get(projectPath);
    if (!cache) {
      cache = projectPanelAppInspectionCache(projectPath);
      if (this.installedToolApps.size >= 64)
        this.installedToolApps.delete(this.installedToolApps.keys().next().value!);
      this.installedToolApps.set(projectPath, cache);
    }
    return cache;
  }

  async authorizePanelDirectory(
    expected: InstalledPanelApp,
    projectPath: string,
    workspacePath: string,
  ): Promise<void> {
    if (
      !this.options.isPanelAppBound(projectPath, expected.id) ||
      !this.options.isWorkspaceTrusted(projectPath) ||
      !this.options.isWorkspaceTrusted(workspacePath)
    )
      throw new PanelBridgeError("REVOKED", "Directory project authorization was revoked");
    const installed = await this.projectToolApps(projectPath).get(expected.id);
    if (
      !installed ||
      !isDeepStrictEqual(installed, expected) ||
      !installed.permissions.includes("process")
    )
      throw new PanelBridgeError(
        "REVOKED",
        "Installed directory consumer changed; reopen the Panel",
      );
    if (
      !this.options.isPanelAppBound(projectPath, expected.id) ||
      !this.options.isWorkspaceTrusted(projectPath) ||
      !this.options.isWorkspaceTrusted(workspacePath)
    )
      throw new PanelBridgeError("REVOKED", "Directory project authorization was revoked");
  }

  /** Remote transports share project tasks but cannot shut down their coordinator. */
  sharedToolJobs(): SharedPanelToolHost {
    return createSharedPanelToolHost({
      ...(this.options.cookieCredentials?.taskCredentials
        ? { cookies: this.getTaskCookieHost() }
        : {}),
      service: () => this.getToolJobService(),
      resolveScope: async (expected, projectPath) => {
        const installed = await this.projectToolApps(projectPath).get(expected.id);
        if (!installed || !isDeepStrictEqual(installed, expected))
          throw new PanelBridgeError("REVOKED", "The installed package changed; reopen the Panel");
        const scope = {
          appId: installed.id,
          projectPath,
          revision: installedPanelAppRevision(installed),
        };
        await this.installedToolApp(scope);
        return scope;
      },
    });
  }

  private getTaskCookieHost(): PanelTaskCookieHost {
    const credentials = this.options.cookieCredentials?.taskCredentials;
    if (!credentials)
      throw new PanelBridgeError("NOT_SUPPORTED", "Background Cookie access is unavailable");
    return (this.taskCookieHost ??= new PanelTaskCookieHost({
      rootDirectory: join(app.getPath("userData"), "panel-task-cookies"),
      credentials: (scope) => credentials(scope.projectPath),
      authorize: async (scope) => {
        if (!(await this.installedToolApp(scope)).permissions.includes("credentials.cookies"))
          throw new PanelBridgeError("PERMISSION_DENIED", "Tool requires Cookie permission");
      },
    }));
  }

  /** Settings → Cookie「AI 可自动取用」opts a saved login out of the per-use prompt. */
  private async savedLoginAutoUse(projectPath: string, credentialId: string): Promise<boolean> {
    const credentials = await this.options.cookieCredentials?.taskCredentials?.(projectPath);
    return (
      credentials?.some(
        (credential) =>
          credential.id === credentialId &&
          credential.type === "cookie" &&
          credential.autoUseByAI === true,
      ) ?? false
    );
  }

  private async confirmTaskCookie(
    binding: GuestBinding,
    input: unknown,
    entry: string,
    background = true,
  ) {
    const selection = taskCookieFromInput(input);
    if (!selection) return;
    this.requirePermission(binding, "credentials.cookies");
    const scope = {
      appId: binding.resource.descriptor.appId,
      projectPath: binding.projectPath,
      revision: binding.resource.descriptor.revision,
    };
    const cwd = binding.cwd;
    const host = this.getTaskCookieHost();
    const account = await host.check(scope, selection);
    if (!(await this.savedLoginAutoUse(scope.projectPath, account.id))) {
      const owner = BrowserWindow.fromId(binding.ownerWindowId);
      if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
      const decision = await dialog.showMessageBox(owner, {
        type: "question",
        buttons: ["Use saved login", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        title: binding.resource.descriptor.title,
        message: background
          ? `Use “${account.label}” for this background task?`
          : `Use “${account.label}” with ${entry}?`,
        detail: `Site: ${new URL(selection.url).hostname}\nTool: ${entry}\nProject: ${binding.projectPath}\nThe selected login will be passed privately to the program. ${background ? "The task may continue after this Panel closes." : "Closing this Panel or revoking access stops use of the temporary file."}`,
        noLink: true,
      });
      if (decision.response !== 0)
        throw new PanelBridgeError("PERMISSION_DENIED", "Saved login use was cancelled");
    }
    if (
      this.guests.get(binding.guest.id) !== binding ||
      binding.guest.isDestroyed() ||
      binding.cwd !== cwd ||
      binding.resource.descriptor.revision !== scope.revision
    )
      throw new PanelBridgeError("REVOKED", "Panel scope changed during Cookie approval");
    await this.trustedWorkspaceRoot(binding);
    await host.check(scope, selection);
    if (
      this.guests.get(binding.guest.id) !== binding ||
      binding.guest.isDestroyed() ||
      binding.cwd !== cwd ||
      !this.options.isWorkspaceTrusted(cwd ?? scope.projectPath)
    )
      throw new PanelBridgeError("REVOKED", "Panel scope changed during Cookie approval");
    this.assertProjectBinding(binding);
  }

  private getBackgroundService(): PanelBackgroundService {
    if (this.backgroundService) return this.backgroundService;
    this.backgroundService = new PanelBackgroundService({
      rootDir: join(app.getPath("userData"), "panel-background-services"),
      describe: async (scope: BackgroundServiceScope) => {
        if (
          !this.options.isPanelAppBound(scope.projectPath, scope.appId) ||
          !this.options.isWorkspaceTrusted(scope.projectPath)
        )
          throw new PanelBridgeError(
            "REVOKED",
            "Background service project authorization was revoked",
          );
        const installed = await this.projectToolApps(scope.projectPath).get(scope.appId);
        // Cache absence may mean a transient inspection/registry IO error. It
        // cannot prove revocation; explicit binding/trust and inspected grants can.
        if (!installed) throw new Error("SERVICE_PACKAGE_INSPECTION_UNAVAILABLE");
        const definition =
          installed?.backgroundServices && Object.hasOwn(installed.backgroundServices, scope.name)
            ? installed.backgroundServices[scope.name]
            : undefined;
        if (
          !definition ||
          !["process", "background.services", "context.workspace"].every((permission) =>
            installed.permissions.includes(permission as PanelAppPermission),
          )
        )
          throw new PanelBridgeError(
            "REVOKED",
            "Selected package does not authorize this background service",
          );
        const entry = installed.nativeEntries?.[definition.entry];
        if (!entry)
          throw new PanelBridgeError("REVOKED", "Reviewed background service entry is missing");
        const executable = async () => {
          const path = await this.options.resolveBackgroundServiceNode?.();
          if (!path)
            throw new PanelBridgeError(
              "NOT_SUPPORTED",
              "Background services require the verified Host-managed Node runtime",
            );
          return path;
        };
        // Subscription/config work directories are project-private; never app-global.
        const projectKey = createHash("sha256")
          .update(panelExecutionProject(scope.projectPath))
          .digest("hex");
        return {
          revision: installedPanelAppRevision(installed),
          definition,
          executable,
          entry: join(installed.installPath, entry.entry),
          sha256: entry.sha256,
          packageRoot: installed.installPath,
          cwd: join(
            app.getPath("userData"),
            "panel-app-data",
            scope.appId,
            "services",
            projectKey,
            scope.name,
          ),
        };
      },
      onEvent: (scope, payload) => {
        for (const binding of this.guests.values())
          if (
            !binding.guest.isDestroyed() &&
            binding.resource.descriptor.appId === scope.appId &&
            panelExecutionProject(binding.projectPath) === scope.projectPath &&
            binding.resource.descriptor.permissions.includes("background.services")
          )
            binding.guest.send("panel-app:event", { event: "services.changed", payload });
      },
    });
    const service = this.backgroundService;
    this.unsubscribeBackgroundAvailability = service.subscribeAvailability((available) => {
      if (this.backgroundService !== service || this.resourceTransfersStopping) return;
      if (available) this.backgroundInitializationError = undefined;
      this.refreshBackgroundServiceContexts();
    });
    return this.backgroundService;
  }

  private async dispatchBackgroundServices(binding: GuestBinding, method: string, params: unknown) {
    this.requirePermission(binding, "background.services");
    this.requirePermission(binding, "process");
    this.requirePermission(binding, "context.workspace");
    await this.trustedWorkspaceRoot(binding);
    if (process.platform === "win32")
      throw new PanelBridgeError(
        "NOT_SUPPORTED",
        "Background services require verifiable POSIX process custody",
      );
    if (this.resourceTransfersStopping || !this.backgroundService?.isAvailable())
      throw new PanelBridgeError(
        "NOT_SUPPORTED",
        this.backgroundInitializationError ??
          "Background services are not initialized or available",
      );
    const input = (params ?? {}) as any;
    const service = this.getBackgroundService();
    if (method !== "services.get" && method !== "services.read") {
      const installed = await this.projectToolApps(binding.projectPath).get(
        binding.resource.descriptor.appId,
      );
      if (
        !installed ||
        installedPanelAppRevision(installed) !== binding.resource.descriptor.revision ||
        !["process", "background.services", "context.workspace"].every((permission) =>
          installed.permissions.includes(permission as PanelAppPermission),
        )
      )
        throw new PanelBridgeError(
          "REVOKED",
          "Installed background service revision or permissions changed",
        );
      this.assertLiveProjectBinding(binding);
    }
    if (method === "services.detach") return service.detach(input.attachId, binding.guest.id);
    if (
      !binding.resource.descriptor.backgroundServices ||
      !Object.hasOwn(binding.resource.descriptor.backgroundServices, input.name)
    )
      throw new PanelBridgeError(
        "PERMISSION_DENIED",
        "Background service is not declared by the selected package",
      );
    const scope = {
      appId: binding.resource.descriptor.appId,
      projectPath: binding.projectPath,
      name: input.name,
    };
    if (method === "services.get") return service.get(scope);
    if (method === "services.read") return service.read(scope, input.channel, input.afterSeq);
    if (method === "services.attach") return service.attach(scope, binding.guest.id);
    if (method === "services.setDesired") return service.setDesired(scope, input);
    if (method === "services.configure") return service.configure(scope, input);
    if (method === "services.control") return service.control(scope, input);
    throw new PanelBridgeError("NOT_SUPPORTED", "Unknown background service operation");
  }

  private getToolJobService(): PanelToolJobService {
    if (this.toolJobService) return this.toolJobService;
    const executor = createPanelToolExecutor({
      ...(this.options.cookieCredentials?.taskCredentials
        ? { cookies: this.getTaskCookieHost() }
        : {}),
      processes: this.processService,
      resources: this.getResourceService(),
      owner: (job, send) => {
        const guestId = this.nextToolOwner--;
        const binding = [...this.guests.values()].find(
          (binding) =>
            binding.resource.descriptor.appId === job.scope.appId &&
            binding.projectPath === job.scope.projectPath,
        );
        const appTitle = binding?.resource.descriptor.title ?? job.scope.appId;
        this.toolOwners.set(guestId, { scope: job.scope, appTitle, taskId: job.id });
        return { guestId, appId: job.scope.appId, appTitle, revision: job.scope.revision, send };
      },
      releaseOwner: (owner) => {
        this.toolOwners.delete(owner.guestId);
      },
      authorize: async (scope) => {
        await this.installedToolApp(scope);
      },
      authorizeConnections: async (scope) => {
        if (!(await this.installedToolApp(scope)).permissions.includes("credentials.connections"))
          throw new PanelBridgeError("PERMISSION_DENIED", "Tool requires connection permission");
      },
      authorizeDirectRead: async (scope) => {
        if (!(await this.installedToolApp(scope)).permissions.includes("resources.directRead"))
          throw new PanelBridgeError("PERMISSION_DENIED", "Tool requires direct read permission");
      },
      resolveDirectoryBookmark: async (scope, bookmark) => {
        await this.installedToolApp(scope);
        return this.directoryBookmarks.restore(scope.appId, scope.projectPath, bookmark);
      },
      appDataDirectory: async (scope) => {
        await this.installedToolApp(scope);
        const path = join(app.getPath("userData"), "panel-app-data", scope.appId);
        await mkdir(path, { recursive: true, mode: 0o700 });
        return path;
      },
      sealedRoot: join(app.getPath("userData"), "panel-app-sealed"),
    });
    this.toolJobService = new PanelToolJobService({
      rootDir: join(app.getPath("userData"), "panel-tool-jobs"),
      ...executor,
      isAuthorized: async (scope) => !!(await this.installedToolApp(scope).catch(() => null)),
      describePackage: async (scope) => {
        const installed = await this.installedToolApp(scope);
        if (!installed.packageDigest) throw new Error("Project package digest is unavailable");
        return { version: installed.version, packageDigest: installed.packageDigest };
      },
      onEvent: (job) => {
        for (const binding of this.guests.values())
          if (
            !binding.guest.isDestroyed() &&
            binding.resource.descriptor.appId === job.scope.appId &&
            binding.projectPath === job.scope.projectPath &&
            binding.resource.descriptor.revision === job.scope.revision &&
            binding.resource.descriptor.permissions.includes("process") &&
            binding.resource.descriptor.permissions.includes("resources")
          )
            binding.guest.send("panel-app:event", {
              event: "tasks.changed",
              payload: panelToolJobSummary(job),
            });
      },
    });
    return this.toolJobService;
  }

  private dispatchToolJobs(binding: GuestBinding, method: string, params: unknown) {
    return panelDispatchToolJobs(this.internals(), binding, method, params);
  }

  private getResourceService(): PanelResourceService {
    this.resourceService ??= new PanelResourceService({
      rootDirectory: join(app.getPath("userData"), "panel-app-media"),
      isScopeAuthorized: (scope) =>
        this.options.isPanelAppBound(scope.projectPath, scope.appId) &&
        this.options.isWorkspaceTrusted(scope.projectPath),
    });
    return this.resourceService;
  }

  private authorizeConnections(binding: GuestBinding, params: unknown) {
    return panelAuthorizeConnections(this.internals(), binding, params);
  }

  private getMediaService(): PanelMediaService {
    this.mediaService ??= new PanelMediaService({
      rootDirectory: join(app.getPath("userData"), "panel-app-media"),
      isScopeAuthorized: (scope) =>
        this.options.isPanelAppBound(scope.projectPath, scope.appId) &&
        this.options.isWorkspaceTrusted(scope.projectPath),
      onChanged: (scope, job) => {
        for (const binding of this.guests.values()) {
          if (
            !binding.guest.isDestroyed() &&
            binding.projectPath === scope.projectPath &&
            binding.resource.descriptor.appId === scope.appId &&
            binding.resource.descriptor.permissions.includes("media")
          ) {
            binding.guest.send("panel-app:event", { event: "media.job.changed", payload: job });
          }
        }
      },
    });
    return this.mediaService;
  }

  private dispatchMedia(binding: GuestBinding, method: string, params: unknown) {
    return panelDispatchMedia(this.internals(), binding, method, params);
  }

  private async dispatch(
    binding: GuestBinding,
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    // Main can receive a rebind before the guest receives context.changed.
    // Enforce the original session at the actual dispatch boundary as well.
    if (method === "agent.submitPrompt" || method.startsWith("automations."))
      this.assertSessionBinding(binding);
    if (method.startsWith("automations.") && this.options.automations?.conditional) {
      this.requirePermission(binding, "automations.manage");
      return this.conditionalPanelAutomation(binding, method, params);
    }
    if (method.startsWith("modelTraces.")) {
      this.assertLiveProjectBinding(binding);
      if (!this.options.isWorkspaceTrusted(binding.cwd ?? binding.projectPath))
        throw new PanelBridgeError(
          "PERMISSION_DENIED",
          "Panel model observation requires a trusted workspace",
        );
      return this.modelTraces.call(
        {
          ownerKey: `guest:${binding.guest.id}`,
          appId: binding.resource.descriptor.appId,
          revision: binding.resource.descriptor.revision,
          workspacePath: binding.cwd ?? binding.projectPath,
          sessionId: binding.context.sessionId,
        },
        method,
        params,
      );
    }
    if (method.startsWith("services."))
      return this.dispatchBackgroundServices(binding, method, params);
    if (method.startsWith("tasks.")) return this.dispatchToolJobs(binding, method, params);
    if (method.startsWith("resources.")) {
      this.requirePermission(binding, "resources");
      await this.trustedWorkspaceRoot(binding);
      const scope = { appId: binding.resource.descriptor.appId, projectPath: binding.projectPath };
      if (method === "resources.references.pick")
        return this.pickResourceReferences(binding, params, signal);
      if (
        method === "resources.materialize" ||
        method === "resources.capture" ||
        method === "resources.references.create" ||
        method === "resources.references.relink"
      )
        this.requirePermission(binding, "process");
      return this.getResourceService().dispatch(scope, method, params, {
        signal,
        resolveDirectory: (handle) =>
          this.processService.directoryPath(this.processOwner(binding), handle),
      });
    }
    if (method === "credentials.connections.list") {
      this.requirePermission(binding, "credentials.connections");
      return panelConnections(await this.trustedWorkspaceRoot(binding));
    }
    if (method === "credentials.connections.authorizeProcess")
      return this.authorizeConnections(binding, params);
    if (method.startsWith("media.")) {
      this.requirePermission(binding, "media");
      return this.dispatchMedia(binding, method, params);
    }
    switch (method) {
      case "context.get":
        return { ...binding.context, ...this.capabilitiesFor(binding) };
      case "storage.getSnapshot":
      case "storage.compareAndSet":
        this.requirePermission(binding, "storage");
        return this.storageVersioned(binding, method, params);
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
      case "agent.task.start":
        this.requirePermission(binding, "agent.task");
        return this.agentTaskService.start(
          this.agentTaskOwner(binding),
          (params ?? {}) as PanelAgentTaskStartInput,
        );
      case "agent.task.models":
        this.requirePermission(binding, "agent.task");
        return this.options.agentTaskModels?.(binding.cwd ?? binding.projectPath) ?? { models: [] };
      case "agent.task.list":
        this.requirePermission(binding, "agent.task");
        return this.agentTaskService.list(this.agentTaskOwner(binding));
      case "agent.task.get":
        this.requirePermission(binding, "agent.task");
        return this.agentTaskService.get(
          this.agentTaskOwner(binding),
          (params as { id?: unknown } | null)?.id,
        );
      case "agent.task.cancel":
        this.requirePermission(binding, "agent.task");
        return this.agentTaskService.cancel(
          this.agentTaskOwner(binding),
          (params as { id?: unknown } | null)?.id,
        );
      case "workspace.info":
        this.requirePermission(binding, "workspace.info");
        return this.workspaceInfo(binding);
      case "workspace.list":
        this.requirePermission(binding, "workspace.read");
        return this.workspaceList(binding, params);
      case "workspace.readText":
        this.requirePermission(binding, "workspace.read");
        return this.workspaceReadText(binding, params);
      case "workspace.openPath":
        this.requirePermission(binding, "workspace.read");
        return this.workspaceOpenPath(binding, params);
      case "workspace.revealPath":
        this.requirePermission(binding, "workspace.read");
        return this.workspaceRevealPath(binding, params);
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
      case "credentials.cookies.listForTask": {
        this.requirePermission(binding, "credentials.cookies");
        this.requirePermission(binding, "process");
        this.requirePermission(binding, "resources");
        await this.trustedWorkspaceRoot(binding);
        return this.getTaskCookieHost().list(
          {
            appId: binding.resource.descriptor.appId,
            projectPath: binding.projectPath,
            revision: binding.resource.descriptor.revision,
          },
          this.cookieCredentialUrl(params).toString(),
        );
      }
      case "credentials.cookies.loginAndSave":
        this.requirePermission(binding, "credentials.cookies");
        return this.loginAndSaveCookieCredential(binding, params);
      case "credentials.cookies.restore":
        this.requirePermission(binding, "credentials.cookies");
        return this.restoreCookieCredential(binding, params);
      case "credentials.cookies.authorizeProcess":
        this.requirePermission(binding, "credentials.cookies");
        this.requirePermission(binding, "process");
        return this.authorizeCookieCredentialForProcess(binding, params);
      case "automations.list":
        this.requirePermission(binding, "automations.manage");
        return this.listPanelAutomations(binding);
      case "automations.create":
        this.requirePermission(binding, "automations.manage");
        return this.createPanelAutomation(binding, params);
      case "automations.createUnique":
        this.requirePermission(binding, "automations.manage");
        return this.createPanelAutomation(binding, params, true);
      case "automations.updateIfRevision":
      case "automations.deleteIfRevision":
        this.requirePermission(binding, "automations.manage");
        return this.conditionalPanelAutomation(binding, method, params);
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
      case "process.info":
        this.requirePermission(binding, "process");
        return panelProcessInfo();
      case "process.resolveEntry":
        this.requirePermission(binding, "process");
        return this.processService.resolveEntry(this.processOwner(binding), params);
      case "process.get":
        this.requirePermission(binding, "process");
        return this.processService.get(this.processOwner(binding), params);
      case "process.write":
        this.requirePermission(binding, "process");
        return this.processService.write(this.processOwner(binding), params);
      case "process.end":
        this.requirePermission(binding, "process");
        return this.processService.end(this.processOwner(binding), params);
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
      case "filesystem.restoreDirectory":
        this.requirePermission(binding, "process");
        return this.restoreProcessDirectory(binding, params);
      case "filesystem.openDirectory":
        this.requirePermission(binding, "process");
        return this.openProcessDirectory(binding, params);
      default:
        throw new PanelBridgeError("NOT_SUPPORTED", `unknown Panel App method: ${method}`);
    }
  }

  /**
   * Explicit dependencies for the extracted panel-app-bridge-* handlers. Built
   * per call and forwarding through `this`, so handlers always reach the
   * bridge's current guards and services rather than a stale snapshot.
   */
  private internals(): PanelAppBridgeInternals {
    return {
      options: this.options,
      guests: this.guests,
      processService: this.processService,
      isResourceTransfersStopping: () => this.resourceTransfersStopping,
      requirePermission: (binding, permission) => this.requirePermission(binding, permission),
      assertProjectBinding: (binding) => this.assertProjectBinding(binding),
      trustedWorkspaceRoot: (binding) => this.trustedWorkspaceRoot(binding),
      isWithinWorkspace: (root, candidate, allowRoot) =>
        this.isWithinWorkspace(root, candidate, allowRoot),
      readBoundedWorkspaceFile: (handle, maxBytes) =>
        this.readBoundedWorkspaceFile(handle, maxBytes),
      writeWorkspaceFile: (...args) => this.writeWorkspaceFile(...args),
      processOwner: (binding) => this.processOwner(binding),
      getTaskCookieHost: () => this.getTaskCookieHost(),
      confirmTaskCookie: (binding, input, entry, background) =>
        this.confirmTaskCookie(binding, input, entry, background),
      getResourceService: () => this.getResourceService(),
      getMediaService: () => this.getMediaService(),
      getToolJobService: () => this.getToolJobService(),
      installedToolApp: (scope) => this.installedToolApp(scope),
      pendingAgentToolCalls: this.pendingAgentToolCalls,
      findAgentToolBinding: (appDescriptorId, bucket, ownerWindowId) =>
        this.findAgentToolBinding(appDescriptorId, bucket, ownerWindowId),
    };
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

  private agentTaskOwner(binding: GuestBinding): PanelAgentTaskOwner {
    const owner = this.sessionOwnerWindow(binding);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    if (!binding.bucket) throw new Error("Panel App scope is not bound");
    const availableSkills = (binding.resource.descriptor.agent?.skills ?? []).flatMap((entry) => {
      const match = /^agent\/skills\/([a-z][a-z0-9-]{0,63})\/SKILL\.md$/.exec(entry);
      return match ? [`${binding.resource.descriptor.appId}:${match[1]}`] : [];
    });
    return {
      guestId: binding.guest.id,
      ownerWebContentsId: owner.webContents.id,
      appId: binding.resource.descriptor.appId,
      appTitle: binding.resource.descriptor.title,
      projectPath: binding.projectPath,
      cwd: binding.cwd ?? binding.projectPath,
      bucket: binding.bucket,
      availableSkills,
    };
  }

  private async getKnownProcessDirectory(binding: GuestBinding, params: unknown): Promise<unknown> {
    const name = (params as { name?: unknown } | null)?.name;
    if (name === "project") {
      const scope = await this.directoryProjectScope(binding);
      const owner = this.processOwner(binding);
      const selected = await this.processService.grantDirectory(owner, scope.workspacePath, scope);
      scope.assertCurrent();
      const bookmark = this.directoryBookmarks.remember(
        binding.resource.descriptor.appId,
        scope.projectPath,
        selected.path,
      );
      this.processService.directoryPath(owner, selected.handle);
      return { ...selected, bookmark };
    }
    if (name === "downloads") {
      const scope =
        binding.cwd && this.options.isWorkspaceTrusted(binding.cwd)
          ? await this.directoryProjectScope(binding)
          : undefined;
      const owner = this.processOwner(binding);
      const selected = await this.processService.grantDirectory(
        owner,
        app.getPath("downloads"),
        scope,
      );
      if (!scope) return selected;
      scope.assertCurrent();
      const bookmark = this.directoryBookmarks.remember(
        binding.resource.descriptor.appId,
        scope.projectPath,
        selected.path,
      );
      this.processService.directoryPath(owner, selected.handle);
      return { ...selected, bookmark };
    }
    if (name === "user-bin") {
      return this.grantManagedBinDirectory(binding);
    }
    if (name === "app-data") {
      return this.grantPanelAppDataDirectory(binding);
    }
    throw new Error("unsupported known directory");
  }

  private managedBinDirectory(): string {
    return join(app.getPath("userData"), "bin");
  }

  private async grantManagedBinDirectory(binding: GuestBinding): Promise<unknown> {
    const path = this.managedBinDirectory();
    await mkdir(path, { recursive: true, mode: 0o700 });
    return this.processService.grantDirectory(this.processOwner(binding), path);
  }

  private panelAppDataDirectory(binding: GuestBinding): string {
    const appId = binding.resource.descriptor.appId;
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(appId)) {
      throw new Error("Panel App id is unsafe for local data");
    }
    return join(app.getPath("userData"), "panel-app-data", appId);
  }

  private async grantPanelAppDataDirectory(binding: GuestBinding): Promise<unknown> {
    const path = this.panelAppDataDirectory(binding);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700).catch(() => undefined);
    return this.processService.grantDirectory(this.processOwner(binding), path);
  }

  private pickResourceReferences(binding: GuestBinding, params: unknown, signal?: AbortSignal) {
    return panelPickResourceReferences(this.internals(), binding, params, signal);
  }

  private async pickProcessDirectory(binding: GuestBinding): Promise<unknown> {
    const owner = BrowserWindow.fromId(binding.ownerWindowId);
    if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
    const scope = await this.directoryProjectScope(binding);
    const selected = await dialog.showOpenDialog(owner, {
      title: "Choose output directory",
      defaultPath: app.getPath("downloads"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (selected.canceled || selected.filePaths.length !== 1) return { cancelled: true };
    scope.assertCurrent();
    const processOwner = this.processOwner(binding);
    const grant = await this.processService.grantDirectory(
      processOwner,
      selected.filePaths[0],
      scope,
    );
    scope.assertCurrent();
    const bookmark = this.directoryBookmarks.remember(
      binding.resource.descriptor.appId,
      scope.projectPath,
      grant.path,
    );
    this.processService.directoryPath(processOwner, grant.handle);
    return { ...grant, bookmark };
  }

  private async restoreProcessDirectory(binding: GuestBinding, params: unknown): Promise<unknown> {
    const scope = await this.directoryProjectScope(binding);
    const bookmark = (params as { bookmark?: unknown } | null)?.bookmark;
    const path = this.directoryBookmarks.restore(
      binding.resource.descriptor.appId,
      scope.projectPath,
      bookmark,
    );
    const owner = this.processOwner(binding);
    const grant = await this.processService.grantDirectory(owner, path, scope);
    scope.assertCurrent();
    this.directoryBookmarks.restore(binding.resource.descriptor.appId, scope.projectPath, bookmark);
    this.processService.directoryPath(owner, grant.handle);
    return { ...grant, bookmark };
  }

  /** Directory grants belong to the bound project; execution retains its workspace root. */
  private async directoryProjectScope(binding: GuestBinding) {
    const cwd = binding.cwd;
    const projectPath = binding.projectPath;
    const descriptor = binding.resource?.descriptor;
    const revision = descriptor?.revision;
    const appId = descriptor?.appId;
    let topology: { projectPath: string; assertCurrent(): void } | undefined = undefined;
    const assertCurrent = () => {
      if (
        !cwd ||
        !projectPath ||
        !descriptor ||
        binding.cwd !== cwd ||
        binding.projectPath !== projectPath ||
        binding.resource.descriptor !== descriptor ||
        descriptor.revision !== revision ||
        descriptor.appId !== appId ||
        this.guests.get(binding.guest.id) !== binding ||
        binding.guest.isDestroyed() ||
        !this.options.isWorkspaceTrusted(cwd) ||
        !this.options.isWorkspaceTrusted(projectPath)
      )
        throw new PanelBridgeError(
          "REVOKED",
          "Directory workspace or project authorization changed",
        );
      this.assertProjectBinding(binding);
      topology?.assertCurrent();
    };
    assertCurrent();
    const workspacePath = await this.trustedWorkspaceRoot(binding);
    assertCurrent();
    // A secondary root's workspace is proven against that root, and Main's
    // registry proves the root belongs to the project that keeps the bookmarks.
    const isProjectRoot = (root: string) =>
      this.options.isProjectRoot?.(projectPath, root) === true;
    const root = this.options.isProjectRoot && resolvePanelAppBindingProjectPath(workspacePath);
    if (root && root !== projectPath && isProjectRoot(root)) {
      const workspace = createPanelDirectoryProjectScope(workspacePath, root);
      const project = createPanelDirectoryProjectScope(projectPath, projectPath);
      topology = {
        projectPath: project.projectPath,
        assertCurrent: () => {
          workspace.assertCurrent();
          project.assertCurrent();
          if (!isProjectRoot(root))
            throw new PanelBridgeError("REVOKED", "Directory project root authorization changed");
        },
      };
    } else topology = createPanelDirectoryProjectScope(workspacePath, projectPath);
    assertCurrent();
    return { workspacePath, projectPath: topology.projectPath, assertCurrent };
  }

  private async openProcessDirectory(binding: GuestBinding, params: unknown): Promise<boolean> {
    const handle = (params as { handle?: unknown } | null)?.handle;
    const path = this.processService.directoryPath(this.processOwner(binding), handle);
    const error = await shell.openPath(path);
    if (error) throw new Error(`failed to open directory: ${error}`);
    return true;
  }

  private panelAudioStatus(binding: GuestBinding) {
    return panelAudioStatus(this.internals(), binding);
  }

  private requestPanelMicrophoneAccess(binding: GuestBinding) {
    return panelRequestMicrophoneAccess(this.internals(), binding);
  }

  private transcribePanelAudio(binding: GuestBinding, params: unknown) {
    return panelTranscribeAudio(this.internals(), binding, params);
  }

  private panelAutomationHost(binding: GuestBinding) {
    this.assertSessionBinding(binding);
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

  private panelAutomationScope(binding: GuestBinding): { resumeSessionId: string } {
    this.panelAutomationHost(binding);
    return { resumeSessionId: binding.context.sessionId! };
  }

  private async conditionalPanelAutomation(binding: GuestBinding, method: string, params: unknown) {
    const host = this.panelAutomationHost(binding).conditional;
    if (!host?.conditionalMutations) throw Error("Conditional automation changes are unavailable");
    this.requirePermission(binding, "context.workspace");
    this.requirePermission(binding, "context.session");
    const cwd = binding.context.cwd!;
    const sessionId = binding.context.sessionId!;
    return host.call(
      {
        appId: binding.resource.descriptor.appId,
        cwd,
        sessionId,
        revision: binding.resource.descriptor.revision,
        assertAuthorized: () => this.assertSessionBinding(binding),
        isAuthorized: async () => {
          if (
            this.guests.get(binding.guest.id) !== binding ||
            binding.guest.isDestroyed() ||
            binding.context.cwd !== cwd ||
            binding.context.sessionId !== sessionId ||
            !this.options.isWorkspaceTrusted(cwd)
          )
            return false;
          try {
            this.assertSessionBinding(binding);
            return true;
          } catch {
            return false;
          }
        },
      },
      method,
      params,
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
    const automations = await host.list(this.panelAutomationScope(binding));
    this.assertSessionBinding(binding);
    return { automations };
  }

  private async requireScopedPanelAutomation(binding: GuestBinding, id: string) {
    const host = this.panelAutomationHost(binding);
    const scope = this.panelAutomationScope(binding);
    const automation = (await host.list(scope)).find((job) => job.id === id);
    this.assertSessionBinding(binding);
    if (!automation) {
      throw new Error("Panel App automation is not available in this project task");
    }
    return { host, automation, scope };
  }

  private async createPanelAutomation(
    binding: GuestBinding,
    params: unknown,
    unique = false,
  ): Promise<unknown> {
    const host = this.panelAutomationHost(binding);
    if (unique && !host.uniqueCreation)
      throw new Error("Panel App unique automation creation is unavailable");
    const input = params as {
      key?: unknown;
      name?: unknown;
      schedule?: unknown;
      prompt?: unknown;
      timezone?: unknown;
      cwd?: unknown;
      projectId?: unknown;
      rootId?: unknown;
      resumeSessionId?: unknown;
    } | null;
    if (
      input &&
      ["cwd", "projectId", "rootId", "resumeSessionId", "creationKey"].some((key) =>
        Object.prototype.hasOwnProperty.call(input, key),
      )
    ) {
      throw new Error("Panel App cannot submit automation workspace authority fields");
    }
    if (unique && (typeof input?.key !== "string" || !/^[a-zA-Z0-9._:-]{1,80}$/.test(input.key)))
      throw new Error("Panel App unique automation requires a bounded key");
    if (!unique && input?.key !== undefined)
      throw new Error("Panel App automation keys require automations.createUnique");
    const scope = this.panelAutomationScope(binding);
    const creationKey = unique
      ? panelAutomationCreationKey(
          binding.resource.descriptor.appId,
          binding.context.cwd!,
          scope.resumeSessionId,
          input!.key as string,
        )
      : undefined;
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
    return host.create(
      {
        name,
        schedule,
        prompt,
        ...(timezone ? { timezone } : {}),
        permissionLevel: "full",
        ...(creationKey ? { creationKey } : {}),
      },
      scope,
    );
  }

  private async updatePanelAutomation(binding: GuestBinding, params: unknown): Promise<unknown> {
    const id = this.automationId(params);
    const { host, scope } = await this.requireScopedPanelAutomation(binding, id);
    this.assertSessionBinding(binding);
    const input = params as {
      name?: unknown;
      schedule?: unknown;
      prompt?: unknown;
      timezone?: unknown;
      cwd?: unknown;
      projectId?: unknown;
      rootId?: unknown;
      resumeSessionId?: unknown;
    };
    if (
      ["cwd", "projectId", "rootId", "resumeSessionId"].some((key) =>
        Object.prototype.hasOwnProperty.call(input, key),
      )
    ) {
      throw new Error("Panel App cannot submit automation workspace authority fields");
    }
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
    return host.update(id, patch, scope);
  }

  private async controlPanelAutomation(
    binding: GuestBinding,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.automationId(params);
    const { host } = await this.requireScopedPanelAutomation(binding, id);
    this.assertSessionBinding(binding);
    if (method === "automations.pause") return { ok: await host.pause(id) };
    if (method === "automations.resume") return { ok: await host.resume(id) };
    if (method === "automations.delete") return { ok: await host.delete(id) };
    if (method === "automations.runNow") return { ok: await host.runNow(id) };
    throw new Error("Unknown Panel App automation action");
  }

  private cookieCredentialUrl(params: unknown): URL {
    return cookieCredentialUrl(params);
  }

  private listCookieCredentials(binding: GuestBinding, params: unknown) {
    return panelListCookieCredentials(this.internals(), binding, params);
  }

  private loginAndSaveCookieCredential(binding: GuestBinding, params: unknown) {
    return panelLoginAndSaveCookieCredential(this.internals(), binding, params);
  }

  private restoreCookieCredential(binding: GuestBinding, params: unknown) {
    return panelRestoreCookieCredential(this.internals(), binding, params);
  }

  private authorizeCookieCredentialForProcess(binding: GuestBinding, params: unknown) {
    return panelAuthorizeCookieCredentialForProcess(this.internals(), binding, params);
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
    return readPanelAppStorage(this.storagePath(binding), this.storageQuotaBytes());
  }

  private storageKey(params: unknown): string {
    return panelAppStorageKey(params);
  }

  private storageQuotaBytes(): number {
    return panelAppStorageQuotaBytes(
      this.options.limits?.storageQuotaBytes ?? DEFAULT_PANEL_APP_STORAGE_QUOTA_BYTES,
    );
  }

  private async storageGet(binding: GuestBinding, params: unknown): Promise<unknown> {
    const storage = await this.readStorage(binding);
    const key = this.storageKey(params);
    return Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null;
  }

  private async storageVersioned(binding: GuestBinding, method: string, params: unknown) {
    const projectPath = binding.projectPath;
    const file = this.storagePath(binding);
    const key = this.storageKey(params);
    const change = method === "storage.compareAndSet" ? panelAppStorageChange(params) : null;
    const assertAuthorized = () => {
      if (
        this.guests.get(binding.guest.id) !== binding ||
        binding.guest.isDestroyed() ||
        binding.projectPath !== projectPath
      )
        throw new PanelBridgeError("REVOKED", "Panel App storage scope changed");
      this.assertLiveProjectBinding(binding);
      this.requirePermission(binding, "storage");
    };
    if (!change) {
      const snapshot = panelAppStorageSnapshot(
        await readPanelAppStorage(file, this.storageQuotaBytes()),
        key,
      );
      await assertAuthorized();
      return snapshot;
    }
    return this.withStorageMutation(binding, async (file) => {
      await assertAuthorized();
      const storage = await readPanelAppStorage(file, this.storageQuotaBytes());
      const result = applyPanelAppStorageChange(storage, change);
      if (result.updated)
        await writePanelAppStorage(
          file,
          storage,
          this.storageQuotaBytes(),
          async () => assertAuthorized(),
          assertAuthorized,
        );
      await assertAuthorized();
      return result;
    });
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
      await this.writeStorage(binding, file, storage);
      return true;
    });
  }

  private async storageDelete(binding: GuestBinding, params: unknown): Promise<boolean> {
    const key = this.storageKey(params);
    return this.withStorageMutation(binding, async (file) => {
      const storage = await this.readStorage(binding);
      const existed = Object.prototype.hasOwnProperty.call(storage, key);
      delete storage[key];
      await this.writeStorage(binding, file, storage);
      return existed;
    });
  }

  private async writeStorage(
    binding: GuestBinding,
    file: string,
    storage: Record<string, unknown>,
  ): Promise<void> {
    const assertAuthorized = () => {
      this.assertLiveProjectBinding(binding);
      this.requirePermission(binding, "storage");
    };
    await writePanelAppStorage(
      file,
      storage,
      this.storageQuotaBytes(),
      async () => assertAuthorized(),
      assertAuthorized,
    );
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
    let releaseFileLock: (() => void) | undefined;
    try {
      this.assertLiveProjectBinding(binding);
      await preparePanelAppStorage(file);
      this.assertLiveProjectBinding(binding);
      // Other bridge instances can mutate the same file. Try once per tick so
      // their async writes and lock heartbeats can finish while we wait. Keep
      // the per-file lock shared with remote Panel storage and other processes.
      const deadline = Date.now() + 5_000;
      for (;;) {
        try {
          releaseFileLock = acquireLockOnPath(file, -1);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline)
            throw error;
          await new Promise((resolve) => setTimeout(resolve, 20));
          this.assertLiveProjectBinding(binding);
        }
      }
      this.assertLiveProjectBinding(binding);
      return await mutate(file);
    } finally {
      releaseFileLock?.();
      release();
      if (this.storageQueues.get(file) === tail) this.storageQueues.delete(file);
    }
  }

  private openExternal(binding: GuestBinding, params: unknown) {
    return panelOpenExternal(this.internals(), binding, params);
  }

  private async submitPrompt(binding: GuestBinding, params: unknown): Promise<unknown> {
    this.assertSessionBinding(binding);
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
    const submissionBinding = this.guests.get(binding.windowSourceGuestId ?? binding.guest.id)!;
    if (
      binding.context.busy ||
      submissionBinding.context.busy ||
      submissionBinding.agentSubmitInFlight
    ) {
      throw new Error("the target session is busy");
    }
    const bridge = this.options.getAgentBridge();
    if (!bridge) throw new Error("agent worker is unavailable");
    const output = bridge.captureExternalOutputSource(sessionId);

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
    const owner = this.sessionOwnerWindow(binding);
    claimPanelHostOwnerForRun(bridge, sessionId, owner);

    // Claim the slot BEFORE the await point. Everything above is synchronous, so
    // no second call can interleave between the check and this assignment.
    submissionBinding.agentSubmitInFlight = true;

    // Snapshot the route before the first await. A renderer re-bind may update
    // the selected model while handoff context is loading; one submission must
    // never mix the old provider kind with a new model key.
    const execution = { ...binding.execution };
    const bucket = binding.bucket;
    const parsedRuntime = execution.modelKey
      ? parseExternalRuntimeModelKey(execution.modelKey)
      : null;
    const dispatch = parsedRuntime
      ? async (): Promise<{ ok: boolean; message?: string; failureStreamed: boolean }> => {
          const service = this.options.getExternalRuntimeService?.();
          if (!service) throw new Error("external runtime service is unavailable");
          if (!owner || owner.isDestroyed()) throw new Error("owner window is unavailable");
          // Not the permission-gated workspace cwd: the runtime route must match
          // what the chat renderer sends for this session (see execution.cwd).
          const startRequest = {
            kind: parsedRuntime.kind,
            sessionId,
            cwd: execution.cwd,
            modelKey: execution.modelKey!,
            permissionMode: execution.permissionMode,
            planMode: execution.planMode,
            hasGoal: execution.hasGoal,
            ...(parsedRuntime.model ? { model: parsedRuntime.model } : {}),
            ownerWindow: owner,
          };
          if (!service.isCompatible(startRequest)) {
            const initialContext = await this.options.externalRuntimeInitialContext?.(sessionId);
            this.assertSessionBinding(binding);
            await service.ensure({
              ...startRequest,
              ...(initialContext ? { initialContext } : {}),
            });
          }
          this.assertSessionBinding(binding);
          const outcome = await service.send(sessionId, {
            text: task.trim(),
            modelTraceSource: `panel:${binding.resource.descriptor.appId}`,
            displayText,
            clientMessageId,
          });
          return {
            ok: outcome.ok,
            ...(outcome.text ? { message: outcome.text } : {}),
            // The recorder has already emitted the provider's failure into the
            // shared stream. Do not duplicate it through AgentBridge.
            failureStreamed: true,
          };
        }
      : async (): Promise<{ ok: boolean; message?: string; failureStreamed: boolean }> => {
          this.assertSessionBinding(binding);
          const result = await bridge.requestWorker(
            "agent/run",
            {
              task: task.trim(),
              modelTraceSource: `panel:${binding.resource.descriptor.appId}`,
              displayText,
              clientMessageId,
              sessionId,
              cwd,
              bucket,
              ...(execution.modelKey ? { model: execution.modelKey } : {}),
            },
            PANEL_AGENT_RUN_TIMEOUT_MS,
            // This RPC is a fire-and-forget backstop, not the completion signal —
            // real progress arrives on the session stream. The 24h timeout exists
            // only so the correlation is eventually reclaimed, so release it as soon
            // as the worker is known to be gone instead of holding it for a day.
            {
              settleOnExit: true,
              failFast: true,
              meta: { origin: "host", producer: "panel-submit-prompt" },
            },
          );
          return {
            ok: result.ok,
            ...(!result.ok ? { message: result.message } : {}),
            failureStreamed: false,
          };
        };

    void dispatch()
      .then((result) => {
        // Release once the worker has answered. By now either the run finished
        // or it failed; in the success case `context.busy` has long since been
        // pushed by the renderer, so there is no gap to re-open.
        submissionBinding.agentSubmitInFlight = false;
        if (result.ok || result.failureStreamed) return;
        output.publish({
          type: "error",
          error: `Panel App request failed: ${result.message ?? "unknown error"}`,
        });
      })
      .catch((error: unknown) => {
        // Must also release on failure, or one dropped request would wedge the
        // panel into a permanent "session is busy".
        submissionBinding.agentSubmitInFlight = false;
        output.publish({
          type: "error",
          error: `Panel App request failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      });

    return { accepted: true, clientMessageId };
  }

  private workspaceInfo(binding: GuestBinding) {
    return panelWorkspaceInfo(this.internals(), binding);
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

  private workspaceList(binding: GuestBinding, params: unknown) {
    return panelWorkspaceList(this.internals(), binding, params);
  }

  private workspaceReadText(binding: GuestBinding, params: unknown) {
    return panelWorkspaceReadText(this.internals(), binding, params);
  }

  private workspaceOpenPath(binding: GuestBinding, params: unknown) {
    return panelWorkspaceOpenPath(this.internals(), binding, params);
  }

  private workspaceRevealPath(binding: GuestBinding, params: unknown) {
    return panelWorkspaceRevealPath(this.internals(), binding, params);
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

  private async ensureWorkspaceDirectory(
    root: string,
    relativeDirectory: string,
    assertCurrent = () => {},
  ): Promise<string> {
    assertCurrent();
    if (relativeDirectory === ".") return root;
    let current = root;
    for (const segment of relativeDirectory.split(/[\\/]/)) {
      current = join(current, segment);
      try {
        const metadata = await lstat(current);
        assertCurrent();
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
          throw new Error("workspace path contains an unsafe directory");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        assertCurrent();
        try {
          await mkdir(current, { mode: 0o755 });
          assertCurrent();
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
          const metadata = await lstat(current);
          assertCurrent();
          if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
            throw new Error("workspace path contains an unsafe directory", {
              cause: mkdirError,
            });
          }
        }
      }
      const canonical = await realpath(current);
      assertCurrent();
      if (!this.isWithinWorkspace(root, canonical)) {
        throw new Error("workspace path escapes the root");
      }
      current = canonical;
    }
    return current;
  }

  private workspaceWriteText(binding: GuestBinding, params: unknown) {
    return panelWorkspaceWriteText(this.internals(), binding, params);
  }

  private workspaceExportPdf(binding: GuestBinding, params: unknown) {
    return panelWorkspaceExportPdf(this.internals(), binding, params);
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
    this.assertLiveProjectBinding(binding);
    const assertRoot = this.pinWorkspaceDirectory(root);
    const assertAuthorized = () => {
      this.assertLiveProjectBinding(binding);
      assertRoot();
    };
    const target = resolve(root, ...relativePath.split("/"));
    if (!this.isWithinWorkspace(root, target)) throw new Error("workspace path escapes the root");
    return this.withWorkspaceWrite(target, async () => {
      assertAuthorized();
      const parent = await this.ensureWorkspaceDirectory(
        root,
        dirname(relativePath),
        assertAuthorized,
      );
      assertAuthorized();
      const assertParent = this.pinWorkspaceDirectory(parent);
      const assertCommit = () => {
        assertAuthorized();
        assertParent();
      };
      const canonicalTarget = join(parent, basename(relativePath));
      const releaseWorkspaceLock = await acquireWorkspaceWriteLock(parent, basename(relativePath));
      let outcome: { ok: true; value: unknown } | { ok: false; error: unknown };
      try {
        assertCommit();
        let currentModifiedAt: number | null = null;
        let currentRevision: string | null = null;
        let targetMode = 0o644;
        try {
          const metadata = await lstat(canonicalTarget);
          assertCommit();
          if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error("workspace target is not a regular file");
          }
          currentModifiedAt = metadata.mtimeMs;
          targetMode = metadata.mode & 0o777;
          if (expectedRevision !== undefined) {
            const handle = await open(canonicalTarget, constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              assertCommit();
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
        assertCommit();
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
          await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
          assertCommit();
          const createOnly = expectedRevision === undefined && expectedModifiedAt === null;
          if (createOnly) {
            try {
              linkSync(temporary, canonicalTarget);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                throw new Error("workspace file changed since it was opened", { cause: error });
              }
              throw error;
            }
          } else {
            renameSync(temporary, canonicalTarget);
          }
          try {
            chmodSync(canonicalTarget, targetMode);
          } catch {
            /* Preserve best-effort mode behavior. */
          }
        } catch (error) {
          try {
            assertRoot();
            assertParent();
            await rm(temporary, { force: true });
          } catch {
            /* Never clean up inside a replaced directory. */
          }
          throw error;
        }
        assertCommit();
        await rm(temporary, { force: true }).catch(() => undefined);
        assertCommit();
        const metadata = await stat(canonicalTarget);
        outcome = {
          ok: true,
          value: {
            path: relativePath,
            size: metadata.size,
            modifiedAt: metadata.mtimeMs,
            revision: workspaceRevision(content),
          },
        };
      } catch (error) {
        outcome = { ok: false, error };
      }
      try {
        await releaseWorkspaceLock();
      } catch (error) {
        if (!outcome.ok)
          throw new AggregateError(
            [outcome.error, error],
            `${String(outcome.error)}; ${String(error)}`,
            { cause: error },
          );
        throw error;
      }
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    });
  }

  private pinWorkspaceDirectory(path: string): () => void {
    const canonical = realpathSync(path);
    const pin = lstatSync(canonical, { bigint: true });
    if (!pin.isDirectory() || pin.isSymbolicLink())
      throw new Error("workspace directory is unsafe");
    return () => {
      const current = lstatSync(path, { bigint: true });
      if (
        realpathSync(path) !== canonical ||
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== pin.dev ||
        current.ino !== pin.ino ||
        current.birthtimeNs !== pin.birthtimeNs
      )
        throw new Error("workspace directory changed during write");
    };
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

  private sendNotification(binding: GuestBinding, params: unknown) {
    return panelSendNotification(this.internals(), binding, params);
  }
}
