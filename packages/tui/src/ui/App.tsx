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
import { CommandInput } from "./components/CommandInput.js";
import { ToolCallStart, ToolCallRunning, ToolCallResult } from "./components/ToolCall.js";
import { AgentBlockStart, AgentBlockEnd } from "./components/AgentBlock.js";
import { TaskList } from "./components/TaskList.js";
import { SpinnerWithVerb } from "./components/SpinnerWithVerb.js";
import { StatusLine } from "./components/StatusLine.js";
import { FullscreenLayout, useUnseenDivider } from "./components/FullscreenLayout.js";
import { VirtualMessageList, type VirtualMessageListHandle } from "./components/VirtualMessageList.js";
import {
  FullscreenModeContext,
  INITIAL_FULLSCREEN_MODE,
  useFullscreenMode,
} from "./fullscreen-mode.js";
import {
  MessageContent,
  UserMessage,
  ErrorMessage,
  RateLimitMessage,
  ContextLimitMessage,
  ThinkingMessage,
} from "./components/MessageContent.js";
import { AgentClient } from "@cjhyy/code-shell-core";
import { costTracker } from "@cjhyy/code-shell-core";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { AskUserPrompt } from "./components/AskUserPrompt.js";
import { OnboardingPrompt } from "./components/OnboardingPrompt.js";
import { ModelSelector, type ModelEntry } from "./components/ModelSelector.js";
import {
  ModelManager,
  type ArenaParticipantEntry,
  type ProviderManagerEntry,
} from "./components/ModelManager.js";
import { ProviderModelFlow } from "./components/ProviderModelFlow.js";
import { SessionPicker, type SessionPickerEntry } from "./components/SessionPicker.js";
import type { OnboardingResult } from "@cjhyy/code-shell-core";
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
import { goalCommand } from "../cli/commands/builtin/goal-command.js";
import { imageCommand } from "../cli/commands/builtin/image-command.js";
import { buildPluginSlashCommands } from "../cli/commands/builtin/plugin-commands-registration.js";
import type { ApprovalRequest, ApprovalResult, StreamEvent, TaskInfo } from "@cjhyy/code-shell-core";
import { chatStore, createEntry, type ChatEntry } from "./store.js";
import { nextPermissionMode, permissionConfigurePayload, type TuiPermissionMode } from "./permission-mode.js";
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

// UI-scoped child logger — system-log lines route to ui-ink-*.log so engine
// traces aren't drowned by 200ms spinner ticks and per-stream-event logs.
// Per-session UI events go through recordUIEvent (writes to ui.jsonl + the
// unified engine.jsonl) so display bugs can be aligned with LLM responses
// by sid.
const uiLog = logger.child({ cat: "ui" });

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

  const queryGuard = useRef(new QueryGuard()).current;
  const isQueryActive = useSyncExternalStore(
    queryGuard.subscribe,
    queryGuard.getSnapshot,
  );
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
  useEffect(() => { sidRef.current = sessionId; }, [sessionId]);
  const [model, setModel] = useState(initialModel);
  const [activeMaxContextTokens, setActiveMaxContextTokens] = useState(maxContextTokens);
  const pendingContextRef = useRef<string | null>(null);
  // Image attachments staged by the `/image` command, drained on next
  // submitToEngine. See `cli/commands/builtin/image-command.ts`.
  const pendingImagesRef = useRef<string[]>([]);
  // Persistent goal (CC /goal) staged by the `/goal` command, drained on the
  // next submitToEngine. Once set in core it persists across sends until met
  // or cleared, so we only need to pass it on the submit that establishes it.
  const pendingGoalRef = useRef<string | null>(null);
  // Best-effort mirror of the session's active goal objective for /goal status.
  // Set when /goal submits one, cleared on /goal clear or a goal_progress(met).
  const activeGoalRef = useRef<string | null>(null);
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
  const [pendingQuestion, setPendingQuestion] = useState<{
    requestId: string;
    question: string;
    header?: string;
    options?: { label: string; description: string }[];
    multiSelect?: boolean;
  } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [modelEntries, setModelEntries] = useState<ModelEntry[] | null>(null);
  const [sessionEntries, setSessionEntries] = useState<SessionPickerEntry[] | null>(null);
  const [modelManager, setModelManager] = useState<{
    entries: ModelEntry[];
    snapshot: { count: number; fetchedAt: string };
    arenaParticipants: ArenaParticipantEntry[];
    providers: ProviderManagerEntry[];
  } | null>(null);
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

  // P1.6: Transcript mode — toggle between prompt and read-only transcript view
  const [screen, setScreen] = useState<"prompt" | "transcript">("prompt");
  // P1.8: Message selector cursor
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);

  // Session persistence is owned by the server-side Engine; the client only
  // tracks `sessionId` for display and for re-passing on subsequent runs.

  // Unseen message divider tracking
  const { dividerIndex, showPill, unseenCount, onScrollToBottom: clearUnseen } =
    useUnseenDivider(chatLog.length);
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
          header: typeof (args as { header?: unknown }).header === "string"
            ? ((args as { header: string }).header)
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

    const gap = lastFlushAtRef.current === 0 ? 0 : flushEnter - lastFlushAtRef.current;
    const scheduledAt = flushScheduledAtRef.current;
    const timerDelay = scheduledAt === 0 ? 0 : flushEnter - scheduledAt - 50; // 50 = setTimeout target
    flushScheduledAtRef.current = 0;
    lastFlushAtRef.current = flushEnter;
    let pendingChars = 0;
    for (const v of pending.values()) pendingChars += v.length;

    const updateStart = performance.now();

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
    flushUpdateMsRef.current = performance.now() - updateStart;

    uiLog.info("debug.ui.flush", {
      agents: Array.from(pending.keys()).map((k) => k ?? "(main)"),
      chars: pendingChars,
      gapSinceLastFlush_ms: gap,
      timerDelayOverSchedule_ms: Math.max(0, timerDelay),
      chatStoreUpdate_ms: Math.round(flushUpdateMsRef.current * 10) / 10,
    });
  }, []);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (thinkingFlushTimerRef.current) clearTimeout(thinkingFlushTimerRef.current);
    };
  }, []);

  // ─── Stream event handler (wired to client) ───────────────────

  const handleStreamEvent = useCallback(
    (event: StreamEvent) => {
      const agentId = (event as any).agentId as string | undefined;
      uiLog.info("debug.stream.event", { type: event.type, agentId });
      recordStreamEvent(event.type, agentId);
      // session_started carries the authoritative sid; use it directly so the
      // record lands in the correct dir even before sidRef has caught up.
      const eventSid =
        event.type === "session_started" ? event.sessionId : sidRef.current;
      recordUIEvent(eventSid, "ui.stream_event", { type: event.type, agentId });

      switch (event.type) {
        case "session_started":
          // Server tells us the authoritative sid up-front so /sid works
          // mid-turn. setSessionId at run-completion (line ~672) still runs
          // but is now redundant for the first run; resumed runs already
          // had the sid from initialSessionId.
          setSessionId(event.sessionId);
          // Engine only sends promptTokens > 0 on the first turn of a sid
          // (cold start / cross-process resume). On subsequent turns it sends
          // 0 to avoid clobbering the accurate value we already have from the
          // previous turn's usage_update.
          if (event.promptTokens > 0) {
            uiLog.info("debug.ctx.set", { from: "session_started", value: event.promptTokens });
            recordUIEvent(event.sessionId, "ui.ctx.set", { from: "session_started", value: event.promptTokens });
            setContextTokens(event.promptTokens);
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
            const last = (subAgentDeltaSampleRef.current ?? 0);
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
            // renderer with high-rate setStates. Sampled (one log per
            // arrival is harmless; ChatEntry buffer flush coalesces).
            uiLog.info("flicker.text_delta_arrival", {
              cat: "flicker",
              chunkLen: event.text.length,
              tokens: event.tokens ?? 0,
            });
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
              } as any),
            ];
          });
          break;
        }

        case "agent_start": {
          const ev = event as Extract<StreamEvent, { type: "agent_start" }>;
          chatStore.update((prev) => [
            ...prev,
            entry({ type: "agent_start", agentId: ev.agentId, name: ev.name, description: ev.description, agentType: ev.agentType }),
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
          activeGoalRef.current = ev.objective;
          break;
        }

        case "goal_cleared": {
          activeGoalRef.current = null;
          break;
        }

        case "goal_progress": {
          // The goal is achieved (or gave up) — drop the status mirror.
          const ev = event as Extract<StreamEvent, { type: "goal_progress" }>;
          if (ev.status === "met" || ev.status === "exhausted") activeGoalRef.current = null;
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
          recordUIEvent(sidRef.current, "ui.ctx.usage_update", { promptTokens: event.promptTokens });
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
    [flushTextBuffer],
  );

  // Wire stream events from client
  useEffect(() => {
    // T10 changed onStreamEvent signature to pass an envelope { sessionId, event }.
    // Unwrap to the legacy event-only signature; T12 will properly thread sessionId.
    const envelopeHandler = (envelope: any) => handleStreamEvent(envelope.event);
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
    const [modelsRes, arenaRes, providersRes, snapMod] = await Promise.all([
      client.query("models"),
      client.query("config_get", "arena.participants"),
      client.query("providers"),
      import("@cjhyy/code-shell-core"),
    ]);
    const entries = (modelsRes.data as ModelEntry[]) ?? [];
    const snap = snapMod.getOpenRouterSnapshot();

    // arena.participants: Array<string | { name, model, ... }>. Strings are
    // editable in-place; object entries surface as read-only labels so a
    // hand-crafted settings.json round-trips intact.
    const raw = (arenaRes.data as { value?: unknown })?.value;
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
      const visible = getVisibleAgents(
        asyncAgentRegistry.getSnapshot(),
        Date.now(),
      );
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
        queryGuard.forceEnd("user-cancel");
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
          .configure({ sessionId: sidRef.current ?? sessionId, ...permissionConfigurePayload(next) })
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
      queryGuard.forceEnd("user-cancel");
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
      opts: { asInjection: boolean; chatSummary?: string },
    ): Promise<void> => {
      if (!queryGuard.reserve()) return; // already busy → ignore concurrent submit
      streamingTokensRef.current = 0;
      cancelledRef.current = false;
      // taskManager removed — tasks live in the transcript now; engine
      // emits task_update on resume so the UI re-hydrates without a
      // module-level reset.

      const abortController = new AbortController();
      if (!queryGuard.tryStart(abortController)) {
        // Race-safety check — should be unreachable since reserve just succeeded
        queryGuard.cancelReservation();
        return;
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

        // Drain a staged persistent goal (/goal). Passed only on this submit;
        // core persists it on the session for subsequent bare sends.
        const goal = !opts.asInjection ? pendingGoalRef.current : null;
        pendingGoalRef.current = null;
        const result = goal
          ? await client.run({ task: engineMessage, sessionId: sessionId ?? "", goal })
          : await client.run(engineMessage, sessionId);

        // ESC / Ctrl+C took us through the optimistic-cancel path — UI is
        // already idle, history rewound. Don't append turn-duration / status
        // entries from this resolution (would arrive 1–7s after ESC).
        if (cancelledRef.current) {
          return;
        }

        if (flushTimerRef.current) {
          clearTimeout(flushTimerRef.current);
          flushTimerRef.current = null;
        }
        flushTextBuffer();

        chatStore.update((prev) =>
          prev
            .filter((e) => e.type !== "thinking" && e.type !== "tool_running")
            .map((e) =>
              e.type === "assistant_text" && e.streaming ? { ...e, streaming: false } : e,
            ),
        );

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
        if (!cancelledRef.current) {
          chatStore.update((prev) => [
            ...prev,
            entry({ type: "error", error: friendlyError((err as Error).message) }),
          ]);
        }
      } finally {
        // end() is idempotent — safe to call even if forceEnd already released
        // the guard (ESC/Ctrl+C path).
        queryGuard.end();
      }

      if (!cancelledRef.current) {
        setStreamMode("thinking");
        setThinkingContent(null);
        clearThinkingBuffer();
      }
    },
    [client, sessionId, model, flushTextBuffer, clearThinkingBuffer],
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
    if (notificationSnapshot.length === 0) return;
    if (isQueryActive) return;
    if (input.trim() !== "") return;
    if (overlayOpen) return;
    if (!sessionId) return;

    const items = notificationQueue.drainAll(sessionId);
    if (items.length === 0) return;
    const xml = buildNotificationMessage(items);
    const summary = buildNotificationSummary(items);
    void submitToEngine(xml, { asInjection: true, chatSummary: summary });
  }, [
    notificationSnapshot,
    isQueryActive,
    input,
    overlayOpen,
    submitToEngine,
    sessionId,
  ]);

  const handleSubmit = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;

      const head = trimmed.split(/\s+/)[0]?.toLowerCase();
      const READ_ONLY_WHILE_RUNNING = new Set(["/sid", "/help"]);
      if (isQueryActive && head === "/force") {
        const next = trimmed.slice("/force".length).trim();
        if (next) setQueuedInputs((prev) => [...prev, next]);
        setInput("");
        client
          .cancel(sidRef.current ?? sessionId ?? "", "user-force")
          .catch((err) => uiLog.warn("/force cancel failed", { err: String(err) }));
        return;
      }
      if (isQueryActive && !READ_ONLY_WHILE_RUNNING.has(head ?? "")) {
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
        submitGoal: (objective: string) => {
          pendingGoalRef.current = objective;
          activeGoalRef.current = objective;
          void submitToEngine(objective, { asInjection: false });
        },
        clearGoal: async () => {
          const cleared = await client.goalClear(sidRef.current);
          activeGoalRef.current = null;
          return cleared;
        },
      };
      commandRegistry.dispatch(cmd, cmdCtx);
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
      args={pendingApproval.args}
      cwd={cwd}
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

      {screen === "transcript" ? (
        /* P1.6: Transcript mode footer */
        <Box marginLeft={2}>
          <Text dim>{"Transcript mode · ctrl+o to return · ↑↓ navigate"}</Text>
          {cursorIdx !== null && (
            <Text dim>
              {" · selected: "}
              {cursorIdx + 1}
            </Text>
          )}
        </Box>
      ) : showOnboarding ? (
        <OnboardingPrompt
          existingProviders={(modelManager?.providers ?? []).map((p) => ({
            key: p.key,
            label: p.label ?? p.key,
            kind: p.kind as never,
            baseUrl: p.baseUrl ?? "",
            apiKey: p.apiKey,
          }))}
          existingModelKeys={(modelManager?.entries ?? []).map((e) => e.key)}
          existingModelIds={(modelManager?.entries ?? []).map((e) => e.model)}
          onComplete={async (result: OnboardingResult) => {
            setShowOnboarding(false);
            // startOnboarding pre-loaded modelManager state so the wizard
            // could surface "Use existing providers" — that state was only
            // for the wizard's existingProviders prop, not to actually
            // open the manager panel. Tear it down on exit so the user
            // lands back in chat, not on the ModelManager fallback.
            setModelManager(null);
            // Hot-swap into the engine without a process restart:
            // reloadModels picks up the providers[]/models[] the wizard just
            // wrote to settings.json; the subsequent model switch activates
            // the chosen default. Falls back to the legacy "please restart"
            // message if anything goes wrong.
            try {
              // The wizard already gave us the exact pool alias the user
              // picked — use it as-is. Re-deriving with modelKey() collapsed
              // same-family ids (v4-flash + v4-pro → "deepseek") and silently
              // switched to whichever entry happened to claim the alias first.
              const res = await client.configure({
                sessionId: sidRef.current ?? sessionId,
                reloadModels: true,
                model: result.key,
              });
              const activeModel = applyModelConfigureResult(res, result.model);
              addStatus(`✓ 配置已保存,已切换到: ${result.key} (${activeModel})`);
            } catch (err) {
              addStatus(
                `✓ 配置已保存 (${result.model})。热加载失败,请重启 code-shell: ${(err as Error).message}`,
              );
            }
          }}
          onCancel={() => {
            setShowOnboarding(false);
            // Same teardown as onComplete — see comment above.
            setModelManager(null);
            addStatus("已取消配置。");
          }}
        />
      ) : modelEntries ? (
        <ModelSelector
          entries={modelEntries}
          onSelect={async (key) => {
            setModelEntries(null);
            try {
              const result = await client.configure({ sessionId: sidRef.current ?? sessionId, model: key });
              const newModel = applyModelConfigureResult(result, key);
              addStatus(`✓ 切换到: ${key} (${newModel})`);
            } catch (err) {
              addStatus(`切换失败: ${(err as Error).message}`);
            }
          }}
          onCancel={() => setModelEntries(null)}
        />
      ) : sessionEntries ? (
        <SessionPicker
          entries={sessionEntries}
          onSelect={(id) => {
            setSessionEntries(null);
            // Reuse the existing /resume <id> command path so transcript
            // restoration logic (loadChatEntries, sessionId, status line)
            // stays in one place.
            handleSlashCommand(`/resume ${id}`);
          }}
          onCancel={() => setSessionEntries(null)}
        />
      ) : wizard === "flow" && modelManager ? (
        <ProviderModelFlow
          existingProviders={modelManager.providers.map((p) => ({
            key: p.key,
            label: p.label ?? p.key,
            // ProviderModelFlow expects ProviderConfig (with ProviderKindName).
            // We forward the string verbatim; the flow only uses it for
            // labelling and to drive fetchModelList.
            kind: p.kind as never,
            baseUrl: p.baseUrl ?? "",
            apiKey: p.apiKey,
            protocol: p.protocol as never,
            modelsPath: p.modelsPath,
          }))}
          existingModelKeys={modelManager.entries.map((e) => e.key)}
          existingModelIds={modelManager.entries.map((e) => e.model)}
          detectedEnvKeys={[]}
          switchToNewModelOnFinish={false}
          onFinish={async (result) => {
            const failures: string[] = [];
            try {
              if (result.addedProvider) {
                await client.query("provider_add", {
                  provider: result.addedProvider,
                } as never);
              }
            } catch (err) {
              failures.push(`provider ${result.addedProvider?.key}: ${(err as Error).message}`);
            }
            for (const m of result.addedModels) {
              try {
                await client.query("model_add", { model: m } as never);
              } catch (err) {
                failures.push(`model ${m.key}: ${(err as Error).message}`);
              }
            }
            setWizard(null);
            try { await client.configure({ sessionId: sidRef.current ?? sessionId, reloadModels: true }); } catch { /* best-effort */ }
            await refreshModelManagerState();
            if (failures.length > 0) {
              chatStore.update((prev) => [
                ...prev,
                entry({
                  type: "status",
                  reason: `添加部分失败: ${failures.join("; ")}`,
                }),
              ]);
            }
          }}
          onCancel={() => setWizard(null)}
        />
      ) : modelManager ? (
        <ModelManager
          entries={modelManager.entries}
          snapshot={modelManager.snapshot}
          arenaParticipants={modelManager.arenaParticipants}
          providers={modelManager.providers}
          onSaveArena={async (list) => {
            await client.query("config_set", "arena.participants", list);
            setModelManager((prev) =>
              prev
                ? {
                    ...prev,
                    arenaParticipants: list.map((k) => ({ kind: "key", value: k })),
                  }
                : prev,
            );
          }}
          onSwitch={async (key) => {
            const result = await client.configure({ sessionId: sidRef.current ?? sessionId, model: key });
            applyModelConfigureResult(result, key);
            // Mutate the local panel state so the active marker updates
            // without re-fetching from the server.
            setModelManager((prev) =>
              prev
                ? {
                    ...prev,
                    entries: prev.entries.map((e) => ({ ...e, active: e.key === key })),
                  }
                : prev,
            );
          }}
          onSync={async () => {
            const mod = await import("@cjhyy/code-shell-core");
            const r = await mod.syncOpenRouterCatalog();
            // Refresh the snapshot info shown in the panel header.
            const snapMod = await import("@cjhyy/code-shell-core");
            const snap = snapMod.getOpenRouterSnapshot();
            setModelManager((prev) =>
              prev ? { ...prev, snapshot: { count: snap.count, fetchedAt: snap.fetchedAt } } : prev,
            );
            return r;
          }}
          onOpenFlow={() => setWizard("flow")}
          onRefreshProvider={async (key) => {
            try {
              const res = (await client.query("provider_refresh", { key } as never)) as {
                count?: number;
                error?: string;
              };
              await refreshModelManagerState();
              return { count: res?.count ?? 0, ...(res?.error ? { error: res.error } : {}) };
            } catch (err) {
              return { count: 0, error: (err as Error).message };
            }
          }}
          onDeleteProvider={async (key) => {
            try {
              await client.query("provider_delete", { key } as never);
              await refreshModelManagerState();
              return { ok: true };
            } catch (err) {
              return { ok: false, error: (err as Error).message };
            }
          }}
          onDeleteModel={async (key) => {
            await client.query("model_delete", { key } as never);
            await refreshModelManagerState();
          }}
          onClose={() => setModelManager(null)}
        />
      ) : pendingQuestion ? (
        <AskUserPrompt
          question={pendingQuestion.question}
          header={pendingQuestion.header}
          options={pendingQuestion.options}
          multiSelect={pendingQuestion.multiSelect}
          onAnswer={(answer) => {
            const { requestId } = pendingQuestion;
            setPendingQuestion(null);
            client.approve(requestId, { approved: true, answer }).catch(() => {});
          }}
          onCancel={() => {
            const { requestId } = pendingQuestion;
            setPendingQuestion(null);
            client
              .approve(requestId, { approved: false, reason: "(user declined to answer)" })
              .catch(() => {});
          }}
        />
      ) : (
        !pendingApproval && (
          <>
            {/* Queued-input hint (TODO 2.7): mirror desktop's "已缓存 N 条" so
                input typed during a running turn isn't silently swallowed.
                These flush one-by-one when the turn ends; /force jumps the
                queue by interrupting now. */}
            {queuedInputs.length > 0 && (
              <Box marginLeft={2}>
                <Text dim>
                  {`⌛ 已缓存 ${queuedInputs.length} 条，将在本轮结束后依次发送（/force 立即打断并优先发送）`}
                </Text>
              </Box>
            )}
            <CommandInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              commands={commandDefs}
              placeholder={isRunning ? "Interrupt… (Ctrl+C to cancel)" : undefined}
              disabled={dockFocusIdx !== null}
              onArrowOut={(dir) => {
                if (dir !== "down") return;
                const visible = getVisibleAgents(
                  asyncAgentRegistry.getSnapshot(),
                  Date.now(),
                );
                if (visible.length === 0) return;
                // Restore focus to the row we're currently viewing, so the
                // user doesn't have to scroll back down to the agent they
                // were just looking at. main row = idx 0, agents are 1..N.
                if (viewMode.kind === "agent") {
                  const idx = visible.findIndex((a) => a.agentId === viewMode.agentId);
                  // Cap at MAX_VISIBLE since the dock only shows that many.
                  if (idx >= 0 && idx < MAX_VISIBLE) {
                    setDockFocusIdx(idx + 1);
                    return;
                  }
                }
                setDockFocusIdx(0);
              }}
            />
          </>
        )
      )}

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

// ─── Entry Renderer ──────────────────────────────────────────────

function renderEntry(entry: ChatEntry, key: string, expanded = false) {
  const nested = !!(entry as any).agentId;

  switch (entry.type) {
    case "user":
      return <UserMessage key={key} text={entry.text} />;

    case "assistant_text":
      if (nested) {
        return (
          <Box key={key} marginLeft={1}>
            <Text dim>│ ⎿ </Text>
            <MessageContent text={entry.text} streaming={entry.streaming} nested />
          </Box>
        );
      }
      return <MessageContent key={key} text={entry.text} streaming={entry.streaming} />;

    case "thinking":
      // Main spinner is shown as SpinnerWithVerb component above;
      // only render inline thinking for nested agents
      if (!nested) return null;
      return (
        <Box key={key} marginLeft={1}>
          <Text dim>│ ⎿ </Text>
          <ThinkingMessage content={entry.content} collapsed={!expanded} nested />
        </Box>
      );

    case "tool_start":
      return (
        <ToolCallStart key={key} toolName={entry.toolName} args={entry.args} nested={nested} />
      );

    case "tool_running":
      return <ToolCallRunning key={key} toolName={entry.toolName} nested={nested} />;

    case "tool_result":
      return (
        <ToolCallResult
          key={key}
          toolName={entry.toolName}
          result={entry.result}
          error={entry.error}
          nested={nested}
          expanded={expanded}
        />
      );

    case "agent_start":
      return (
        <AgentBlockStart
          key={key}
          name={entry.name}
          agentType={entry.agentType}
          description={entry.description}
          running
        />
      );

    case "agent_end":
      return (
        <AgentBlockEnd
          key={key}
          name={entry.name}
          agentType={entry.agentType}
          description={entry.description}
          text={entry.text}
          error={entry.error}
        />
      );

    case "error": {
      const kind = (entry as any).errorKind;
      if (kind === "rate_limit") {
        return <RateLimitMessage key={key} text={entry.error} />;
      }
      if (kind === "context_limit") {
        return <ContextLimitMessage key={key} />;
      }
      return (
        <Box key={key} marginLeft={nested ? 1 : 0}>
          {nested && <Text dim>│ ⎿ </Text>}
          <ErrorMessage error={entry.error} nested={nested} />
        </Box>
      );
    }

    case "system": {
      const sysEntry = entry as ChatEntry & { type: "system" };
      if (sysEntry.subtype === "compact_boundary") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text dim>{sysEntry.text ?? "── context compacted ──"}</Text>
          </Box>
        );
      }
      if (sysEntry.subtype === "memory_saved") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text color="ansi:magenta">{"✦ "}</Text>
            <Text dim>{sysEntry.text ?? "Memory saved"}</Text>
          </Box>
        );
      }
      if (sysEntry.subtype === "turn_duration") {
        return (
          <Box key={key} marginLeft={1} marginTop={1}>
            <Text dim>{sysEntry.text}</Text>
          </Box>
        );
      }
      if (sysEntry.subtype === "bg_agent_notification") {
        // Pre-formatted by buildNotificationSummary — already a multi-line
        // string. Render each line with dim styling so it reads as a
        // system marker, not as user content.
        const lines = (sysEntry.text ?? "").split("\n");
        return (
          <Box key={key} flexDirection="column" marginLeft={1} marginTop={1}>
            {lines.map((line, i) => (
              <Text key={i} dim>{line}</Text>
            ))}
          </Box>
        );
      }
      return (
        <Box key={key} marginLeft={1} marginTop={1}>
          <Text dim>{sysEntry.text ?? ""}</Text>
        </Box>
      );
    }

    case "status":
      return (
        <Box key={key} marginLeft={1} marginTop={1}>
          <Text dim>{entry.reason}</Text>
        </Box>
      );
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

function findLastIndex<T>(arr: T[], predicate: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (predicate(arr[i])) return i;
  }
  return -1;
}

/**
 * Map a TerminalReason (or raw SDK error string) to a user-facing line.
 * Keep the technical name in parentheses so logs / bug reports stay
 * grep-able, but lead with something a human can act on.
 */
function friendlyReason(reason: string): string {
  switch (reason) {
    case "aborted_streaming":
    case "aborted_tools":
      return "已中断";
    case "model_error":
      return "模型调用失败 — 检查网络 / API key / 配额后重试";
    case "prompt_too_long":
      return "上下文超长 — 用 /compact 压缩,或开新会话";
    case "max_turns":
      return "达到最大回合数 — 可继续输入推进";
    case "goal_budget_exhausted":
      return "目标预算已耗尽 — 调高 token/时间预算后重试";
    case "hook_stopped":
    case "stop_hook_prevented":
      return "被 hook 拦截 — 检查 settings.json 中的 hook 配置";
    case "image_error":
      return "图片处理失败";
    case "completed":
      return "";
    default:
      return reason;
  }
}

/**
 * Friendlify an SDK error message. Catches the common patterns
 * ("OpenAI API error: Request was aborted.", auth, rate-limit, network)
 * and rewrites them; leaves anything unrecognized intact so we never hide
 * a real bug.
 */
function friendlyError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("aborted") || m.includes("abort")) return "已中断";
  if (m.includes("401") || m.includes("unauthorized") || m.includes("invalid api key")) {
    return "API key 无效或已过期 — 检查 /providers";
  }
  if (m.includes("429") || m.includes("rate limit") || m.includes("quota")) {
    return "触发限流 / 配额耗尽 — 稍后再试,或切换模型";
  }
  if (m.includes("timeout") || m.includes("etimedout") || m.includes("econnreset")) {
    return "网络超时 — 检查连接后重试";
  }
  if (m.includes("enotfound") || m.includes("getaddrinfo")) {
    return "无法解析模型服务地址 — 检查 DNS / 代理设置";
  }
  if (m.includes("context length") || m.includes("maximum context") || m.includes("too long")) {
    return "上下文超长 — 用 /compact 压缩,或开新会话";
  }
  return msg;
}

// ─── Mode Indicator ─────────────────────────────────────────────

const MODE_DISPLAY: Record<string, { symbol: string; title: string; color: string }> = {
  plan: { symbol: "⏵  ", title: "plan  read-only", color: "ansi:yellow" },
  normal: { symbol: "⏵⏵ ", title: "auto-accept edits", color: "ansi:cyan" },
  bypass: { symbol: "⏵⏵⏵", title: "bypass permissions", color: "ansi:red" },
};

function ModeIndicator({ mode }: { mode: "plan" | "normal" | "bypass" }) {
  const d = MODE_DISPLAY[mode];
  return (
    <Box>
      <Text color={d.color}>{d.symbol}</Text>
      <Text dim>{" " + d.title + " "}</Text>
      <Text dim>{"(shift+tab)"}</Text>
    </Box>
  );
}

// ─── Error Classification ───────────────────────────────────────

function classifyError(error: string): import("./store.js").ErrorKind {
  const lower = error.toLowerCase();
  if (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests")
  ) {
    return "rate_limit";
  }
  if (
    lower.includes("context") &&
    (lower.includes("limit") || lower.includes("too long") || lower.includes("too many tokens"))
  ) {
    return "context_limit";
  }
  if (
    lower.includes("invalid") &&
    (lower.includes("api key") || lower.includes("api_key") || lower.includes("authentication"))
  ) {
    return "invalid_api_key";
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return "api_timeout";
  }
  if (lower.includes("credit") || lower.includes("balance") || lower.includes("billing")) {
    return "credit_balance";
  }
  return "generic";
}
