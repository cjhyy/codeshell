import { nativeMimiProactiveState } from "../desktop-host/mimi-proactive-client.js";
import { nativeMimiConversationRoutes } from "../desktop-host/mimi-conversation-routes-client.js";
import { mimiWindowIpc, trustedMimiWindows } from "./mimi-windows.js";
import type {
  MimiShellOptions,
  NativeMimiHost,
  MimiSegments,
  MimiReportEndpoints,
} from "./mimi-shell-types.js";
import { hydrateMimiWorkMemory } from "./mimi-work-context.js";
import { connectMimiDispatch } from "./mimi-dispatch-adapters.js";
import { startMimiDecisions } from "./mimi-owner-decisions.js";
import { connectMimiTasks, subscribeMimiReports } from "./mimi-reports.js";
import { mimiTurnStores } from "../../shared/mimi-turn-storage.js";
import { app, BrowserWindow, ipcMain, powerMonitor } from "electron";
import { SettingsManager, SessionManager, sessionsRoot } from "@cjhyy/code-shell-core";
import { AgentBridge, resolveNoRepoCwd } from "../agent-bridge.js";
import { nativeMimiFollowUps } from "../desktop-host/mimi-follow-ups-client.js";
import { registerPetIpc } from "../pet/pet-ipc.js";
import { type PetHostActionReceiptRecorder } from "../pet/pet-host-action-completion.js";
import { nativeMimiNoticeLedger } from "../desktop-host/mimi-notice-ledger-client.js";
import { currentMimiRuleDocument } from "../desktop-host/mimi-rules-client.js";
import type { MimiReplyRender } from "../../shared/mimi-gateway-turn.js";
import { nativeMimiRecords } from "../desktop-host/mimi-records-client.js";
import { PetWorkDelegationHost } from "../pet/pet-work-delegation-host.js";
import { getSessionCwdIndex } from "../session-cwd-index.js";
import { wirePetNotices, type PetNoticeWiring } from "../pet/pet-notice-wiring.js";
import { createExternalSessionCatalog } from "../pet/pet-notice-external-sessions.js";
import { hostedExternalGoalNoticeSource } from "../pet/pet-notice-goal-reconcile.js";
import { createPetNoticeControls, type PetNoticeControls } from "../pet/pet-notice-ipc.js";
import { wireMimiNoticeTools } from "../pet/pet-mimi-notice-tools.js";
import { createPetFollowUpRules } from "../pet/pet-follow-up-rules.js";
import { wirePetProactive } from "../pet/pet-proactive-wiring.js";
import { nativeMimiWorkMemory } from "../desktop-host/mimi-work-client.js";
import {
  createSessionOutcomeFanout,
  createSessionOutcomeTap,
  feedSessionOutcomeTap,
  SessionOutcomeDeriver,
} from "../pet/session-outcome.js";
import { PetImDecisions } from "../pet/pet-im-decisions.js";
import { createReusableSessionResolver } from "../pet/reusable-session-resolver.js";
import type { MimiDispatchService } from "../../shared/mimi-dispatch.js";
import {
  createBoundSessionHealth,
  createBoundSessionRunner,
  createSessionBridgeWiring,
  type SessionBridgeWiring,
} from "../pet/session-bridge-wiring.js";
import {
  petMemoryAutoExtractFromSettings,
  petMemoryAutoExtractSettingsPatch,
  resolvePetDelegatedPermissionMode,
} from "../../shared/pet-settings.js";
import { sessionModelKeyFromSettings } from "../../shared/session-model-default.js";
import { createExternalRuntimeHostSubmission } from "../external-runtime-host-submission.js";
import {
  persistedExternalRuntimeModelKey,
  isPersistedExternalRuntime,
} from "../mobile-remote/external-runtime-commands.js";
import { createPetExternalReplyModel } from "../pet/pet-external-reply-model.js";
import { dlog } from "../desktop-logger.js";
import { readSettings } from "../settings-service.js";
import { getTrustCachedSync } from "../trust-store.js";
import { runPetAutoArchive } from "./mimi-archive.js";
/** Native window, IM and worker adapters share one process-wide Mimi lifecycle. */
export function createMimiRuntimeShell(desktopHost: NativeMimiHost) {
  let petStateAggregator: typeof desktopHost.mimiProjection | null = null;
  let reconcileExternalAdapters: (() => Promise<void>) | null = null;
  let petDispatchService: MimiDispatchService | null = null;
  let petRuleScheduler: import("../pet/pet-follow-up-rules.js").RuleSchedulerLifecycle | null =
    null;
  // The dispatcher exists before its worker and durable stores finish loading.
  // IM delivery shares the same completed initialization boundary as Pet IPC.
  let petRuntimeReady = false;
  let petHostActionReceiptService: PetHostActionReceiptRecorder | null = null;
  let petNotices: PetNoticeWiring | null = null;
  let petWorkInboxStore: ReturnType<typeof nativeMimiRecords>["workInbox"] | null = null;
  let petImDecisions: PetImDecisions | null = null;
  let unsubscribePetLongTaskStream: (() => void) | null = null;
  let unsubscribePetReportStream: (() => void) | null = null;
  let disposePetIpc: (() => void) | null = null;

  let sessionBridge: SessionBridgeWiring | undefined;
  const subscriptions: Array<() => void> = [];
  const renderMimiReply = (
    baseText: string,
    executions: MimiReplyRender["executions"],
    options: MimiReplyRender["options"],
  ) => desktopHost.callBusiness("mimi/renderReply", { baseText, executions, options });

  async function start(bridge: AgentBridge, loadRenderer: () => void, options: MimiShellOptions) {
    const {
      externalRuntime,
      imGatewayService,
      nativeMimiScheduler,
      mobileOrchestrator,
      taskInboxService,
      markSessionTaskDirty,
      mainWindows,
      appRendererNavigation,
      publishGatewayControlEvent,
      listAllDiskSessions,
      archiveDiskSession,
    } = options;
    const mimiRecords = nativeMimiRecords(
      desktopHost.callBusiness,
      desktopHost.mimiRecordListeners,
    );
    const petMetadata = mimiRecords.metadata;
    const sessionStore = new SessionManager();
    const lastUserMessage = (sessionId: string) =>
      desktopHost.callBusiness("transcripts/context", { sessionId, kind: "lastUserMessage" });
    const imExternalSubmissions = createExternalRuntimeHostSubmission({
      initialContext: (sessionId) =>
        desktopHost.callBusiness("transcripts/context", { sessionId, kind: "handoff" }),
      service: () => externalRuntime.service,
      sessions: sessionStore,
      ownerWindow: (sessionId) => {
        const owner = bridge.panelOwnerWebContentsId(sessionId);
        return trustedMimiWindows(mainWindows, appRendererNavigation).find(
          (window) =>
            !window.isDestroyed() && (owner === undefined || window.webContents.id === owner),
        );
      },
    });
    const petWorkDelegationHost = new PetWorkDelegationHost({
      bridge,
      noWorkspaceCwd: resolveNoRepoCwd(),
      external: {
        modelKey: async ({ sessionId, cwd, reused }) => {
          const state = sessionStore.readSessionState(sessionId);
          if (reused || state) {
            if (!state) throw new Error("原工作会话不可用，未创建替代会话。");
            if (isPersistedExternalRuntime(state)) {
              const model = persistedExternalRuntimeModelKey(state);
              if (!model) throw new Error("外部会话模型不可用，未切换到 API 模型。");
              return model;
            }
            return state.modelConnectionId ?? null;
          }
          return sessionModelKeyFromSettings(new SettingsManager(cwd, "full").get());
        },
        run: imExternalSubmissions.run,
      },
      // Read per launch: a settings change applies to the next delegation. Like
      // the composer, a trusted project's default mode overrides the user's; an
      // unreadable settings file falls back to asking.
      permissionMode: async ({ cwd }) => {
        try {
          const user = await readSettings("user");
          const trusted = getTrustCachedSync(cwd) === "trusted";
          const project = trusted ? await readSettings("project", cwd) : null;
          return resolvePetDelegatedPermissionMode({ user, project });
        } catch {
          return "default";
        }
      },
      resolveSessionCwd: async (sessionId) => {
        const entry = await getSessionCwdIndex().refresh(sessionId);
        return entry?.status === "confirmed" ? (entry.workspaceRoot ?? entry.cwd) : undefined;
      },
      channelLabel: (channel) =>
        imGatewayService.ownerChannels().find((entry) => entry.id === channel)?.label,
    });
    const petWorkMemory = nativeMimiWorkMemory(desktopHost.callBusiness);
    const aggregator = desktopHost.mimiProjection;
    petStateAggregator = aggregator;
    subscriptions.push(
      aggregator.subscribe((event) => {
        if (event.kind === "session-upsert") markSessionTaskDirty(event.session.agentSessionId);
        else if (event.kind === "session-remove") markSessionTaskDirty(event.sessionId);
        else if (event.kind === "reset") {
          for (const source of ["session", "subagent", "external-runtime"] as const)
            taskInboxService.scheduleRefresh(source);
        }
      }),
    );

    const reconcileSources = async () =>
      aggregator.sources(
        (await mobileOrchestrator.projectList().catch(() => [])).map((project) => project.path),
      );
    reconcileExternalAdapters = reconcileSources;

    // The topic-segment controller is created inside petInitialization once the
    // durable pet session id is known; until then the dispatch service holds a
    // stable wrapper that no-ops (beginTurn → undefined; closure → nothing).
    const segments: MimiSegments = { controller: null, closure: null };
    const longTaskStore = desktopHost.mimiTasks;
    subscriptions.push(
      longTaskStore.subscribe(() => taskInboxService.scheduleRefresh("mimi-delegation")),
    );
    // The one interpreter of Session streams (see createSessionOutcomeTap below);
    // the bound-Session bridge reads its outcomes from `sessionOutcomes`.
    const sessionOutcomeDeriver = new SessionOutcomeDeriver();
    const sessionOutcomes = createSessionOutcomeFanout();
    // Desktop external-runtime Sessions (Codex / Claude Code run here in Main).
    const externalSessions = createExternalSessionCatalog({
      runtime: () => externalRuntime.service,
      readState: (id) => sessionStore.readSessionState(id),
    });
    // Mimi's own Session id, once known: rules and watches never apply to it.
    let mimiSessionId: string | undefined;
    void petMetadata
      .ensure()
      .then((metadata) => {
        mimiSessionId = metadata.petSessionId;
        bridge.setMimiSession(mimiSessionId);
        desktopHost.setStreamView(mimiSessionId, true);
      })
      .catch(() => undefined);
    const notices = wirePetNotices({
      rules: desktopHost.mimiRules,
      ledger: nativeMimiNoticeLedger(desktopHost.callBusiness),
      userDataDir: app.getPath("userData"),
      isMimiSession: (sessionId) => sessionId === mimiSessionId,
      bridge,
      projection: aggregator,
      longTasks: longTaskStore,
      sessionRoutes: () => sessionBridge?.routes,
      gateway: imGatewayService,
      outbox: {
        publish: (event, owner) => imGatewayService.publish(event, owner),
        revoke: (deliveryKey) => imGatewayService.revoke(deliveryKey),
        state: (deliveryKey) => imGatewayService.deliveryState(deliveryKey),
      },
      notifyDesktop: async (input) => options.notifier()?.notify(input),
      readSettings: () => new SettingsManager(resolveNoRepoCwd(), "full").getForScope("user"),
      presence: {
        getSystemIdleTimeSec: () => powerMonitor.getSystemIdleTime(),
        hasFocusedWindow: () => BrowserWindow.getFocusedWindow() !== null,
      },
      powerEvents: powerMonitor,
      focusEvents: app,
      hasLiveWorker: () => bridge?.hasLiveWorker() ?? false,
      externalSessions,
      externalGoals: hostedExternalGoalNoticeSource({
        call: desktopHost.callBusiness,
        isLive: (id) => externalSessions.isLive(id),
        isRunning: (id) => externalRuntime.service?.isSessionRunning(id) === true,
      }),
      externalApprovals: {
        approvals: () => externalRuntime.approvals,
        subscribe: (listener) => externalRuntime.subscribeApprovals(listener),
      },
      onWorkerLost: (keep) => sessionOutcomeDeriver.reset(keep),
      lastUserMessage,
    });
    petNotices = notices;
    let petNoticeControls: PetNoticeControls | undefined;
    const writePetNotificationSettings = async (notifications: Record<string, unknown>) => {
      await desktopHost.callBusiness(
        "settings/patch",
        {
          scope: "user",
          patch: { pet: { notifications } },
        },
        currentMimiRuleDocument(),
      );
    };
    // Mimi's Notices / Triggers / ManageTrigger / NotificationSettings (design §4.7).
    const mimiNoticeTools = wireMimiNoticeTools({
      bridge,
      isMimiSession: (sessionId) => sessionId === mimiSessionId,
      ledger: notices.ledger,
      controls: () => petNoticeControls,
      settingsView: notices.settingsView,
      writeNotificationSettings: writePetNotificationSettings,
      channels: () => imGatewayService.ownerChannels(),
      sessionTitle: notices.sessionTitle,
      isOwnerConversation: (channel, target) =>
        imGatewayService.isOwnerConversation(channel, target),
    });
    const petWorkInbox = mimiRecords.workInbox;
    petWorkInboxStore = petWorkInbox;
    const turnStores = mimiTurnStores((command) =>
      desktopHost.callBusiness("mimi/turnStorage", command),
    );
    // Built inside petInitialization once the durable pet session id is known.

    const reports: MimiReportEndpoints = {
      get dispatcher() {
        return petDispatchService;
      },
      get receipts() {
        return petHostActionReceiptService;
      },
      windows: options.windows,
      render: renderMimiReply,
    };
    const currentSession = () => mimiSessionId;
    const longTaskCoordinator = connectMimiTasks({
      longTaskStore,
      bridge,
      imExternalSubmissions,
      options,
      petWorkDelegationHost,
      notices,
      reports,
      segments,
    });
    petImDecisions = startMimiDecisions({
      lastUserMessage,
      options,
      bridge,
      notices,
      longTaskStore,
      aggregator,
      longTaskCoordinator,
      currentSession,
    });
    // One interpretation of each Session event, handed to the long task and
    // the notice rules (see createSessionOutcomeTap). Which of them reports a
    // run is decided by the delivery plan, not by who hears of it first.
    const observeSessionOutcome = createSessionOutcomeTap(
      {
        coordinator: (sessionId, event, outcomes) =>
          void longTaskCoordinator
            .observeSessionEvent(sessionId, event, outcomes)
            .catch((error) => dlog("main", "pet.longTask.stream.failed", { error: String(error) })),
        watcher: (sessionId, outcomes) => notices.observeSessionOutcomes(sessionId, outcomes),
        stream: (sessionId, event, outcomes) => {
          notices.sessionEvent(sessionId, event);
          sessionOutcomes.emit(sessionId, event, outcomes);
        },
      },
      sessionOutcomeDeriver,
    );
    // Native worker lines and desktop external runtimes (owner window or not).
    unsubscribePetLongTaskStream = feedSessionOutcomeTap({
      sources: bridge,
      observe: observeSessionOutcome,
      deriver: sessionOutcomeDeriver,
      runtimeEnded: notices.externalRuntimeEnded,
    });
    // One root for both the Sessions disclosure tool and the resume resolver,
    // so the directory Mimi reads and the one selectors resolve against can
    // never drift apart.
    const petSessionsRootDir = sessionsRoot();
    const hostActionReceiptService: PetHostActionReceiptRecorder = {
      record: (input) => desktopHost.callBusiness("mimi/recordReceipt", input),
    };
    petHostActionReceiptService = hostActionReceiptService;
    // Briefs and the heartbeat are system schedule rules on the same scheduler.
    const petProactive = wirePetProactive({
      notices,
      state: nativeMimiProactiveState(desktopHost.callBusiness),
      cwd: resolveNoRepoCwd(),
      accounting: {
        sessionsRootDir: petSessionsRootDir,
        sessionId: () => mimiSessionId,
        purpose: "pet_brief",
      },
      externalReplyModel: createPetExternalReplyModel({
        service: () => externalRuntime.service,
        cwd: resolveNoRepoCwd(),
      }),
      tasks: async () => (await longTaskStore.getSnapshot()).tasks,
      projection: () => aggregator.getSnapshot(),
      log: (event, data) => dlog("main", event, data),
    });
    // Follow-ups are schedule rules; the old follow-ups.json is deleted, not migrated.
    subscriptions.push(() => petProactive.dispose());
    const followUpRuntime = createPetFollowUpRules({
      fireSystem: () => petProactive.fire,
      rules: notices.ruleStore,
      makeScheduler: (fire) => nativeMimiScheduler.configure(fire),
      sessions: () => aggregator.getSnapshot().sessions,
      makeViews: (registered) => nativeMimiFollowUps(desktopHost.callBusiness, registered),
      tasks: longTaskStore,
      longTasks: longTaskCoordinator,
      submitNotice: notices.submitNotice,
      dispatch: () => petDispatchService,
      onError: (error) => dlog("main", "pet.followUp.wake.failed", { error: String(error) }),
      log: (event, data) => dlog("main", event, data),
    });
    const { petFollowUps, followUpHost } = followUpRuntime;
    petRuleScheduler = followUpRuntime.coordinator;
    // Entering a Work Session from a chat: the store, bridge, bind executor
    // and reply delivery are composed in session-bridge-wiring.ts so this
    // root only names the collaborators it already owns.
    const worker = bridge;
    sessionBridge = createSessionBridgeWiring({
      routes: nativeMimiConversationRoutes(desktopHost.callBusiness),
      resolveSelector: createReusableSessionResolver(petSessionsRootDir),
      createRunner: (onTurn) =>
        createBoundSessionRunner(worker, aggregator, onTurn, sessionOutcomes, {
          external: {
            isExternal: imExternalSubmissions.isExternal,
            isRunning: imExternalSubmissions.isRunning,
            run: imExternalSubmissions.runBound,
            stop: imExternalSubmissions.stop,
          },
        }),
      health: createBoundSessionHealth(aggregator, petSessionsRootDir),
      describeStatus: async (route) => `当前在「${route.sessionTitle}」中。发送 /mimi 可退出。`,
      publish: (event) => publishGatewayControlEvent(event),
      // The conversations a turn's reply goes to come from the delivery plan.
      replyRoutes: (sessionId) => notices.deliveries.replyRoutes(sessionId),
      onDeliveryError: (error, turn) =>
        dlog("main", "pet.session.reply.retry", {
          sessionId: turn.sessionId,
          turnId: turn.turnId,
          error: String(error),
        }),
    });
    const sessionRoutesReady = sessionBridge.recoverOnStartup().catch(() => undefined);
    petDispatchService = connectMimiDispatch({
      desktopHost,
      bridge,
      sessionStore,
      options,
      segments,
      followUpRuntime,
      mimiNoticeTools,
      notices,
      aggregator,
      longTaskStore,
      longTaskCoordinator,
      sessionBridge,
    });
    unsubscribePetReportStream = subscribeMimiReports({
      bridge,
      longTaskStore,
      reports,
      turnStores,
      notices,
    });
    const lifecycle = new AbortController();
    subscriptions.push(() => lifecycle.abort());
    const petInitialization = (async () => {
      await Promise.all([followUpRuntime.ready, sessionRoutesReady]);
      lifecycle.signal.throwIfAborted();
      void petProactive.start();
      await aggregator.start();
      await reconcileSources();
      await Promise.all([
        notices.ready,
        petWorkInbox.load(),
        turnStores.receipts.load(),
        petWorkMemory.load(),
      ]);
      lifecycle.signal.throwIfAborted();
      await hydrateMimiWorkMemory({
        bridge,
        desktopHost,
        petWorkMemory,
        mimiRecords,
        segments,
      });
      // Load/reconcile durable long tasks only after both the session projection
      // and work-memory closure sink are ready. Running tasks left idle by a
      // previous process are marked interrupted and remain resumable.
      lifecycle.signal.throwIfAborted();
      await longTaskCoordinator.start();
      lifecycle.signal.throwIfAborted();
      notices.router.start();
      // Auto-archive completed work sessions idle for 7+ days, then force a full
      // catalog rebuild. Rationale for the full pass: archiveDiskSession touches
      // state.json → bumps the session's dir mtime → the incremental
      // (mtime high-water) refresh would re-surface it at the front, yet
      // listDiskSessions now default-filters archived rows, so the freshly
      // archived session would be *dropped from the incremental page but never
      // evicted from the held diskSessions Map* — a persistent ghost. A full
      // rebuild repopulates the Map straight from the (archive-filtered)
      // listDiskSessions result, so archived sessions cleanly disappear.
      void runPetAutoArchive(aggregator, options).catch((error) => {
        dlog("main", "pet.autoArchive.failed", { error: String(error) });
      });
    })();
    disposePetIpc = registerPetIpc({
      ipcMain: mimiWindowIpc(
        ipcMain,
        options.windows,
        desktopHost.documentSignal,
        petInitialization,
      ),
      aggregator,
      dispatcher: petDispatchService,
      attention: notices.attention,
      notices: (petNoticeControls = createPetNoticeControls({
        notices,
        ownerChannels: () => imGatewayService.ownerChannels(),
        goals: sessionStore,
        proactive: () => petProactive.status(),
        writeNotificationSettings: writePetNotificationSettings,
        cancelFollowUp: (followUpId, expectedRevision) =>
          followUpHost({ action: "cancel", followUpId, expectedRevision }),
      })),
      workInbox: petWorkInbox,
      // Read-only topic-segment view for the Mimi chat UI. `segments` carries
      // the message-keyed boundary history (keyed by each segment's first-turn
      // client message id); the renderer skips any boundary whose message id is
      // absent from the current transcript.
      workMemory: {
        getActiveSegmentId: () => petWorkMemory.activeSegment()?.id ?? null,
        getSegments: () => petWorkMemory.segmentBoundaries(),
      },
      longTasks: {
        getSnapshot: () => longTaskStore.getSnapshot(),
        control: (request, signal) => longTaskCoordinator.control(request, signal),
        clearTerminal: (signal) => longTaskCoordinator.clearTerminal(signal),
        clearTask: (taskId, signal) => longTaskCoordinator.clearTerminalTask(taskId, signal),
        subscribe: (listener) => longTaskStore.subscribe(listener),
      },
      memories: mimiRecords.interactive,
      recordAuthority: (event) => desktopHost.documentSignal(event as Electron.IpcMainInvokeEvent),
      recordWindows: () => trustedMimiWindows(mainWindows, appRendererNavigation),
      summaries: {
        collect: (signal) => petFollowUps.collect(undefined, signal),
        control: (request, signal) => followUpHost({ ...request }, undefined, signal),
        subscribe: followUpRuntime.subscribe,
      },
      journal: {
        ...mimiRecords.journal,
        readSegmentMessages: async (range) =>
          segments.closure ? segments.closure.readSegmentMessages(range) : [],
      },
      preferences: {
        getAutoExtract: async () =>
          petMemoryAutoExtractFromSettings(await readSettings("user").catch(() => null)),
        setAutoExtract: async (enabled) => {
          await desktopHost.callBusiness("settings/patch", {
            scope: "user",
            patch: petMemoryAutoExtractSettingsPatch(enabled),
          });
          return enabled;
        },
      },
      sessionArchive: {
        archive: async (sessionId) => {
          // By-id archive must not be limited to a page of recent sessions.
          const sessions = await listAllDiskSessions();
          const session = sessions.find(
            (candidate) =>
              candidate.engineSessionId === sessionId && candidate.origin === "desktop",
          );
          if (!session) throw new Error("Session 不存在或不允许归档");
          if (session.archivedAt === undefined) {
            await archiveDiskSession(session.engineSessionId, Date.now());
            await aggregator.refreshCatalog(true, { full: true });
          }
          return { ok: true };
        },
      },
      hostActionReceipt: hostActionReceiptService,
      windows: options.windows,
      ready: petInitialization,
    });
    const disposePetIpcRoutes = disposePetIpc;
    disposePetIpc = () => {
      mimiNoticeTools.dispose();
      disposePetIpcRoutes();
    };
    // The renderer immediately publishes its active session and reads Mimi's
    // state. Register those handlers before loading it; handlers themselves
    // await hydration, so the interface can still load while indexes recover.
    loadRenderer();
    await petInitialization;
    petRuntimeReady = petDispatchService !== null;
  }
  function stop() {
    petRuntimeReady = false;
    for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    petStateAggregator?.stop();
    petStateAggregator = null;
    reconcileExternalAdapters = null;
    petDispatchService = null;
    petRuleScheduler?.stop();
    petRuleScheduler = null;
    petHostActionReceiptService = null;
    petImDecisions?.stop();
    petImDecisions = null;
    unsubscribePetLongTaskStream?.();
    unsubscribePetLongTaskStream = null;
    unsubscribePetReportStream?.();
    unsubscribePetReportStream = null;
    const petNoticeFlush = petNotices?.flush();
    petNotices?.dispose();
    petNotices = null;
    const petWorkInboxFlush = petWorkInboxStore?.flush();
    petWorkInboxStore = null;

    disposePetIpc?.();
    disposePetIpc = null;
    sessionBridge = undefined;
    return [petNoticeFlush, petWorkInboxFlush];
  }

  return {
    start,
    stop,
    withdraw() {
      petRuntimeReady = false;
    },
    get projection() {
      return petStateAggregator;
    },
    get dispatcher() {
      return petDispatchService;
    },
    get notices() {
      return petNotices;
    },
    get decisions() {
      return petImDecisions;
    },
    get sessions() {
      return sessionBridge;
    },
    get ready() {
      return petRuntimeReady && petDispatchService !== null;
    },
    startRules: () => petRuleScheduler?.start(),
    async reconcileSources() {
      await reconcileExternalAdapters?.();
    },
  };
}
