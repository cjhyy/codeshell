/**
 * Main Ink App — the root component for Code Shell's terminal UI.
 *
 * Uses AgentClient (protocol layer) instead of Engine directly.
 * All engine interaction goes through the client-server protocol.
 */
import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput } from "../render/index.js";
import { Banner } from "./components/Banner.js";
import { WelcomeTips } from "./components/WelcomeTips.js";
import { CommandInput } from "./components/CommandInput.js";
import { ToolCallStart, ToolCallRunning, ToolCallResult } from "./components/ToolCall.js";
import { AgentBlockStart, AgentBlockEnd } from "./components/AgentBlock.js";
import { TaskList } from "./components/TaskList.js";
import { SpinnerWithVerb } from "./components/SpinnerWithVerb.js";
import { StatusLine } from "./components/StatusLine.js";
import { FullscreenLayout, useUnseenDivider } from "./components/FullscreenLayout.js";
import { VirtualMessageList } from "./components/VirtualMessageList.js";
import {
  MessageContent,
  UserMessage,
  ErrorMessage,
  RateLimitMessage,
  ContextLimitMessage,
  ThinkingMessage,
} from "./components/MessageContent.js";
import { AgentClient } from "../protocol/client.js";
import { taskManager } from "../tool-system/builtin/task.js";
import { costTracker } from "../cli/cost-tracker.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { AskUserPrompt } from "./components/AskUserPrompt.js";
import { OnboardingPrompt } from "./components/OnboardingPrompt.js";
import { ModelSelector, type ModelEntry } from "./components/ModelSelector.js";
import { SessionPicker, type SessionPickerEntry } from "./components/SessionPicker.js";
import type { OnboardingResult } from "../cli/onboarding.js";
import { CommandRegistry } from "../cli/commands/registry.js";
import type { RestoredChatEntry } from "../cli/commands/registry.js";
import { coreCommands } from "../cli/commands/builtin/core-commands.js";
import { gitCommands } from "../cli/commands/builtin/git-commands.js";
import { permissionsCommand } from "../cli/commands/builtin/permissions-command.js";
import { utilityCommands } from "../cli/commands/builtin/utility-commands.js";
import { advancedCommands } from "../cli/commands/builtin/advanced-commands.js";
import { extraCommands } from "../cli/commands/builtin/extra-commands.js";
import { moreCommands } from "../cli/commands/builtin/more-commands.js";
import type { ApprovalRequest, ApprovalResult, StreamEvent, TaskInfo } from "../types.js";
import { chatStore, createEntry, type ChatEntry } from "./store.js";
import { SessionManager, type SessionBundle } from "../session/session-manager.js";
import { formatDuration, formatTokens } from "../utils/format.js";
import { removeLastFromHistory } from "./input-history.js";

// ─── Global command registry ────────────────────────────────────

const commandRegistry = new CommandRegistry();
commandRegistry.registerAll(coreCommands);
commandRegistry.registerAll(gitCommands);
commandRegistry.register(permissionsCommand);
commandRegistry.registerAll(utilityCommands);
commandRegistry.registerAll(advancedCommands);
commandRegistry.registerAll(extraCommands);
commandRegistry.registerAll(moreCommands);

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

export function App({ client, model: initialModel, effort, maxTurns, cwd, maxContextTokens, sessionId: initialSessionId, prefill }: AppProps) {
  const { exit } = useApp();
  const [input, setInput] = useState(prefill ?? "");
  const chatLog = useSyncExternalStore(
    chatStore.subscribe.bind(chatStore),
    chatStore.getEntries.bind(chatStore),
  );
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const tasksTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (tasks.length > 0 && tasks.every((t) => t.status === "completed" || t.status === "stopped")) {
      tasksTimerRef.current = setTimeout(() => setTasks([]), 3000);
    }
    return () => {
      if (tasksTimerRef.current) clearTimeout(tasksTimerRef.current);
    };
  }, [tasks]);

  const [isRunning, setIsRunning] = useState(false);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const [model, setModel] = useState(initialModel);
  const pendingContextRef = useRef<string | null>(null);
  const [showBanner, setShowBanner] = useState(true);
  const [totalTokens, setTotalTokens] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [contextTokens, setContextTokens] = useState(0);
  const [currentEffort, setCurrentEffort] = useState(effort);
  const [permMode, setPermMode] = useState<"plan" | "normal" | "bypass">("normal");
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
  } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [modelEntries, setModelEntries] = useState<ModelEntry[] | null>(null);
  const [sessionEntries, setSessionEntries] = useState<SessionPickerEntry[] | null>(null);

  // Track streaming chars in a ref — no App-level re-render per tick.
  // StatusLine reads these refs directly via its own internal interval.
  const streamingCharsRef = useRef(0);
  const runStartRef = useRef(0);
  const [streamMode, setStreamMode] = useState<"responding" | "tool-use" | "thinking">("thinking");
  const [thinkingContent, setThinkingContent] = useState<string | null>(null);

  // P1.6: Transcript mode — toggle between prompt and read-only transcript view
  const [screen, setScreen] = useState<"prompt" | "transcript">("prompt");
  // P1.8: Message selector cursor
  const [cursorIdx, setCursorIdx] = useState<number | null>(null);

  // ─── Session persistence ──────────────────────────────────────
  const sessionBundleRef = useRef<SessionBundle | null>(null);

  // Create or attach session on mount
  useEffect(() => {
    const sm = new SessionManager();
    if (initialSessionId) {
      try {
        sessionBundleRef.current = sm.resume(initialSessionId);
      } catch {
        // Session not found — create fresh
        sessionBundleRef.current = sm.create(cwd, model, "openai");
      }
    } else {
      sessionBundleRef.current = sm.create(cwd, model, "openai");
    }

    // Mark completed on unmount
    return () => {
      const bundle = sessionBundleRef.current;
      if (bundle) {
        bundle.state.status = "completed";
        sm.saveState(bundle.state);
      }
    };
  }, []); // mount-only

  // Unseen message divider tracking
  const { dividerIndex, showPill, unseenCount, onScrollToBottom } =
    useUnseenDivider(chatLog.length);

  useEffect(() => {
    if (isRunning) {
      runStartRef.current = Date.now();
    }
  }, [isRunning]);

  // ─── Wire client events ───────────────────────────────────────

  useEffect(() => {
    // Handle approval requests from the server
    const handleApproval = (requestId: string, request: ApprovalRequest) => {
      // __ask_user__ is a question, not a tool approval — routed to the
      // text-input prompt instead of the y/n permission dialog.
      if (request.toolName === "__ask_user__") {
        setPendingQuestion({
          requestId,
          question: request.description,
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

  const flushTextBuffer = useCallback(() => {
    flushTimerRef.current = null;
    const buf = textBufferRef.current;
    if (buf.size === 0) return;

    const pending = new Map(buf);
    buf.clear();

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
  }, []);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  // ─── Stream event handler (wired to client) ───────────────────

  const handleStreamEvent = useCallback((event: StreamEvent) => {
    const agentId = (event as any).agentId as string | undefined;

    switch (event.type) {
      case "stream_request_start":
        setStreamMode("thinking");
        setThinkingContent(null);
        chatStore.update((prev) => {
          const filtered = prev.filter(
            (e) => !(e.type === "thinking" && e.agentId === agentId),
          );
          return [...filtered, entry({ type: "thinking", agentId })];
        });
        break;

      case "thinking_delta":
        setThinkingContent((prev) => (prev ?? "") + event.text);
        break;

      case "text_delta": {
        setStreamMode("responding");
        const existing = textBufferRef.current.get(agentId) ?? "";
        textBufferRef.current.set(agentId, existing + event.text);
        streamingCharsRef.current += event.text.length;
        if (!flushTimerRef.current) {
          flushTimerRef.current = setTimeout(flushTextBuffer, 50);
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
            entry({ type: "tool_start", toolName: tc.toolName, args: tc.args, toolCallId: tc.id, agentId }),
            entry({ type: "tool_running", toolName: tc.toolName, agentId }),
          ];
        });
        break;
      }

      case "tool_use_args_delta": {
        if (agentId !== undefined) break;
        const { toolCallId, args } = event;
        chatStore.update((prev) =>
          prev.map((e) =>
            e.type === "tool_start" && e.toolCallId === toolCallId
              ? { ...e, args }
              : e,
          ),
        );
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
          entry({ type: "agent_start", agentId: ev.agentId, description: ev.description }),
        ]);
        break;
      }

      case "agent_end": {
        const ev = event as Extract<StreamEvent, { type: "agent_end" }>;
        chatStore.update((prev) => {
          const filtered = prev.filter(
            (e) =>
              !((e as any).agentId === ev.agentId &&
                (e.type === "thinking" || e.type === "tool_running")),
          );
          return [
            ...filtered,
            entry({ type: "agent_end", agentId: ev.agentId, description: ev.description, error: ev.error }),
          ];
        });
        break;
      }

      case "task_update": {
        const taskEvent = event as any;
        if (taskEvent.tasks) setTasks(taskEvent.tasks);
        break;
      }

      case "error": {
        const errorText = event.error;
        const errorKind = classifyError(errorText);
        chatStore.update((prev) => {
          const filtered = prev.filter(
            (e) =>
              !(e.type === "thinking" && e.agentId === agentId) &&
              !(e.type === "tool_running" && e.agentId === agentId),
          );
          return [...filtered, entry({ type: "error", error: errorText, errorKind, agentId })];
        });
        break;
      }
    }
  }, [flushTextBuffer]);

  // Wire stream events from client
  useEffect(() => {
    client.onStreamEvent(handleStreamEvent);
    return () => client.offStreamEvent(handleStreamEvent);
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

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (isRunning) {
        // P0.5: Preserve already-streamed text before cancelling
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
        client.cancel().catch(() => {});
      } else {
        exit();
      }
    }

    // Shift+Tab: cycle permission mode (plan → normal → bypass → plan)
    if (key.shift && key.tab && !isRunning) {
      setPermMode((prev) => {
        const modes: Array<"plan" | "normal" | "bypass"> = ["plan", "normal", "bypass"];
        const next = modes[(modes.indexOf(prev) + 1) % modes.length];

        // Notify server of mode change
        client.configure({
          planMode: next === "plan",
          bypassPermissions: next === "bypass",
        }).catch(() => {});

        return next;
      });
    }

    // ESC — cancel running request (same as Ctrl+C) or clear input
    if (key.escape && isRunning) {
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
      client.cancel().catch(() => {});
      // Undo the last history entry since the request was interrupted
      removeLastFromHistory();
    }

    // Alt+M / Esc+M — open model selector. (Ctrl+M is unusable: terminals
    // alias it to Enter, so it would collide with submitting the input.)
    if (key.meta && ch === "m" && !isRunning && !showOnboarding && !modelEntries) {
      openModelSelector();
      return;
    }

    // P1.6: Ctrl+O — toggle transcript mode
    if (key.ctrl && ch === "o" && !isRunning) {
      setScreen((prev) => {
        if (prev === "transcript") {
          setCursorIdx(null);
          return "prompt";
        }
        return "transcript";
      });
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


  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isRunning) return;

    setInput("");
    setShowBanner(false);
    onScrollToBottom(); // Repin unseen divider on submit

    if (trimmed.startsWith("/")) {
      handleSlashCommand(trimmed);
      return;
    }

    chatStore.update((prev) => [...prev, entry({ type: "user", text: trimmed })]);
    setIsRunning(true);
    streamingCharsRef.current = 0;
    taskManager.reset();

    try {
      // If a slash command (e.g. /arena) stored context, prepend it to
      // the user message so the engine LLM can see it.
      let engineMessage = trimmed;
      if (pendingContextRef.current) {
        engineMessage = `<context>\n${pendingContextRef.current}\n</context>\n\n${trimmed}`;
        pendingContextRef.current = null;
      }

      // Stream events are handled via the client event listener above
      const result = await client.run(engineMessage, sessionId);

      // Flush any remaining buffered text
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      flushTextBuffer();

      // Finalize all streaming text
      chatStore.update((prev) =>
        prev
          .filter((e) => e.type !== "thinking" && e.type !== "tool_running")
          .map((e) =>
            e.type === "assistant_text" && e.streaming ? { ...e, streaming: false } : e,
          ),
      );

      setSessionId(result.sessionId);

      // Token recording happens centrally via LLMClientBase.onUsage —
      // we just refresh the displayed totals here.
      if (result.usage && result.usage.totalTokens > 0) {
        setContextTokens(result.usage.promptTokens);
      }
      setTotalTokens(costTracker.getTotalTokens().total);
      setTotalCost(costTracker.getEstimatedCost());

      // P0.3 + P0.4: Turn duration + cost message
      const elapsed = Date.now() - runStartRef.current;
      const turnCost = result.usage ? costTracker.estimateForTokens(model, result.usage.promptTokens, result.usage.completionTokens) : 0;
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
        chatStore.update((prev) => [...prev, entry({ type: "status", reason: result.reason })]);
      }

      // P0.1: Session persistence — write turn to disk
      const bundle = sessionBundleRef.current;
      if (bundle) {
        bundle.transcript.appendMessage("user", trimmed);
        // Capture assistant text from the finalized chatLog
        const currentLog = chatStore.getEntries();
        const assistantTexts = currentLog
          .filter((e) => e.type === "assistant_text" && !e.streaming && !(e as any).agentId)
          .map((e) => (e as any).text as string);
        if (assistantTexts.length > 0) {
          bundle.transcript.appendMessage("assistant", assistantTexts[assistantTexts.length - 1]);
        }
        // Write tool uses and results
        for (const e of currentLog) {
          if (e.type === "tool_start" && !(e as any).agentId) {
            bundle.transcript.appendToolUse(e.toolName, e.id, e.args);
          } else if (e.type === "tool_result" && !(e as any).agentId) {
            bundle.transcript.appendToolResult(e.id, e.toolName, e.result, e.error);
          }
        }
        bundle.transcript.appendTurnBoundary();
        bundle.state.turnCount = result.turnCount;
        bundle.state.sessionId = result.sessionId;
        bundle.state.tokenUsage = {
          promptTokens: (bundle.state.tokenUsage?.promptTokens ?? 0) + (result.usage?.promptTokens ?? 0),
          completionTokens: (bundle.state.tokenUsage?.completionTokens ?? 0) + (result.usage?.completionTokens ?? 0),
          totalTokens: (bundle.state.tokenUsage?.totalTokens ?? 0) + (result.usage?.totalTokens ?? 0),
        };
        new SessionManager().saveState(bundle.state);
      }
    } catch (err) {
      chatStore.update((prev) => [...prev, entry({ type: "error", error: (err as Error).message })]);
    }

    setIsRunning(false);
    setStreamMode("thinking");
    setThinkingContent(null);
  }, [client, sessionId, model, isRunning, flushTextBuffer]);

  const handleSlashCommand = useCallback((cmd: string) => {
    if (cmd.trim().toLowerCase() === "/help") {
      addStatus(commandRegistry.helpText());
      return;
    }

    const cmdCtx = {
      client,
      cwd,
      model,
      setModel,
      sessionId,
      setSessionId,
      setIsRunning,
      addStatus,
      addMessage,
      setNextContext: (text: string) => { pendingContextRef.current = text; },
      exit,
      effort: currentEffort,
      setEffort: setCurrentEffort,
      tasks,
      clearChat: () => { chatStore.clear(); setTasks([]); },
      chatLog,
      startOnboarding: () => setShowOnboarding(true),
      openModelSelector,
      openSessionPicker,
      loadChatEntries: (entries: RestoredChatEntry[]) => {
        const chatEntries: ChatEntry[] = entries.map((e) => {
          switch (e.type) {
            case "user":
              return entry({ type: "user", text: e.text ?? "" });
            case "assistant_text":
              return entry({ type: "assistant_text", text: e.text ?? "", streaming: false });
            case "tool_start":
              return entry({ type: "tool_start", toolName: e.toolName ?? "", args: e.args ?? {} });
            case "tool_result":
              return entry({ type: "tool_result", toolName: e.toolName ?? "", result: e.result, error: e.error });
            case "status":
              return entry({ type: "status", reason: e.text ?? "" });
            default:
              return entry({ type: "status", reason: "" });
          }
        }).filter((e) => !(e.type === "status" && (e as any).reason === ""));
        chatStore.setEntries(chatEntries);
        setTasks([]);
      },
    };
    commandRegistry.dispatch(cmd, cmdCtx);
  }, [client, cwd, model, setModel, sessionId, currentEffort, tasks, chatLog, exit, openModelSelector, openSessionPicker]);

  const addStatus = (reason: string) => {
    chatStore.update((prev) => [...prev, entry({ type: "status", reason })]);
  };

  const addMessage = (text: string) => {
    chatStore.update((prev) => [...prev, entry({ type: "assistant_text", text, streaming: false })]);
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

  const renderEntryWithCursor = useCallback(
    (e: ChatEntry, key: string) => {
      const isSelected = selectedEntryId === e.id;
      const rendered = renderEntry(e, key, isTranscript);
      if (!isSelected || !rendered) return rendered;
      return (
        <Box key={key} borderStyle="single" borderColor="ansi:cyan" borderLeft borderRight={false} borderTop={false} borderBottom={false} paddingLeft={1}>
          {rendered}
        </Box>
      );
    },
    [selectedEntryId, isTranscript],
  );

  const scrollableContent = (
    <>
      {showBanner && (
        <>
          <Banner model={model} effort={currentEffort} maxTurns={maxTurns} cwd={cwd} />
          {!initialSessionId && <WelcomeTips cwd={cwd} />}
        </>
      )}

      {/* Chat log — virtualized for large conversations */}
      <VirtualMessageList
        entries={chatLog}
        renderEntry={renderEntryWithCursor}
        dividerIndex={dividerIndex}
        unseenCount={unseenCount}
      />

      {/* Spinner with verb (when loading) */}
      {isRunning && (
        <SpinnerWithVerb
          mode={streamMode}
          streamingCharsRef={streamingCharsRef}
          runStartRef={runStartRef}
          thinkingContent={thinkingContent ?? undefined}
        />
      )}

      {/* Task list */}
      {tasks.length > 0 && <TaskList tasks={tasks} />}
    </>
  );

  const overlayContent = pendingApproval ? (
    <PermissionPrompt
      toolName={pendingApproval.toolName}
      description={pendingApproval.description}
      riskLevel={pendingApproval.riskLevel}
      args={pendingApproval.args}
      cwd={cwd}
      onDecision={(approved, always) => {
        const { requestId } = pendingApproval;
        setPendingApproval(null);
        client.approve(requestId, approved
          ? { approved: true, always }
          : { approved: false, always },
        ).catch(() => {});
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
            <Text dim>{" · selected: "}{cursorIdx + 1}</Text>
          )}
        </Box>
      ) : showOnboarding ? (
        <OnboardingPrompt
          onComplete={(result: OnboardingResult) => {
            setShowOnboarding(false);
            addStatus(`✓ 配置已保存 (${result.model})。重启 code-shell 以加载新配置。`);
          }}
          onCancel={() => {
            setShowOnboarding(false);
            addStatus("已取消配置。");
          }}
        />
      ) : modelEntries ? (
        <ModelSelector
          entries={modelEntries}
          onSelect={async (key) => {
            setModelEntries(null);
            try {
              const result = await client.configure({ model: key });
              const data = result as { model?: string };
              const newModel = data?.model ?? key;
              setModel(newModel);
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
      ) : pendingQuestion ? (
        <AskUserPrompt
          question={pendingQuestion.question}
          onAnswer={(answer) => {
            const { requestId } = pendingQuestion;
            setPendingQuestion(null);
            client.approve(requestId, { approved: true, answer }).catch(() => {});
          }}
          onCancel={() => {
            const { requestId } = pendingQuestion;
            setPendingQuestion(null);
            client.approve(requestId, { approved: false, reason: "(user declined to answer)" }).catch(() => {});
          }}
        />
      ) : (
        !pendingApproval && (
          <CommandInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            commands={commandDefs}
            placeholder={isRunning ? "Interrupt… (Ctrl+C to cancel)" : undefined}
          />
        )
      )}

      <Text dim>{separator}</Text>

      <Box wrap="truncate">
        <ModeIndicator mode={permMode} />
        {screen === "transcript" && (
          <Text color="ansi:magenta">{" TRANSCRIPT "}</Text>
        )}
        <Box flexGrow={1} />
        <StatusLine
          model={model}
          effort={currentEffort}
          tokens={totalTokens}
          cost={totalCost}
          sessionId={sessionId}
          contextPercent={contextTokens > 0 ? Math.min((contextTokens / maxContextTokens) * 100, 100) : 0}
          isRunning={isRunning}
          streamingCharsRef={streamingCharsRef}
          runStartRef={runStartRef}
        />
      </Box>
    </Box>
  );

  return (
    <FullscreenLayout
      scrollable={scrollableContent}
      bottom={bottomContent}
      overlay={overlayContent}
      newMessageCount={unseenCount}
      showPill={showPill}
      onJumpToNew={onScrollToBottom}
    />
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
            <Text dim>│  ⎿  </Text>
            <MessageContent text={entry.text} streaming={entry.streaming} />
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
          <Text dim>│  ⎿  </Text>
          <ThinkingMessage content={entry.content} collapsed={!expanded} />
        </Box>
      );

    case "tool_start":
      return <ToolCallStart key={key} toolName={entry.toolName} args={entry.args} nested={nested} />;

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
      return <AgentBlockStart key={key} description={entry.description} running />;

    case "agent_end":
      return <AgentBlockEnd key={key} description={entry.description} error={entry.error} />;

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
          {nested && <Text dim>│  ⎿  </Text>}
          <ErrorMessage error={entry.error} />
        </Box>
      );
    }

    case "system": {
      const sysEntry = entry as ChatEntry & { type: "system" };
      if (sysEntry.subtype === "compact_boundary") {
        return (
          <Box key={key} marginLeft={1}>
            <Text dim>{"── context compacted ──"}</Text>
          </Box>
        );
      }
      if (sysEntry.subtype === "memory_saved") {
        return (
          <Box key={key} marginLeft={1}>
            <Text color="ansi:magenta">{"✦ "}</Text>
            <Text dim>{sysEntry.text ?? "Memory saved"}</Text>
          </Box>
        );
      }
      if (sysEntry.subtype === "turn_duration") {
        return (
          <Box key={key} marginLeft={1}>
            <Text dim>{sysEntry.text}</Text>
          </Box>
        );
      }
      return (
        <Box key={key} marginLeft={1}>
          <Text dim>{sysEntry.text ?? ""}</Text>
        </Box>
      );
    }

    case "status":
      return (
        <Box key={key} marginLeft={1} marginY={0}>
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

// ─── Mode Indicator ─────────────────────────────────────────────

const MODE_DISPLAY: Record<string, { symbol: string; title: string; color: string }> = {
  plan:   { symbol: "⏵  ", title: "plan  read-only", color: "ansi:yellow" },
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
  if (lower.includes("rate limit") || lower.includes("429") || lower.includes("too many requests")) {
    return "rate_limit";
  }
  if (lower.includes("context") && (lower.includes("limit") || lower.includes("too long") || lower.includes("too many tokens"))) {
    return "context_limit";
  }
  if (lower.includes("invalid") && (lower.includes("api key") || lower.includes("api_key") || lower.includes("authentication"))) {
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
