/**
 * Main Ink App — the root component for Code Shell's terminal UI.
 *
 * Uses AgentClient (protocol layer) instead of Engine directly.
 * All engine interaction goes through the client-server protocol.
 */
import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, forceRedraw } from "../render/index.js";
import { Banner } from "./components/Banner.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { WelcomeTips } from "./components/WelcomeTips.js";
import { TaskList } from "./components/TaskList.js";
import { SpinnerWithVerb } from "./components/SpinnerWithVerb.js";
import { StatusLine } from "./components/StatusLine.js";
import { FullscreenLayout, useUnseenDivider } from "./components/FullscreenLayout.js";
import {
  VirtualMessageList,
  type VirtualMessageListHandle,
} from "./components/VirtualMessageList.js";
import { FullscreenModeContext, INITIAL_FULLSCREEN_MODE } from "./fullscreen-mode.js";
import { AgentClient } from "@cjhyy/code-shell-core";
import { costTracker } from "@cjhyy/code-shell-core";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import type { ModelEntry } from "./components/ModelSelector.js";
import type {
  ArenaParticipantEntry,
  ProviderManagerEntry,
} from "./components/ModelManager.js";
import type { SessionPickerEntry } from "./components/SessionPicker.js";
import {
  TuiControlSurface,
  type ModelManagerState,
  type PendingQuestion,
} from "./components/TuiControlSurface.js";
import { CommandRegistry } from "../cli/commands/registry.js";
import type { RestoredChatEntry } from "../cli/commands/registry.js";
import { QueryGuard } from "./query-guard.js";
import { AgentDock, getVisibleAgents, MAX_VISIBLE } from "./components/AgentDock.js";
import { asyncAgentRegistry } from "@cjhyy/code-shell-core";
import {
  notificationQueue,
  buildNotificationMessage,
  buildNotificationSummary,
} from "@cjhyy/code-shell-core";
import { coreCommands } from "../cli/commands/builtin/core-commands.js";
import { gitCommands } from "../cli/commands/builtin/git-commands.js";
import { permissionsCommand } from "../cli/commands/builtin/permissions-command.js";
import { featuresCommand } from "../cli/commands/builtin/features-command.js";
import { utilityCommands } from "../cli/commands/builtin/utility-commands.js";
import { advancedCommands } from "../cli/commands/builtin/advanced-commands.js";
import { extraCommands } from "../cli/commands/builtin/extra-commands.js";
import { moreCommands } from "../cli/commands/builtin/more-commands.js";
import {
  goalCommand,
} from "../cli/commands/builtin/goal-command.js";
import { imageCommand } from "../cli/commands/builtin/image-command.js";
import { buildPluginSlashCommands } from "../cli/commands/builtin/plugin-commands-registration.js";
import type { ApprovalRequest, StreamEvent, TaskInfo } from "@cjhyy/code-shell-core";
import { chatStore, createEntry, type ChatEntry } from "./store.js";
import {
  nextPermissionMode,
  permissionConfigurePayload,
  type TuiPermissionMode,
} from "./permission-mode.js";
import { formatDuration, formatTokens } from "@cjhyy/code-shell-core";
import { removeLastFromHistory } from "./input-history.js";
import { logger } from "@cjhyy/code-shell-core";
import { recordUIEvent } from "@cjhyy/code-shell-core";
import {
  recordAppRender,
  recordStreamEvent,
  startAllPerfProbes,
  stopAllPerfProbes,
} from "./perf-probes.js";
import {
  ModeIndicator,
  canExecuteCommandWhileRunning,
  classifyError,
  dispatchSlashCommandSafely,
  findLastIndex,
  formatCommandError,
  friendlyError,
  friendlyReason,
  goalEventMatchesActive,
  goalUpdateResponseIsFresh,
  renderEntry,
  shouldAppendThinkingDeltaToMainFeed,
  shouldApplyGoalUpdateEvent,
  shouldDrainBackgroundNotifications,
  shouldSuppressCancelledMainStreamEvent,
  shouldTraceStreamEvent,
  streamDiagnosticsEnabled,
} from "./app-helpers.js";

export {
  canExecuteCommandWhileRunning,
  dispatchSlashCommandSafely,
  goalEventMatchesActive,
  goalUpdateResponseIsFresh,
  renderEntry,
  shouldAppendThinkingDeltaToMainFeed,
  shouldDrainBackgroundNotifications,
  shouldSuppressCancelledMainStreamEvent,
} from "./app-helpers.js";

// UI-scoped child logger — system-log lines route to ui-ink-*.log so engine
// traces aren't drowned by 200ms spinner ticks and per-stream-event logs.
// Per-session UI events go through recordUIEvent (writes to ui.jsonl + the
// unified engine.jsonl) so display bugs can be aligned with LLM responses
// by sid.
const uiLog = logger.child({ cat: "ui" });
const STREAM_DIAG_ON = streamDiagnosticsEnabled();

// ─── Global command registry ────────────────────────────────────

const commandRegistry = new CommandRegistry();
commandRegistry.registerAll(coreCommands);
commandRegistry.registerAll(gitCommands);
commandRegistry.register(permissionsCommand);
commandRegistry.register(featuresCommand);
commandRegistry.registerAll(utilityCommands);
commandRegistry.registerAll(advancedCommands);
commandRegistry.registerAll(extraCommands);
commandRegistry.registerAll(moreCommands);
commandRegistry.register(imageCommand);
commandRegistry.register(goalCommand);
commandRegistry.registerAll(buildPluginSlashCommands());

// ChatEntry types and createEntry() are in ./store.ts
const entry = createEntry;

// ─── Props ───────────────────────────────────────────────────────

interface AppProps {
  client: AgentClient;
  model: string;
  effort: string;
  maxTurns: number;
  cwd: string;
  maxContextTokens: number;
  sessionId?: string;
  /** Pre-fill the input box without submitting (--prefill flag). */
  prefill?: string;
  /** Optional lifecycle guard injection for focused UI tests. */
  queryGuard?: QueryGuard;
}

export function App({
  client,
  model: initialModel,
  effort,
  maxTurns,
  cwd,
  maxContextTokens,
  sessionId: initialSessionId,
  prefill,
  queryGuard: providedQueryGuard,
}: AppProps) {
  // Perf probe: count every App body invocation. Pairs with the 1s
  // aggregator in perf-probes.ts to expose re-render storms.
  recordAppRender();

  const { exit } = useApp();
  // Fullscreen toggle — driven by /fullscreen at runtime. Initial value from
  // CODESHELL_FULLSCREEN env. Provided to subtree via FullscreenModeContext.
  const [fullscreen, setFullscreenState] = useState<boolean>(INITIAL_FULLSCREEN_MODE);
  const fullscreenModeValue = useMemo(
    () => ({
      fullscreen,
      setFullscreen: (next: boolean) => setFullscreenState(next),
      toggleFullscreen: () => setFullscreenState((p) => !p),
    }),
    [fullscreen],
  );
  const [input, setInput] = useState(prefill ?? "");
  const [queuedInputs, setQueuedInputs] = useState<string[]>([]);
  const chatLog = useSyncExternalStore(
    chatStore.subscribe.bind(chatStore),
    chatStore.getEntries.bind(chatStore),
  );
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const tasksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (
      tasks.length > 0 &&
      tasks.every((t) => t.status === "completed" || t.status === "stopped")
    ) {
      tasksTimerRef.current = setTimeout(() => setTasks([]), 3000);
    }
    return () => {
      if (tasksTimerRef.current) clearTimeout(tasksTimerRef.current);
    };
  }, [tasks]);

  const queryGuard = useRef(providedQueryGuard ?? new QueryGuard()).current;
  const isQueryActive = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot);
  const hasRunningBgAgents = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.hasRunning,
  );
  const isRunning = isQueryActive || hasRunningBgAgents;

  type ViewMode = { kind: "main" } | { kind: "agent"; agentId: string };
  const [viewMode, setViewMode] = useState<ViewMode>({ kind: "main" });
  const [dockFocusIdx, setDockFocusIdx] = useState<number | null>(null);

  const agentsSnapshot = useSyncExternalStore(
    asyncAgentRegistry.subscribe,
    asyncAgentRegistry.getSnapshot,
  );
  useEffect(() => {
    if (viewMode.kind !== "agent") return;
    const entry = agentsSnapshot.find((a) => a.agentId === viewMode.agentId);
    if (!entry || entry.status !== "running") {
      setViewMode({ kind: "main" });
    }
  }, [agentsSnapshot, viewMode]);

  // Switching viewMode swaps the entries array wholesale (main chat ↔ a
  // sub-agent transcript). In flow mode log-update's shrinking path only
  // erases within the viewport via eraseLines — if the prior view rendered
  // more rows than the new view, the trailing rows (the "extra tail") stay
  // on screen as residue. Force a viewport clear at the boundary so the
  // new view starts on a blank viewport and naturally lays out from the
  // top. Scrollback is preserved so the user can still scroll up to see
  // earlier history of this or the prior view.
  //
  // Skip the initial mount: there's nothing rendered yet to clear.
  const viewKey = viewMode.kind === "main" ? "main" : `agent:${viewMode.agentId}`;
  const viewKeyMountedRef = useRef(false);
  useEffect(() => {
    if (!viewKeyMountedRef.current) {
      viewKeyMountedRef.current = true;
      return;
    }
    forceRedraw();
  }, [viewKey]);

  // Clamp dockFocusIdx whenever the visible dock shrinks (an agent finishes
  // and its fade window expires, or the list empties entirely). maxIdx is
  // INCLUSIVE: index 0 is the main row (always valid when len > 0), and
  // 1..min(MAX_VISIBLE, len) are agent rows.
  useEffect(() => {
    if (dockFocusIdx === null) return;
    const len = getVisibleAgents(agentsSnapshot, Date.now()).length;
    if (len === 0) {
      setDockFocusIdx(null);
      return;
    }
    const maxIdx = Math.min(MAX_VISIBLE, len);
    if (dockFocusIdx > maxIdx) setDockFocusIdx(maxIdx);
  }, [agentsSnapshot, dockFocusIdx]);

  const [sessionId, setSessionId] = useState(initialSessionId);
  // Mirror of sessionId for synchronous reads inside event handlers.
  // recordUIEvent needs the current sid every time it fires, but
  // handleStreamEvent is memoized without sessionId in its deps; reading from
  // a ref avoids re-creating the handler on every session change.
  const sidRef = useRef<string | undefined>(initialSessionId);
  useEffect(() => {
    sidRef.current = sessionId;
  }, [sessionId]);
  const [model, setModel] = useState(initialModel);
  const [activeMaxContextTokens, setActiveMaxContextTokens] = useState(maxContextTokens);
  const pendingContextRef = useRef<string | null>(null);
  // Image attachments staged by the `/image` command, drained on next
  // submitToEngine. See `cli/commands/builtin/image-command.ts`.
  const pendingImagesRef = useRef<string[]>([]);
  // Best-effort mirror of the session's active goal objective for /goal status.
  // Set when /goal submits one, cleared on /goal clear or a goal_progress(met).
  const activeGoalRef = useRef<string | null>(null);
  const activeGoalIdRef = useRef<string | null>(null);
  const activeGoalRevisionRef = useRef<number | null>(null);
  const activeGoalPausedRef = useRef(false);
  const activeGoalLegacyRef = useRef(false);
  const activeGoalSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  // Invalidates a slower goalGet hydrate whenever a stream/local control has
  // already supplied newer state for the same session.
  const goalMirrorEpochRef = useRef(0);

  useEffect(() => {
    const hydrateSessionId = sessionId;
    const epoch = ++goalMirrorEpochRef.current;
    if (!hydrateSessionId) {
      activeGoalRef.current = null;
      activeGoalIdRef.current = null;
      activeGoalRevisionRef.current = null;
      activeGoalPausedRef.current = false;
      activeGoalLegacyRef.current = false;
      activeGoalSessionIdRef.current = null;
      return;
    }
    if (activeGoalSessionIdRef.current !== hydrateSessionId) {
      activeGoalRef.current = null;
      activeGoalIdRef.current = null;
      activeGoalRevisionRef.current = null;
      activeGoalPausedRef.current = false;
      activeGoalLegacyRef.current = false;
      activeGoalSessionIdRef.current = hydrateSessionId;
    }
    void client
      .goalGetState(hydrateSessionId)
      .then((goal) => {
        if (
          goalMirrorEpochRef.current !== epoch ||
          sidRef.current !== hydrateSessionId ||
          activeGoalSessionIdRef.current !== hydrateSessionId
        ) {
          return;
        }
        activeGoalRef.current = goal?.objective ?? null;
        activeGoalIdRef.current = goal?.goalId ?? null;
        activeGoalRevisionRef.current = goal?.revision ?? null;
        activeGoalPausedRef.current = goal?.paused === true;
        activeGoalLegacyRef.current =
          !!goal && (goal.goalId === undefined || goal.revision === undefined);
      })
      .catch((error) => {
        uiLog.warn("goal hydrate failed", {
          sessionId: hydrateSessionId,
          error: formatCommandError(error),
        });
      });
  }, [client, sessionId]);
  const [showBanner, setShowBanner] = useState(true);
  const [totalTokens, setTotalTokens] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [contextTokens, setContextTokens] = useState(0);
  const [currentEffort, setCurrentEffort] = useState(effort);
  const [permMode, setPermMode] = useState<TuiPermissionMode>("normal");
  const [pendingApproval, setPendingApproval] = useState<{
    requestId: string;
    toolName: string;
    description: string;
    riskLevel: string;
    args: Record<string, unknown>;
  } | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [modelEntries, setModelEntries] = useState<ModelEntry[] | null>(null);
  const [sessionEntries, setSessionEntries] = useState<SessionPickerEntry[] | null>(null);
  const [modelManager, setModelManager] = useState<ModelManagerState | null>(null);
  // Whether the unified ProviderModelFlow is on top of the ModelManager.
  // The flow re-fetches the manager state on finish so the list updates
  // without closing the manager.
  const [wizard, setWizard] = useState<"flow" | null>(null);

  // Track live streamed token count in a ref — no App-level re-render per tick.
  // Provider emits tokens per text delta (real cl100k_base count, not chars/4).
  // StatusLine reads this ref directly via its own internal interval.
  const streamingTokensRef = useRef(0);
  const runStartRef = useRef(0);
  const [streamMode, setStreamMode] = useState<"responding" | "tool-use" | "thinking">("thinking");
  const [thinkingContent, setThinkingContent] = useState<string | null>(null);
  // Optimistic-cancel guard — set true on ESC so the in-flight `await
  // client.run()` resolution (which can arrive 1–7s later, after the LLM
  // SDK tears down its socket) does NOT push a duplicate "aborted" /
  // turn-duration / status entry into chat. Cleared at the top of each new
  // submit.
  const cancelledRef = useRef(false);
  /** Monotonic cancellation fence captured independently by each local run. */
  const cancellationEpochRef = useRef(0);
  /** Local Run whose transport response has not been parsed yet. */
  const localRunTokenRef = useRef<number | null>(null);
  /** Cancelled local requests whose late stream may still precede their response. */
  const cancelledLocalRunTokensRef = useRef(new Set<number>());
  /** External run cancelled optimistically but not yet at its turn_complete boundary. */
  const cancelledExternalRunPendingRef = useRef(false);

  // P1.6: Transcript mode — toggle between prompt and read-only transcript view
  const [screen, setScreen] = useState<"prompt" | "transcript">("prompt");
  // P1.8: Message selector cursor
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);

  // Session persistence is owned by the server-side Engine; the client only
  // tracks `sessionId` for display and for re-passing on subsequent runs.

  // Unseen message divider tracking
  const {
    dividerIndex,
    showPill,
    unseenCount,
    onScrollAway,
    onScrollToBottom: clearUnseen,
  } = useUnseenDivider(chatLog.length);
  // Imperative handle on VirtualMessageList so we can scroll the list to
  // the bottom when the user dismisses the "N new messages" pill or
  // submits a new turn.
  const listRef = useRef<VirtualMessageListHandle | null>(null);
  const onScrollToBottom = useCallback(() => {
    clearUnseen();
    listRef.current?.scrollToBottom();
  }, [clearUnseen]);

  useEffect(() => {
    if (isRunning) {
      runStartRef.current = Date.now();
    }
    uiLog.info("debug.app.isRunning_change", {
      isRunning,
      isQueryActive,
      hasRunningBgAgents,
      runStartRef: runStartRef.current,
    });
  }, [isRunning, isQueryActive, hasRunningBgAgents]);

  // Flicker investigation: log every change to the two sources of isRunning
  // independently, so we can tell whether a phantom "running" state is the
  // query path or a stuck background agent.
  useEffect(() => {
    uiLog.info("flicker.isQueryActive_change", { isQueryActive });
  }, [isQueryActive]);
  useEffect(() => {
    uiLog.info("flicker.hasRunningBgAgents_change", {
      hasRunningBgAgents,
      agents: agentsSnapshot.map((a) => ({
        id: a.agentId,
        name: a.name,
        status: a.status,
      })),
    });
  }, [hasRunningBgAgents, agentsSnapshot]);

  // Perf probes — mount once, kill on unmount.
  useEffect(() => {
    startAllPerfProbes();
    return () => stopAllPerfProbes();
  }, []);

  // ─── Wire client events ───────────────────────────────────────

  useEffect(() => {
    // Handle approval requests from the server
    const handleApproval = (requestId: string, request: ApprovalRequest) => {
      // __ask_user__ is a question, not a tool approval — routed to the
      // text-input prompt instead of the y/n permission dialog. Optional
      // multiple-choice metadata travels along in the request args.
      if (request.toolName === "__ask_user__") {
        const args = request.args ?? {};
        const rawOptions = (args as { options?: unknown }).options;
        const options =
          Array.isArray(rawOptions) &&
          rawOptions.every(
            (o) =>
              typeof o === "object" &&
              o !== null &&
              typeof (o as { label?: unknown }).label === "string" &&
              typeof (o as { description?: unknown }).description === "string",
          )
            ? (rawOptions as { label: string; description: string }[])
            : undefined;
        setPendingQuestion({
          requestId,
          question: request.description,
          header:
            typeof (args as { header?: unknown }).header === "string"
              ? (args as { header: string }).header
              : undefined,
          options,
          multiSelect: (args as { multiSelect?: unknown }).multiSelect === true,
        });
        return;
      }

      setPendingApproval({
        requestId,
        toolName: request.toolName,
        description: request.description,
        riskLevel: request.riskLevel,
        args: request.args,
      });
    };

    client.onApprovalRequest(handleApproval);
    return () => client.offApprovalRequest(handleApproval);
  }, [client]);

  // ─── Text delta buffering ──────────────────────────────────────
  const textBufferRef = useRef<Map<string | undefined, string>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Throttle ref for "we dropped a sub-agent text_delta" log so it doesn't
  // drown the bucket at 30/s. One sampled log per second is enough to see
  // whether the deltas during a perceived stall are main or sub-agent.
  const subAgentDeltaSampleRef = useRef<number>(0);
  // Thinking delta buffer — same shape as textBuffer. Without this, every
  // thinking token (50–200/s on some providers) triggered a synchronous
  // setThinkingContent → App re-render → spinner subtree re-commit. The
  // memoized SpinnerWithVerb couldn't help because its comparator on
  // truncateThinking() flipped on most tokens. Coalesce to 50 ms so the
  // spinner Box only re-renders ~20×/s regardless of token rate.
  const thinkingBufferRef = useRef<string>("");
  const thinkingFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushThinkingBuffer = useCallback(() => {
    thinkingFlushTimerRef.current = null;
    if (thinkingBufferRef.current.length === 0) return;
    const pending = thinkingBufferRef.current;
    thinkingBufferRef.current = "";
    setThinkingContent((prev) => (prev ?? "") + pending);
  }, []);
  /** Drop any pending thinking buffer + timer. Pair with setThinkingContent(null). */
  const clearThinkingBuffer = useCallback(() => {
    thinkingBufferRef.current = "";
    if (thinkingFlushTimerRef.current) {
      clearTimeout(thinkingFlushTimerRef.current);
      thinkingFlushTimerRef.current = null;
    }
  }, []);

  // Diagnostic: previous flush completion time. Records the gap between
  // flushes so a stuck stream (text_delta arrives but the chatStore never
  // updates) shows up as a long flushGap in the log. Lets us distinguish
  // "model paused" (text_delta gap) from "UI froze" (text_delta keeps
  // coming, but flush gap is long).
  const lastFlushAtRef = useRef<number>(0);
  // Wall-clock when the most recent setTimeout(flushTextBuffer, 50) was
  // scheduled. flush handler reads this and reports `timerDelayOverSchedule_ms`
  // = (actualFireTime - scheduleTime - 50). If that's >> 0 the event loop
  // was blocked between scheduling and firing — typically by markdown
  // parse running in a parent commit phase.
  const flushScheduledAtRef = useRef<number>(0);
  // Cumulative wall time spent inside chatStore.update's fn (the synchronous
  // entries-array rebuild). Lets us see if the slowdown is in fn, in
  // notify(), or somewhere else (React reconcile / Ink render).
  const flushUpdateMsRef = useRef<number>(0);

  const flushTextBuffer = useCallback(() => {
    const flushEnter = Date.now();
    flushTimerRef.current = null;
    const buf = textBufferRef.current;
    if (buf.size === 0) {
      flushScheduledAtRef.current = 0;
      return;
    }

    const pending = new Map(buf);
    buf.clear();

    const gap =
      STREAM_DIAG_ON && lastFlushAtRef.current !== 0 ? flushEnter - lastFlushAtRef.current : 0;
    const scheduledAt = flushScheduledAtRef.current;
    const timerDelay =
      STREAM_DIAG_ON && scheduledAt !== 0
        ? flushEnter - scheduledAt - 50 // 50 = setTimeout target
        : 0;
    flushScheduledAtRef.current = 0;
    lastFlushAtRef.current = flushEnter;
    let pendingChars = 0;
    if (STREAM_DIAG_ON) {
      for (const v of pending.values()) pendingChars += v.length;
    }

    const updateStart = STREAM_DIAG_ON ? performance.now() : 0;

    chatStore.update((prev) => {
      let next = prev;
      for (const [agentId, deltaText] of pending) {
        const lastIdx = findLastIndex(
          next,
          (e) => e.type === "assistant_text" && e.streaming && e.agentId === agentId,
        );
        if (lastIdx >= 0) {
          const last = next[lastIdx] as ChatEntry & { type: "assistant_text" };
          next = [...next];
          next[lastIdx] = { ...last, text: last.text + deltaText };
        } else {
          next = [
            ...next.filter((e) => !(e.type === "thinking" && e.agentId === agentId)),
            entry({ type: "assistant_text", text: deltaText, streaming: true, agentId }),
          ];
        }
      }
      return next;
    });
    flushUpdateMsRef.current = STREAM_DIAG_ON ? performance.now() - updateStart : 0;

    if (STREAM_DIAG_ON) {
      uiLog.info("debug.ui.flush", {
        agents: Array.from(pending.keys()).map((k) => k ?? "(main)"),
        chars: pendingChars,
        gapSinceLastFlush_ms: gap,
        timerDelayOverSchedule_ms: Math.max(0, timerDelay),
        chatStoreUpdate_ms: Math.round(flushUpdateMsRef.current * 10) / 10,
      });
    }
  }, []);

  /** Commit the shared stream presentation state at a top-level turn boundary. */
  const finalizeStreamPresentation = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    flushTextBuffer();
    chatStore.update((prev) =>
      prev
        .filter((e) => e.type !== "thinking" && e.type !== "tool_running")
        .map((e) => (e.type === "assistant_text" && e.streaming ? { ...e, streaming: false } : e)),
    );
    setStreamMode("thinking");
    setThinkingContent(null);
    clearThinkingBuffer();
  }, [clearThinkingBuffer, flushTextBuffer]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (thinkingFlushTimerRef.current) clearTimeout(thinkingFlushTimerRef.current);
    };
  }, []);

  // ─── Stream event handler (wired to client) ───────────────────

  const handleStreamEvent = useCallback(
    (event: StreamEvent, sourceSessionId?: string) => {
      const agentId = (event as any).agentId as string | undefined;
      recordStreamEvent(event.type, agentId);
      if (shouldSuppressCancelledMainStreamEvent(cancelledRef.current, event)) return;
      // session_started carries the authoritative sid; use it directly so the
      // record lands in the correct dir even before sidRef has caught up.
      const eventSid = event.type === "session_started" ? event.sessionId : sidRef.current;
      if (shouldTraceStreamEvent(event.type)) {
        uiLog.debug("debug.stream.event", { type: event.type, agentId });
        recordUIEvent(eventSid, "ui.stream_event", { type: event.type, agentId });
      }

      switch (event.type) {
        case "session_started":
          if (agentId !== undefined) break;
          // Server tells us the authoritative sid up-front so /sid works
          // mid-turn. setSessionId at run-completion (line ~672) still runs
          // but is now redundant for the first run; resumed runs already
          // had the sid from initialSessionId.
          sidRef.current = event.sessionId;
          setSessionId(event.sessionId);
          // Goal Resume and background wakeups are server-driven turns rather
          // than client.run promises. Reflect them in the same guard so input,
          // Steer routing and ESC cancel semantics stay identical.
          // A pending local Run owns its own session_started even if ESC already
          // released the UI guard. Its exact response clears this ref before a
          // queued external session_started can be parsed.
          if (localRunTokenRef.current === null && queryGuard.startExternal() !== null) {
            cancelledRef.current = false;
          }
          // Engine only sends promptTokens > 0 on the first turn of a sid
          // (cold start / cross-process resume). On subsequent turns it sends
          // 0 to avoid clobbering the accurate value we already have from the
          // previous turn's usage_update.
          if (event.promptTokens > 0) {
            uiLog.info("debug.ctx.set", { from: "session_started", value: event.promptTokens });
            recordUIEvent(event.sessionId, "ui.ctx.set", {
              from: "session_started",
              value: event.promptTokens,
            });
            setContextTokens(event.promptTokens);
          }
          break;

        case "turn_complete":
          if (agentId === undefined && queryGuard.endExternal()) {
            finalizeStreamPresentation();
          }
          if (agentId === undefined && cancelledExternalRunPendingRef.current) {
            cancelledExternalRunPendingRef.current = false;
            if (cancelledLocalRunTokensRef.current.size === 0) cancelledRef.current = false;
          }
          break;

        case "stream_request_start":
          // Sub-agent stream events surface via AgentDock + agent_start/end
          // markers; don't add per-sub-agent thinking rows to the main feed.
          if (agentId !== undefined) break;
          setStreamMode("thinking");
          setThinkingContent(null);
          clearThinkingBuffer();
          // Reset the spinner's "alive" counter at the top of each LLM call.
          // Tracks output of the current call only; ctx size is the bar's job.
          streamingTokensRef.current = 0;
          chatStore.update((prev) => {
            const filtered = prev.filter((e) => !(e.type === "thinking" && e.agentId === agentId));
            return [...filtered, entry({ type: "thinking", agentId })];
          });
          break;

        case "thinking_delta":
          if (!shouldAppendThinkingDeltaToMainFeed(agentId)) break;
          thinkingBufferRef.current += event.text;
          if (!thinkingFlushTimerRef.current) {
            thinkingFlushTimerRef.current = setTimeout(flushThinkingBuffer, 50);
          }
          break;

        case "text_delta": {
          // Same rationale as stream_request_start: sub-agent assistant text
          // is for the dock / detail view, not the main feed. We log every
          // delta we DROP (agentId != undefined) so a user's "main agent
          // is stuck" report can be verified against agentId — if the log
          // shows only sub-agent drops during the freeze, the main feed
          // is correctly idle (sub-agent is doing the work). If main-agent
          // deltas are present but flush gap is large, it's a real
          // pipeline stall.
          if (agentId !== undefined) {
            // Sample at most once per second to keep the log readable.
            const last = subAgentDeltaSampleRef.current ?? 0;
            const now = Date.now();
            if (now - last > 1000) {
              subAgentDeltaSampleRef.current = now;
              uiLog.debug("debug.ui.text_delta_dropped", { agentId });
            }
            break;
          }
          setStreamMode("responding");
          const existing = textBufferRef.current.get(agentId) ?? "";
          textBufferRef.current.set(agentId, existing + event.text);
          streamingTokensRef.current += event.tokens ?? 0;
          if (!flushTimerRef.current) {
            flushScheduledAtRef.current = Date.now();
            flushTimerRef.current = setTimeout(flushTextBuffer, 50);
            // Flicker probe: count text-delta arrivals into the flush window
            // so we can spot whether a runaway stream is jamming the
            // renderer with high-rate setStates. Opt-in only: this path is
            // hot during normal streaming.
            if (STREAM_DIAG_ON) {
              uiLog.info("flicker.text_delta_arrival", {
                cat: "flicker",
                chunkLen: event.text.length,
                tokens: event.tokens ?? 0,
              });
            }
          }
          break;
        }

        case "tool_use_start": {
          setStreamMode("tool-use");
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          flushTextBuffer();

          // Hide sub-agent tool calls from the conversation feed — the
          // user only wants to see what the *main* agent is doing plus
          // task statuses, not every Read/Grep a child fires off. The
          // sub-agent's text output and the task panel still surface.
          if (agentId !== undefined) break;

          const tc = event.toolCall;
          chatStore.update((prev) => {
            const updated = prev
              .map((e) =>
                e.type === "assistant_text" && e.streaming && e.agentId === agentId
                  ? { ...e, streaming: false }
                  : e,
              )
              .filter(
                (e) =>
                  !(e.type === "thinking" && e.agentId === agentId) &&
                  !(e.type === "tool_running" && e.agentId === agentId),
              );
            return [
              ...updated,
              entry({
                type: "tool_start",
                toolName: tc.toolName,
                args: tc.args,
                toolCallId: tc.id,
                agentId,
              }),
              entry({ type: "tool_running", toolName: tc.toolName, agentId }),
            ];
          });
          break;
        }

        case "tool_use_args_delta": {
          if (agentId !== undefined) break;
          const { toolCallId, args } = event;
          chatStore.update((prev) => {
            const idx = prev.findIndex(
              (e) => e.type === "tool_start" && e.toolCallId === toolCallId,
            );
            // No matching tool_start yet (out-of-order event) — drop.
            if (idx < 0) return prev;
            // Mirror flushTextBuffer's pattern: clone the array and reseat
            // ONLY the targeted entry. Sibling references stay stable so
            // MessageRow.memo (Task 3) can bail for them.
            const next = [...prev];
            next[idx] = { ...prev[idx], args } as ChatEntry;
            return next;
          });
          break;
        }

        case "tool_result": {
          // See note in tool_use_start: hide sub-agent tool I/O.
          if (agentId !== undefined) break;

          const r = event.result;
          // Arena routinely fails on the first attempt while the
          // model is still discovering valid `participants` for the
          // active endpoint (e.g. defaulting to "claude" on a
          // DeepSeek-only session). The endpoint check fails fast
          // now, so the retry loop is healthy — but visually it
          // shows up as several scary "Arena error:" cards in a row.
          // Mark those as compact so the feed reads "Arena …
          // retrying" instead of "Arena exploded three times."
          const looksLikeArenaRetry =
            r.toolName === "Arena" &&
            typeof r.result === "string" &&
            r.result.startsWith("Arena error:");

          chatStore.update((prev) => {
            const filtered = prev.filter(
              (e) => !(e.type === "tool_running" && e.agentId === agentId),
            );
            return [
              ...filtered,
              entry({
                type: "tool_result",
                toolName: r.toolName,
                result: r.result,
                error: r.error,
                agentId,
                compact: looksLikeArenaRetry,
              }),
            ];
          });
          break;
        }

        case "agent_start": {
          const ev = event as Extract<StreamEvent, { type: "agent_start" }>;
          chatStore.update((prev) => [
            ...prev,
            entry({
              type: "agent_start",
              agentId: ev.agentId,
              name: ev.name,
              description: ev.description,
              agentType: ev.agentType,
            }),
          ]);
          break;
        }

        case "agent_end": {
          const ev = event as Extract<StreamEvent, { type: "agent_end" }>;
          chatStore.update((prev) => {
            const filtered = prev.filter(
              (e) =>
                !(
                  (e as any).agentId === ev.agentId &&
                  (e.type === "thinking" || e.type === "tool_running")
                ),
            );
            return [
              ...filtered,
              entry({
                type: "agent_end",
                agentId: ev.agentId,
                name: ev.name,
                description: ev.description,
                text: ev.text,
                error: ev.error,
                agentType: ev.agentType,
              }),
            ];
          });
          break;
        }

        case "task_update": {
          const taskEvent = event as any;
          // Sub-agent task_updates carry agentId (injected by the engine's
          // childStream). Their todos belong to the sub-agent, not the main
          // session — drop them so they don't clobber the main task view
          // (mirrors the desktop renderer's isolation).
          if (taskEvent.agentId) break;
          if (taskEvent.tasks) setTasks(taskEvent.tasks);
          break;
        }

        case "goal_set": {
          // Mirror the active goal for /goal status (objective also staged by
          // the /goal command; this catches goals set elsewhere too).
          const ev = event as Extract<StreamEvent, { type: "goal_set" }>;
          if (
            activeGoalIdRef.current === (ev.goalId ?? null) &&
            !shouldApplyGoalUpdateEvent(
              activeGoalIdRef.current,
              activeGoalRevisionRef.current,
              ev.goalId,
              ev.revision,
            )
          ) {
            break;
          }
          goalMirrorEpochRef.current += 1;
          activeGoalRef.current = ev.objective;
          activeGoalIdRef.current = ev.goalId ?? null;
          activeGoalRevisionRef.current = ev.revision ?? null;
          activeGoalPausedRef.current = ev.paused === true;
          activeGoalLegacyRef.current = ev.goalId === undefined || ev.revision === undefined;
          activeGoalSessionIdRef.current = sourceSessionId ?? sidRef.current ?? null;
          break;
        }

        case "goal_updated": {
          const ev = event as Extract<StreamEvent, { type: "goal_updated" }>;
          if (
            !shouldApplyGoalUpdateEvent(
              activeGoalIdRef.current,
              activeGoalRevisionRef.current,
              ev.goalId,
              ev.revision,
            )
          ) {
            break;
          }
          goalMirrorEpochRef.current += 1;
          activeGoalRef.current = ev.objective;
          activeGoalIdRef.current = ev.goalId ?? null;
          activeGoalRevisionRef.current = ev.revision ?? null;
          activeGoalPausedRef.current = ev.paused;
          activeGoalLegacyRef.current = ev.goalId === undefined || ev.revision === undefined;
          activeGoalSessionIdRef.current = sourceSessionId ?? sidRef.current ?? null;
          break;
        }

        case "goal_cleared": {
          const ev = event as Extract<StreamEvent, { type: "goal_cleared" }>;
          if (
            goalEventMatchesActive(
              activeGoalIdRef.current,
              activeGoalRevisionRef.current,
              ev.goalId,
              ev.revision,
            )
          ) {
            goalMirrorEpochRef.current += 1;
            activeGoalRef.current = null;
            activeGoalIdRef.current = null;
            activeGoalRevisionRef.current = null;
            activeGoalPausedRef.current = false;
            activeGoalLegacyRef.current = false;
          }
          break;
        }

        case "goal_progress": {
          // The goal is achieved (or gave up) — drop the status mirror.
          const ev = event as Extract<StreamEvent, { type: "goal_progress" }>;
          if (
            (ev.status === "met" || ev.status === "exhausted") &&
            goalEventMatchesActive(
              activeGoalIdRef.current,
              activeGoalRevisionRef.current,
              ev.goalId,
              ev.revision,
            )
          ) {
            goalMirrorEpochRef.current += 1;
            activeGoalRef.current = null;
            activeGoalIdRef.current = null;
            activeGoalRevisionRef.current = null;
            activeGoalPausedRef.current = false;
            activeGoalLegacyRef.current = false;
          }
          break;
        }

        case "context_compact": {
          const ev = event as Extract<StreamEvent, { type: "context_compact" }>;
          const dropped = ev.before - ev.after;
          const pct = ev.before > 0 ? Math.round((dropped / ev.before) * 100) : 0;
          const text = `── context compacted (${ev.strategy}, ${formatTokens(ev.before)} → ${formatTokens(ev.after)}, -${pct}%) ──`;
          chatStore.update((prev) => [
            ...prev,
            entry({ type: "system", subtype: "compact_boundary", text }),
          ]);
          // Reset the displayed base so the live ctx bar reflects the new (smaller) prompt.
          uiLog.info("debug.ctx.set", { from: "context_compact", value: ev.after });
          recordUIEvent(sidRef.current, "ui.ctx.set", { from: "context_compact", value: ev.after });
          setContextTokens(ev.after);
          break;
        }

        case "usage_update": {
          // Engine emits this after every messages-array mutation, so the
          // ctx bar always reflects the real (next-prompt) size — including
          // after tool_result append, post-compaction, and LLM response.
          uiLog.info("debug.ctx.usage_update", { promptTokens: event.promptTokens });
          recordUIEvent(sidRef.current, "ui.ctx.usage_update", {
            promptTokens: event.promptTokens,
          });
          if (event.promptTokens > 0) setContextTokens(event.promptTokens);
          break;
        }

        case "error": {
          // ESC took us through the optimistic-cancel path; suppress the
          // late stream "error" event that the LLM SDK fires after socket
          // teardown so the chat stays clean.
          if (cancelledRef.current) break;
          // Sub-agent errors belong in the dock/detail view; don't pollute
          // the main feed (see stream_request_start above).
          if (agentId !== undefined) break;
          // Error is not a lifecycle terminal: normal Engine failures are
          // followed by turn_complete, while control-plane errors may not own
          // a run at all. Only turn_complete may release an external guard.
          const errorText = event.error;
          const errorKind = classifyError(errorText);
          chatStore.update((prev) => {
            const filtered = prev.filter(
              (e) =>
                !(e.type === "thinking" && e.agentId === agentId) &&
                !(e.type === "tool_running" && e.agentId === agentId),
            );
            return [
              ...filtered,
              entry({ type: "error", error: friendlyError(errorText), errorKind, agentId }),
            ];
          });
          break;
        }
      }
    },
    [clearThinkingBuffer, finalizeStreamPresentation, flushTextBuffer, queryGuard],
  );

  // Wire stream events from client
  useEffect(() => {
    const envelopeHandler = (envelope: { sessionId?: string; event: StreamEvent }) => {
      const currentSessionId = sidRef.current;
      // A background wake or another TCP client must not mutate the currently
      // rendered session. The first run has no sid yet, so its authoritative
      // session_started envelope is allowed through.
      if (currentSessionId && envelope.sessionId && envelope.sessionId !== currentSessionId) {
        return;
      }
      handleStreamEvent(envelope.event, envelope.sessionId);
    };
    client.onStreamEvent(envelopeHandler);
    return () => client.offStreamEvent(envelopeHandler);
  }, [client, handleStreamEvent]);

  // Open the model selector by querying the pool from the server.
  // Re-entry is already guarded by the useInput dispatcher (it checks
  // !modelEntries before calling), and addStatus only mutates the chat
  // store (no closure over local state), so we deliberately keep this
  // callback's deps to [client] for a stable reference.
  const openModelSelector = useCallback(async () => {
    try {
      const result = await client.query("models");
      const list = (result.data as ModelEntry[]) ?? [];
      setModelEntries(list);
    } catch (err) {
      chatStore.update((prev) => [
        ...prev,
        entry({ type: "status", reason: `Failed to load models: ${(err as Error).message}` }),
      ]);
    }
  }, [client]);

  // Open the resume picker. Filters out empty (no-message) sessions so the
  // list is always meaningful — see SessionManager.list() for the preview
  // field used as the row caption.
  const openSessionPicker = useCallback(async () => {
    try {
      const result = await client.query("sessions");
      const all = (result.data as Array<SessionPickerEntry & { preview?: string }>) ?? [];
      const filtered = all.filter((s) => (s.preview ?? "").trim().length > 0);
      if (filtered.length === 0) {
        chatStore.update((prev) => [
          ...prev,
          entry({ type: "status", reason: "No sessions to resume." }),
        ]);
        return;
      }
      setSessionEntries(filtered);
    } catch (err) {
      chatStore.update((prev) => [
        ...prev,
        entry({ type: "status", reason: `Failed to load sessions: ${(err as Error).message}` }),
      ]);
    }
  }, [client]);

  // Shared fetch path used by both the initial open and the post-wizard
  // refresh (so adding a provider/model lights up the list without
  // closing the manager).
  const fetchModelManagerState = useCallback(async (): Promise<{
    entries: ModelEntry[];
    snapshot: { count: number; fetchedAt: string };
    arenaParticipants: ArenaParticipantEntry[];
    providers: ProviderManagerEntry[];
  }> => {
    const [modelsRes, arenaRes, legacyArenaRes, providersRes, snapMod] = await Promise.all([
      client.query("models"),
      client.query("config_get", "capabilities.arena.participants"),
      client.query("config_get", "arena.participants"),
      client.query("providers"),
      import("@cjhyy/code-shell-core"),
    ]);
    const entries = (modelsRes.data as ModelEntry[]) ?? [];
    const snap = snapMod.getOpenRouterSnapshot();

    // capabilities.arena.participants (or legacy arena.participants):
    // Array<string | { name, model, ... }>. Strings are
    // editable in-place; object entries surface as read-only labels so a
    // hand-crafted settings.json round-trips intact.
    const raw =
      (arenaRes.data as { value?: unknown })?.value ??
      (legacyArenaRes.data as { value?: unknown })?.value;
    const arenaParticipants: ArenaParticipantEntry[] = Array.isArray(raw)
      ? raw.map((item: unknown): ArenaParticipantEntry => {
          if (typeof item === "string") return { kind: "key", value: item };
          if (item && typeof item === "object") {
            const obj = item as { name?: string; model?: string };
            const label = obj.name ?? obj.model ?? "(未命名)";
            return { kind: "object", label };
          }
          return { kind: "object", label: String(item) };
        })
      : [];

    // providers: server-enriched payload includes modelCount + cachedModels
    // + cachedAt alongside the raw settings.providers[] fields. We don't
    // re-derive modelCount client-side — keeping the source-of-truth on the
    // server side avoids drift when reloadModelPool is called.
    const providerList = Array.isArray(providersRes.data) ? providersRes.data : [];
    const providers: ProviderManagerEntry[] = providerList
      .filter((p: unknown): p is Record<string, unknown> => !!p && typeof p === "object")
      .map((p) => {
        const key = typeof p.key === "string" ? p.key : "";
        const label = typeof p.label === "string" ? p.label : key;
        const kind = typeof p.kind === "string" ? p.kind : "unknown";
        const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl : undefined;
        const apiKey = typeof p.apiKey === "string" ? p.apiKey : undefined;
        const protocol = typeof p.protocol === "string" ? p.protocol : undefined;
        const modelsPath = typeof p.modelsPath === "string" ? p.modelsPath : undefined;
        return {
          key,
          label,
          kind,
          modelCount: typeof p.modelCount === "number" ? p.modelCount : 0,
          cachedModels: typeof p.cachedModels === "number" ? p.cachedModels : undefined,
          cachedAt: typeof p.cachedAt === "string" ? p.cachedAt : undefined,
          baseUrl,
          apiKey,
          protocol,
          modelsPath,
        };
      })
      .filter((p) => p.key.length > 0);

    return {
      entries,
      snapshot: { count: snap.count, fetchedAt: snap.fetchedAt },
      arenaParticipants,
      providers,
    };
  }, [client]);

  const openModelManager = useCallback(async () => {
    try {
      const state = await fetchModelManagerState();
      setModelManager(state);
    } catch (err) {
      chatStore.update((prev) => [
        ...prev,
        entry({
          type: "status",
          reason: `Failed to open model manager: ${(err as Error).message}`,
        }),
      ]);
    }
  }, [fetchModelManagerState]);

  // Re-fetch the manager state after a wizard saves. Caller has already
  // closed the wizard; this just refreshes the underlying list.
  const refreshModelManagerState = useCallback(async () => {
    try {
      const state = await fetchModelManagerState();
      setModelManager(state);
    } catch (err) {
      chatStore.update((prev) => [
        ...prev,
        entry({
          type: "status",
          reason: `Failed to refresh model manager: ${(err as Error).message}`,
        }),
      ]);
    }
  }, [fetchModelManagerState]);

  // Open onboarding (/login). Always re-fetch existing providers/models first
  // so the wizard's "Use existing" branch reflects current settings.json — the
  // wizard reads from `modelManager` state, which would otherwise be stale
  // (or empty on first run) and silently hide existing providers.
  const startOnboarding = useCallback(async () => {
    try {
      const state = await fetchModelManagerState();
      setModelManager(state);
    } catch (err) {
      // Non-fatal: onboarding still works with empty lists (first-run case).
      chatStore.update((prev) => [
        ...prev,
        entry({
          type: "status",
          reason: `Could not load existing config (continuing with empty list): ${(err as Error).message}`,
        }),
      ]);
    }
    setShowOnboarding(true);
  }, [fetchModelManagerState]);

  useInput((ch, key) => {
    // Dock keyboard branch — highest priority among non-overlay keys.
    // When dockFocusIdx is non-null the dock owns ↑/↓/Enter/Esc and
    // returns early on each one, so they never reach the cancel-Esc or
    // transcript handlers below.
    if (dockFocusIdx !== null) {
      const visible = getVisibleAgents(asyncAgentRegistry.getSnapshot(), Date.now());
      // 0 = main row; 1..maxIdx = agents.
      const maxIdx = Math.min(MAX_VISIBLE, visible.length);

      if (key.upArrow) {
        setDockFocusIdx((cur) => {
          if (cur === null) return cur;
          if (cur === 0) return null;
          return cur - 1;
        });
        return;
      }
      if (key.downArrow) {
        setDockFocusIdx((cur) => {
          if (cur === null) return cur;
          return Math.min(maxIdx, cur + 1);
        });
        return;
      }
      if (key.return) {
        if (dockFocusIdx === 0) {
          setViewMode({ kind: "main" });
        } else {
          const target = visible[dockFocusIdx - 1];
          if (target) setViewMode({ kind: "agent", agentId: target.agentId });
        }
        // Keep the dock focused after switching views so ↑/↓ keep moving
        // between agents instead of falling through to CommandInput's
        // history navigation. Esc explicitly releases the dock.
        return;
      }
      if (key.escape) {
        setDockFocusIdx(null);
        return;
      }
    }

    // viewMode === 'agent' → Esc returns to main BEFORE the cancel branch.
    // Mirrors the overlay gating below so Esc in modals still belongs to
    // them, not to us.
    if (
      key.escape &&
      viewMode.kind === "agent" &&
      !pendingQuestion &&
      !pendingApproval &&
      !showOnboarding &&
      !modelEntries &&
      !modelManager &&
      !sessionEntries
    ) {
      setViewMode({ kind: "main" });
      return;
    }

    if (key.ctrl && ch === "c") {
      if (isRunning) {
        // P0.5: Preserve already-streamed text before cancelling
        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushTextBuffer();
        // Drop tool_running (no semantic meaning post-cancel); commit the
        // streaming entry with the user-cancel marker so the transcript
        // shows what the model had produced before Esc.
        chatStore.update((prev) => prev.filter((e) => e.type !== "tool_running"));
        chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
        const cancelledOwner = queryGuard.forceEnd("user-cancel");
        if (cancelledOwner === "external") cancelledExternalRunPendingRef.current = true;
        // Multi-session server rejects cancel without a sessionId; pass the
        // current session so the underlying run actually aborts (not just the
        // optimistic UI flip). Log failures instead of swallowing them.
        client
          .cancel(sidRef.current ?? sessionId ?? "", "user-cancel")
          .catch((err) => uiLog.warn("ctrl+c cancel failed", { err: String(err) }));
        // Ctrl+C = nuke everything: also cancel every running background agent
        // so the user gets a clean idle state. ESC only stops the main query.
        for (const a of asyncAgentRegistry.list()) {
          if (a.status === "running") asyncAgentRegistry.cancel(a.agentId);
        }
        // Same optimistic-cancel path as ESC — see cancelledRef comment.
        if (localRunTokenRef.current !== null) {
          cancelledLocalRunTokensRef.current.add(localRunTokenRef.current);
        }
        cancellationEpochRef.current += 1;
        cancelledRef.current = true;
        setStreamMode("thinking");
        setThinkingContent(null);
        clearThinkingBuffer();
      } else {
        exit();
      }
    }

    // Shift+Tab: cycle permission mode (plan → normal → bypass → plan)
    if (key.shift && key.tab && !isRunning) {
      setPermMode((prev) => {
        const next = nextPermissionMode(prev);

        // Notify server of mode change
        client
          .configure({
            sessionId: sidRef.current ?? sessionId,
            ...permissionConfigurePayload(next),
          })
          .catch(() => {});

        return next;
      });
    }

    // ESC — cancel the main query only; background agents keep running.
    // Gate on isQueryActive (not isRunning), otherwise ESC would be eaten by
    // this branch whenever a background agent is still alive, even after the
    // main query already ended. Skip when ANY modal/overlay is open: those
    // components handle Esc themselves (e.g. ProviderModelFlow steps back
    // one screen on Esc). The root handler must not preempt them, or Esc
    // would dismiss the whole overlay instead of stepping back.
    if (
      key.escape &&
      isQueryActive &&
      !pendingQuestion &&
      !pendingApproval &&
      !showOnboarding &&
      !modelEntries &&
      !modelManager &&
      !sessionEntries
    ) {
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushTextBuffer();
      chatStore.update((prev) => prev.filter((e) => e.type !== "tool_running"));
      chatStore.commitInterruptedStreaming("\n\n[Request interrupted by user]");
      const cancelledOwner = queryGuard.forceEnd("user-cancel");
      if (cancelledOwner === "external") cancelledExternalRunPendingRef.current = true;
      // Multi-session server rejects cancel without a sessionId — pass it so
      // the run truly aborts. See ctrl+c branch above.
      client
        .cancel(sidRef.current ?? sessionId ?? "", "user-cancel")
        .catch((err) => uiLog.warn("esc cancel failed", { err: String(err) }));
      // Optimistic UI: flip back to idle immediately. The server-side abort
      // still propagates through the LLM SDK in the background (1–7s for
      // socket teardown), and the awaited client.run() in handleSubmit will
      // eventually resolve/reject — cancelledRef tells that path to skip the
      // late "aborted" error / turn-duration entries.
      if (localRunTokenRef.current !== null) {
        cancelledLocalRunTokensRef.current.add(localRunTokenRef.current);
      }
      cancellationEpochRef.current += 1;
      cancelledRef.current = true;
      setStreamMode("thinking");
      setThinkingContent(null);
      clearThinkingBuffer();
      // Undo the last history entry since the request was interrupted
      removeLastFromHistory();
    }

    // Alt+M / Esc+M — open model selector. (Ctrl+M is unusable: terminals
    // alias it to Enter, so it would collide with submitting the input.)
    if (key.meta && ch === "m" && !isRunning && !showOnboarding && !modelEntries && !modelManager) {
      openModelSelector();
      return;
    }

    // Wheel + PageUp/PageDown — viewport scroll on the chat list.
    // PageUp/PageDown step by viewport-2 so two rows stay visible across the
    // jump (browser/editor convention). Skip while modals/overlays are open
    // — those own their own input. Wheel works in transcript mode too
    // (viewport pan independent of entry-cursor up/down). PageUp/Down also
    // work in both modes.
    //
    // Flow mode (CODESHELL_FULLSCREEN=0): bypass entirely so the terminal's
    // native scrollback handles wheel + PgUp/PgDn.
    if (fullscreen && !overlayOpen && (key.wheelUp || key.wheelDown)) {
      listRef.current?.scrollBy(key.wheelUp ? -1 : 1);
      return;
    }
    if (fullscreen && !overlayOpen && (key.pageUp || key.pageDown)) {
      const vh = listRef.current?.getViewportHeight() ?? 0;
      const step = Math.max(1, vh - 2);
      listRef.current?.scrollBy(key.pageUp ? -step : step);
      return;
    }

    // P1.6: Ctrl+O — toggle transcript mode. Browsing is read-only, so allow
    // it while a turn is in flight; gating on !isRunning made this silently
    // no-op whenever a streaming response or background task held the flag.
    if (key.ctrl && ch === "o") {
      setScreen((prev) => {
        if (prev === "transcript") {
          setCursorIdx(null);
          return "prompt";
        }
        return "transcript";
      });
      return;
    }

    // P1.8: Message selector in transcript mode
    if (screen === "transcript") {
      const selectableEntries = chatLog.filter(
        (e) => e.type === "user" || e.type === "assistant_text" || e.type === "tool_result",
      );
      if (key.upArrow) {
        setCursorIdx((prev) => {
          if (prev === null) return selectableEntries.length - 1;
          return Math.max(0, prev - 1);
        });
      } else if (key.downArrow) {
        setCursorIdx((prev) => {
          if (prev === null) return 0;
          return Math.min(selectableEntries.length - 1, prev + 1);
        });
      } else if (key.escape) {
        setCursorIdx(null);
      }
    }
  });

  // Submits a message to the engine and runs the post-turn state-machine
  // (streaming flush, finalize entries, post duration/cost system row,
  // post status row, error capture, query-guard cleanup).
  //
  // Two input sources call this:
  //   - handleSubmit: real user input. asInjection=false, the user's text
  //     is appended as a "user" entry to chatStore.
  //   - useNotificationProcessor (Task 8): background-agent completion
  //     injection. asInjection=true, a "system" entry with subtype
  //     "bg_agent_notification" is appended showing the terse summary;
  //     the full XML payload still goes to the engine so the LLM sees it.
  const submitToEngine = useCallback(
    async (
      message: string,
      opts: { asInjection: boolean; chatSummary?: string; goal?: string },
    ): Promise<boolean> => {
      const guardToken = queryGuard.reserve();
      if (guardToken === null) return false;
      const runCancellationEpoch = cancellationEpochRef.current;
      const runWasCancelled = () => cancellationEpochRef.current !== runCancellationEpoch;
      streamingTokensRef.current = 0;
      if (
        cancelledLocalRunTokensRef.current.size === 0 &&
        !cancelledExternalRunPendingRef.current
      ) {
        cancelledRef.current = false;
      }
      // taskManager removed — tasks live in the transcript now; engine
      // emits task_update on resume so the UI re-hydrates without a
      // module-level reset.

      const abortController = new AbortController();
      if (!queryGuard.tryStart(abortController, guardToken)) {
        // Race-safety check — should be unreachable since reserve just succeeded
        queryGuard.cancelReservation(guardToken);
        return false;
      }
      localRunTokenRef.current = guardToken;

      const goal = !opts.asInjection ? opts.goal?.trim() || null : null;
      const stagedGoalEpoch = goal ? ++goalMirrorEpochRef.current : null;
      if (goal) {
        activeGoalRef.current = goal;
        activeGoalIdRef.current = null;
        activeGoalRevisionRef.current = null;
        activeGoalPausedRef.current = false;
        activeGoalLegacyRef.current = false;
        activeGoalSessionIdRef.current = sidRef.current ?? sessionId ?? null;
      }

      // After reserving the engine slot, commit the chat entry. Appending
      // before reserve would orphan an entry on contention with no engine
      // response to follow it.
      if (opts.asInjection) {
        chatStore.update((prev) => [
          ...prev,
          entry({
            type: "system",
            subtype: "bg_agent_notification",
            text: opts.chatSummary ?? "",
          }),
        ]);
      } else {
        chatStore.update((prev) => [...prev, entry({ type: "user", text: message })]);
      }

      let streamPresentationFinalized = false;
      try {
        // For real user input: prepend pending /arena-style context if any.
        // Injections do not honor pendingContext (it belongs to the user
        // turn that staged it).
        let engineMessage = message;
        if (!opts.asInjection && pendingContextRef.current) {
          engineMessage = `<context>\n${pendingContextRef.current}\n</context>\n\n${message}`;
          pendingContextRef.current = null;
        }
        // Drain staged `/image` blocks, if any. Same wire format the
        // desktop renderer uses (see `packages/desktop/src/renderer/chat/
        // attachments.ts`) so the engine's parse-task pipeline handles
        // both UIs identically. Injection turns don't get images either.
        if (!opts.asInjection && pendingImagesRef.current.length > 0) {
          // Strip the trailing "[name, size]" caption line each
          // image-command block tacks on for the status echo — it's
          // not part of the wire format the engine parses.
          const blocks = pendingImagesRef.current.map((b) => {
            const lines = b.split("\n");
            // Find the closing </codeshell-image> and drop anything after.
            const closeIdx = lines.findIndex((l) => l.trim() === "</codeshell-image>");
            return closeIdx >= 0 ? lines.slice(0, closeIdx + 1).join("\n") : b;
          });
          engineMessage = engineMessage
            ? `${engineMessage}\n\n${blocks.join("\n")}`
            : blocks.join("\n");
          pendingImagesRef.current = [];
        }

        const handleTransportResponse = () => {
          const released = queryGuard.endLocalResponse(guardToken);
          if (localRunTokenRef.current === guardToken) localRunTokenRef.current = null;
          cancelledLocalRunTokensRef.current.delete(guardToken);
          if (
            cancelledLocalRunTokensRef.current.size === 0 &&
            !cancelledExternalRunPendingRef.current
          ) {
            cancelledRef.current = false;
          }
          // Finalize this run synchronously before the transport can parse a
          // queued external turn's early stream events from the same chunk.
          if (released && !runWasCancelled() && !streamPresentationFinalized) {
            finalizeStreamPresentation();
            streamPresentationFinalized = true;
          }
        };
        const result = goal
          ? await client.run(
              { task: engineMessage, sessionId: sessionId ?? "", goal },
              undefined,
              handleTransportResponse,
            )
          : await client.run(engineMessage, sessionId, handleTransportResponse);

        // ESC / Ctrl+C took us through the optimistic-cancel path — UI is
        // already idle, history rewound. Don't append turn-duration / status
        // entries from this resolution (would arrive 1–7s after ESC).
        if (runWasCancelled()) {
          return true;
        }

        if (!streamPresentationFinalized) {
          finalizeStreamPresentation();
          streamPresentationFinalized = true;
        }

        setSessionId(result.sessionId);
        setTotalTokens(costTracker.getTotalTokens().total);
        setTotalCost(costTracker.getEstimatedCost());

        const elapsed = Date.now() - runStartRef.current;
        const turnCost = result.usage
          ? costTracker.estimateForTokens(
              model,
              result.usage.promptTokens,
              result.usage.completionTokens,
            )
          : 0;
        const parts: string[] = [formatDuration(elapsed)];
        if (result.usage && result.usage.totalTokens > 0) {
          parts.push(`${formatTokens(result.usage.totalTokens)} tokens`);
          if (result.usage.cacheReadTokens) {
            parts.push(`${formatTokens(result.usage.cacheReadTokens)} cached`);
          }
        }
        if (turnCost > 0) parts.push(`$${turnCost.toFixed(4)}`);
        chatStore.update((prev) => [
          ...prev,
          entry({ type: "system", subtype: "turn_duration", text: parts.join(" · ") }),
        ]);

        if (result.reason !== "completed") {
          chatStore.update((prev) => [
            ...prev,
            entry({ type: "status", reason: friendlyReason(result.reason) }),
          ]);
        }
      } catch (err) {
        if (goal && stagedGoalEpoch !== null) {
          const goalSessionId = sidRef.current ?? sessionId;
          if (goalSessionId) {
            try {
              const authoritative = await client.goalGetState(goalSessionId);
              if (goalMirrorEpochRef.current === stagedGoalEpoch) {
                activeGoalRef.current = authoritative?.objective ?? null;
                activeGoalIdRef.current = authoritative?.goalId ?? null;
                activeGoalRevisionRef.current = authoritative?.revision ?? null;
                activeGoalPausedRef.current = authoritative?.paused === true;
                activeGoalLegacyRef.current =
                  !!authoritative &&
                  (authoritative.goalId === undefined || authoritative.revision === undefined);
              }
            } catch {
              // Preserve the optimistic mirror when the authoritative read is
              // unavailable; a later session hydrate will reconcile it.
            }
          }
        }
        if (!runWasCancelled()) {
          chatStore.update((prev) => [
            ...prev,
            entry({ type: "error", error: friendlyError((err as Error).message) }),
          ]);
        }
      } finally {
        // end() is idempotent — safe to call even if forceEnd already released
        // the guard (ESC/Ctrl+C path).
        queryGuard.end(guardToken);
        if (localRunTokenRef.current === guardToken) localRunTokenRef.current = null;
        cancelledLocalRunTokensRef.current.delete(guardToken);
        if (
          cancelledLocalRunTokensRef.current.size === 0 &&
          !cancelledExternalRunPendingRef.current
        ) {
          cancelledRef.current = false;
        }
      }

      if (!runWasCancelled() && !streamPresentationFinalized) {
        setStreamMode("thinking");
        setThinkingContent(null);
        clearThinkingBuffer();
      }
      return true;
    },
    [client, sessionId, model, clearThinkingBuffer, finalizeStreamPresentation],
  );

  // Background sub-agent completion → main-agent turn injection.
  //
  // notificationQueue is filled by agent.ts when a background sub-agent
  // finishes (completed or failed; cancelled never enqueues). This effect
  // drains the queue and submits the contents as a new main-agent turn,
  // but ONLY when nothing else is competing for the conversation slot:
  //
  //   * main agent must be idle (no in-flight LLM call)
  //   * user must not be typing (input box empty)
  //   * no modal / overlay must be open (the user is already busy)
  //
  // Any of those changing re-runs the effect and re-evaluates the guards,
  // so notifications get delivered at the first idle moment naturally.
  const overlayOpen =
    pendingQuestion ||
    pendingApproval ||
    showOnboarding ||
    modelEntries ||
    modelManager ||
    sessionEntries;
  // B2: drain only this session's bucket. Other sessions running in the
  // same process (multi-session host roadmap) have their own buckets and
  // don't bleed into this one. sessionId can be undefined before the
  // first run() resolves a sid — in that window we have nothing to read
  // anyway (no agent could have been spawned yet), so we short-circuit
  // to an empty snapshot rather than poke the queue.
  // Stable empty reference for the no-session window — useSyncExternalStore
  // compares snapshots by identity, so we can't return a fresh `[]` each
  // call without provoking a render loop. Typed via `ReturnType` so we
  // don't have to re-import `NotificationItem` for one literal.
  const EMPTY_NOTIFICATIONS = useMemo<ReturnType<typeof notificationQueue.getSnapshot>>(
    () => [],
    [],
  );
  const getNotificationSnapshot = useCallback(
    () => (sessionId ? notificationQueue.getSnapshot(sessionId) : EMPTY_NOTIFICATIONS),
    [sessionId, EMPTY_NOTIFICATIONS],
  );
  const notificationSnapshot = useSyncExternalStore(
    notificationQueue.subscribe,
    getNotificationSnapshot,
  );
  useEffect(() => {
    if (
      !shouldDrainBackgroundNotifications({
        notificationCount: notificationSnapshot.length,
        isQueryActive,
        queryGuardBusy: queryGuard.getSnapshot(),
        input,
        overlayOpen: Boolean(overlayOpen),
        sessionId,
      })
    ) {
      return;
    }

    const notificationSessionId = sessionId;
    if (!notificationSessionId) return;

    const items = notificationQueue.drainAll(notificationSessionId);
    if (items.length === 0) return;
    const xml = buildNotificationMessage(items);
    const summary = buildNotificationSummary(items);
    void submitToEngine(xml, { asInjection: true, chatSummary: summary });
  }, [notificationSnapshot, isQueryActive, input, overlayOpen, submitToEngine, sessionId]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      const head = trimmed.split(/\s+/)[0]?.toLowerCase();
      if (isQueryActive && head === "/force") {
        const next = trimmed.slice("/force".length).trim();
        if (next) setQueuedInputs((prev) => [...prev, next]);
        setInput("");
        client
          .cancel(sidRef.current ?? sessionId ?? "", "user-force")
          .catch((err) => uiLog.warn("/force cancel failed", { err: String(err) }));
        return;
      }
      if (isQueryActive && !canExecuteCommandWhileRunning(trimmed)) {
        setQueuedInputs((prev) => [...prev, trimmed]);
        setInput("");
        return;
      }
      if (!isQueryActive) {
        setInput("");
        setShowBanner(false);
        onScrollToBottom();
      } else {
        setInput("");
      }

      if (trimmed.startsWith("/")) {
        handleSlashCommand(trimmed);
        return;
      }

      await submitToEngine(trimmed, { asInjection: false });
    },
    [isQueryActive, submitToEngine, onScrollToBottom, client],
  );

  useEffect(() => {
    if (isQueryActive || queuedInputs.length === 0 || input.trim() !== "") return;
    const [next, ...rest] = queuedInputs;
    setQueuedInputs(rest);
    if (next) void handleSubmit(next);
  }, [isQueryActive, queuedInputs, input, handleSubmit]);

  const handleSlashCommand = useCallback(
    (cmd: string) => {
      if (cmd.trim().toLowerCase() === "/help") {
        addStatus(commandRegistry.helpText());
        return;
      }

      const reconcileGoalMirror = async (goalSessionId: string): Promise<void> => {
        const epoch = goalMirrorEpochRef.current;
        try {
          const authoritative = await client.goalGetState(goalSessionId);
          if (goalMirrorEpochRef.current !== epoch || sidRef.current !== goalSessionId) return;
          goalMirrorEpochRef.current += 1;
          activeGoalRef.current = authoritative?.objective ?? null;
          activeGoalIdRef.current = authoritative?.goalId ?? null;
          activeGoalRevisionRef.current = authoritative?.revision ?? null;
          activeGoalPausedRef.current = authoritative?.paused === true;
          activeGoalLegacyRef.current =
            !!authoritative &&
            (authoritative.goalId === undefined || authoritative.revision === undefined);
          activeGoalSessionIdRef.current = goalSessionId;
        } catch (error) {
          uiLog.warn("goal mutation reconcile failed", {
            sessionId: goalSessionId,
            error: formatCommandError(error),
          });
        }
      };

      const cmdCtx = {
        client,
        cwd,
        model,
        setModel,
        setMaxContextTokens: setActiveMaxContextTokens,
        sessionId,
        setSessionId,
        queryGuard,
        addStatus,
        addMessage,
        setNextContext: (text: string) => {
          pendingContextRef.current = text;
        },
        exit,
        effort: currentEffort,
        setEffort: setCurrentEffort,
        tasks,
        clearChat: () => {
          chatStore.clear();
          setTasks([]);
          setShowBanner(true);
        },
        chatLog,
        startOnboarding,
        openModelSelector,
        openSessionPicker,
        openModelManager,
        fullscreen,
        setFullscreen: fullscreenModeValue.setFullscreen,
        toggleFullscreen: fullscreenModeValue.toggleFullscreen,
        loadChatEntries: (entries: RestoredChatEntry[]) => {
          const chatEntries: ChatEntry[] = entries
            .map((e) => {
              switch (e.type) {
                case "user":
                  return entry({ type: "user", text: e.text ?? "" });
                case "assistant_text":
                  return entry({ type: "assistant_text", text: e.text ?? "", streaming: false });
                case "tool_start":
                  return entry({
                    type: "tool_start",
                    toolName: e.toolName ?? "",
                    args: e.args ?? {},
                  });
                case "tool_result":
                  return entry({
                    type: "tool_result",
                    toolName: e.toolName ?? "",
                    result: e.result,
                    error: e.error,
                  });
                case "status":
                  return entry({ type: "status", reason: e.text ?? "" });
                default:
                  return entry({ type: "status", reason: "" });
              }
            })
            .filter((e) => !(e.type === "status" && (e as any).reason === ""));
          chatStore.setEntries(chatEntries);
          setTasks([]);
        },
        pendingImages: {
          add: (block) => {
            pendingImagesRef.current = [...pendingImagesRef.current, block];
          },
          clear: () => {
            pendingImagesRef.current = [];
          },
          list: () => pendingImagesRef.current,
        },
        activeGoal: activeGoalRef.current,
        activeGoalPaused: activeGoalPausedRef.current,
        activeGoalVersionReady:
          activeGoalIdRef.current !== null && activeGoalRevisionRef.current !== null,
        activeGoalLegacy: activeGoalLegacyRef.current,
        submitGoal: (objective: string) => {
          void submitToEngine(objective, { asInjection: false, goal: objective }).then(
            (accepted) => {
              if (!accepted) setQueuedInputs((prev) => [`/goal ${objective}`, ...prev]);
            },
          );
        },
        updateGoal: async (patch: { objective?: string; paused?: boolean }) => {
          const goalSessionId = sidRef.current ?? sessionId;
          const expectedGoalId = activeGoalIdRef.current;
          const expectedRevision = activeGoalRevisionRef.current;
          if (!goalSessionId || !expectedGoalId || expectedRevision === null) return false;
          const goal = await client.goalUpdate(goalSessionId, {
            ...patch,
            expectedGoalId,
            expectedRevision,
          });
          if (!goal) {
            await reconcileGoalMirror(goalSessionId);
            return false;
          }
          if (
            sidRef.current === goalSessionId &&
            goalUpdateResponseIsFresh(
              activeGoalIdRef.current,
              activeGoalRevisionRef.current,
              goal.goalId,
              goal.revision,
            )
          ) {
            goalMirrorEpochRef.current += 1;
            activeGoalRef.current = goal.objective;
            activeGoalIdRef.current = goal.goalId ?? null;
            activeGoalRevisionRef.current = goal.revision ?? null;
            activeGoalPausedRef.current = goal.paused === true;
            activeGoalLegacyRef.current = false;
            activeGoalSessionIdRef.current = goalSessionId;
          }
          return true;
        },
        deleteGoal: async () => {
          const goalSessionId = sidRef.current ?? sessionId;
          const goalId = activeGoalIdRef.current;
          const revision = activeGoalRevisionRef.current;
          const mutationEpoch = goalMirrorEpochRef.current;
          const legacy = activeGoalLegacyRef.current;
          if (!goalSessionId) return false;
          const deleted =
            goalId && revision !== null
              ? await client.goalDelete(goalSessionId, { goalId, revision })
              : legacy
                ? await client.goalClear(goalSessionId)
                : false;
          if (!deleted) {
            await reconcileGoalMirror(goalSessionId);
            return false;
          }
          const stillOwnsDeletedVersion =
            goalId && revision !== null
              ? goalEventMatchesActive(
                  activeGoalIdRef.current,
                  activeGoalRevisionRef.current,
                  goalId,
                  revision,
                )
              : legacy && goalMirrorEpochRef.current === mutationEpoch;
          if (sidRef.current === goalSessionId && stillOwnsDeletedVersion) {
            goalMirrorEpochRef.current += 1;
            activeGoalRef.current = null;
            activeGoalIdRef.current = null;
            activeGoalRevisionRef.current = null;
            activeGoalPausedRef.current = false;
            activeGoalLegacyRef.current = false;
          }
          return deleted;
        },
        clearGoal: async () => {
          const goalSessionId = sidRef.current;
          const mutationEpoch = goalMirrorEpochRef.current;
          const cleared = await client.goalClear(goalSessionId);
          if (
            cleared &&
            sidRef.current === goalSessionId &&
            goalMirrorEpochRef.current === mutationEpoch
          ) {
            goalMirrorEpochRef.current += 1;
            activeGoalRef.current = null;
            activeGoalIdRef.current = null;
            activeGoalRevisionRef.current = null;
            activeGoalPausedRef.current = false;
            activeGoalLegacyRef.current = false;
          } else if (!cleared && goalSessionId) {
            await reconcileGoalMirror(goalSessionId);
          }
          return cleared;
        },
      };
      dispatchSlashCommandSafely(commandRegistry, cmd, cmdCtx, addStatus);
    },
    [
      client,
      cwd,
      model,
      setModel,
      sessionId,
      currentEffort,
      tasks,
      chatLog,
      exit,
      startOnboarding,
      openModelSelector,
      openSessionPicker,
      openModelManager,
      submitToEngine,
    ],
  );

  const addStatus = (reason: string) => {
    chatStore.update((prev) => [...prev, entry({ type: "status", reason })]);
  };

  const applyModelConfigureResult = (result: unknown, fallbackModel: string): string => {
    const data = result as { model?: string; maxContextTokens?: number } | undefined;
    const newModel = data?.model ?? fallbackModel;
    setModel(newModel);
    if (typeof data?.maxContextTokens === "number") {
      setActiveMaxContextTokens(data.maxContextTokens);
    }
    return newModel;
  };

  const addMessage = (text: string) => {
    chatStore.update((prev) => [
      ...prev,
      entry({ type: "assistant_text", text, streaming: false }),
    ]);
  };

  const commandDefs = useMemo(() => commandRegistry.listCommands(), []);

  // P1.8: Compute selectable entries for cursor highlighting
  const selectableIds = useMemo(() => {
    if (screen !== "transcript") return new Set<string>();
    return new Set(
      chatLog
        .filter((e) => e.type === "user" || e.type === "assistant_text" || e.type === "tool_result")
        .map((e) => e.id),
    );
  }, [screen, chatLog]);

  const selectedEntryId = useMemo(() => {
    if (cursorIdx === null || screen !== "transcript") return null;
    const selectableList = chatLog.filter((e) => selectableIds.has(e.id));
    return selectableList[cursorIdx]?.id ?? null;
  }, [cursorIdx, screen, chatLog, selectableIds]);

  const isTranscript = screen === "transcript";

  // Id of the entry currently receiving stream deltas — drives MessageRow's
  // isStreaming flag so that one row escapes memo while siblings bail.
  // Computed from chatLog so it stays in sync without an extra subscription.
  const streamingEntryId = useMemo(() => {
    for (let i = chatLog.length - 1; i >= 0; i--) {
      const e = chatLog[i]!;
      if (e.type === "assistant_text" && e.streaming) return e.id;
    }
    return null;
  }, [chatLog]);

  const renderedEntries = (() => {
    if (viewMode.kind === "main") return chatLog;
    const agent = agentsSnapshot.find((a) => a.agentId === viewMode.agentId);
    return (agent?.transcript ?? []) as typeof chatLog;
  })();

  const scrollableContent = (
    <>
      {showBanner && (
        <>
          <Banner model={model} effort={currentEffort} maxTurns={maxTurns} cwd={cwd} />
          <UpdateBanner />
          {!initialSessionId && <WelcomeTips cwd={cwd} />}
        </>
      )}

      {/* Chat log — virtualized for large conversations.
          Cursor outline + isStreaming/expanded gating is handled inside
          VirtualMessageList; renderEntry stays cursor-agnostic so its
          closure identity doesn't matter for MessageRow memo. */}
      <VirtualMessageList
        ref={listRef}
        entries={renderedEntries}
        renderEntry={renderEntry}
        columns={process.stdout.columns ?? 80}
        streamingEntryId={streamingEntryId}
        selectedEntryId={selectedEntryId}
        expanded={isTranscript}
        dividerIndex={dividerIndex}
        unseenCount={unseenCount}
        onScrollAway={onScrollAway}
      />

      {/* Spinner with verb (when loading).
          Hidden while waiting on user input (AskUser / approval) — the elapsed
          counter would otherwise keep climbing while we're idle on the user. */}
      {isRunning && !pendingQuestion && !pendingApproval && (
        <SpinnerWithVerb
          mode={streamMode}
          streamingTokensRef={streamingTokensRef}
          runStartRef={runStartRef}
          thinkingContent={thinkingContent ?? undefined}
        />
      )}

      {/* Task list — hidden in sub-agent detail view: today's TaskCreate/Update
          are a global singleton (no per-agent tagging), so showing them under
          a sub-agent would mislead. When task ownership lands (TODO:
          多代理增强), filter by ownerAgentId here instead. */}
      {tasks.length > 0 && viewMode.kind === "main" && <TaskList tasks={tasks} />}
    </>
  );

  const overlayContent = pendingApproval ? (
    <PermissionPrompt
      toolName={pendingApproval.toolName}
      description={pendingApproval.description}
      riskLevel={pendingApproval.riskLevel}
      cwd={cwd}
      args={pendingApproval.args}
      onDecision={(approved, scope) => {
        const { requestId } = pendingApproval;
        setPendingApproval(null);
        // Map scope to backend fields:
        //   once    → approve/deny just this call
        //   session → set always so session rules pick it up
        //   project → set always + scope so backend persists to settings
        const always = scope !== "once";
        client
          .approve(
            requestId,
            approved ? { approved: true, always, scope } : { approved: false, always, scope },
          )
          .catch(() => {});
      }}
    />
  ) : undefined;

  const cols = process.stdout.columns ?? 80;
  const separator = "─".repeat(cols);

  const bottomContent = (
    <Box flexDirection="column" marginTop={0}>
      <Text dim>{separator}</Text>

      <TuiControlSurface
        client={client}
        screen={screen}
        cursorIdx={cursorIdx}
        showOnboarding={showOnboarding}
        setShowOnboarding={setShowOnboarding}
        modelManager={modelManager}
        setModelManager={setModelManager}
        modelEntries={modelEntries}
        setModelEntries={setModelEntries}
        sessionEntries={sessionEntries}
        setSessionEntries={setSessionEntries}
        wizard={wizard}
        setWizard={setWizard}
        pendingQuestion={pendingQuestion}
        setPendingQuestion={setPendingQuestion}
        pendingApproval={pendingApproval !== null}
        sessionId={sessionId}
        sidRef={sidRef}
        applyModelConfigureResult={applyModelConfigureResult}
        addStatus={addStatus}
        refreshModelManagerState={refreshModelManagerState}
        handleSlashCommand={handleSlashCommand}
        queuedInputs={queuedInputs}
        input={input}
        setInput={setInput}
        handleSubmit={handleSubmit}
        commands={commandDefs}
        isRunning={isRunning}
        dockFocusIdx={dockFocusIdx}
        setDockFocusIdx={setDockFocusIdx}
        viewMode={viewMode}
      />

      <Text dim>{separator}</Text>

      <Box wrap="truncate">
        <ModeIndicator mode={permMode} />
        {screen === "transcript" && <Text color="ansi:magenta">{" TRANSCRIPT "}</Text>}
        <Box flexGrow={1} />
        <StatusLine
          model={model}
          effort={currentEffort}
          tokens={totalTokens}
          cost={totalCost}
          sessionId={sessionId}
          baseContextTokens={contextTokens}
          maxContextTokens={activeMaxContextTokens}
          isRunning={isRunning}
          streamingTokensRef={streamingTokensRef}
          runStartRef={runStartRef}
        />
      </Box>

      {/* Dock at the very bottom — below StatusLine. Renders null when
          no running or recently-finished agents. */}
      <AgentDock viewMode={viewMode} focusedIndex={dockFocusIdx} />
    </Box>
  );

  return (
    <FullscreenModeContext.Provider value={fullscreenModeValue}>
      <FullscreenLayout
        scrollable={scrollableContent}
        bottom={bottomContent}
        overlay={overlayContent}
        newMessageCount={unseenCount}
        showPill={showPill}
        onJumpToNew={onScrollToBottom}
      />
    </FullscreenModeContext.Provider>
  );
}
