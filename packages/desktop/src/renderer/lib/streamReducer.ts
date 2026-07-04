/**
 * Mobile chat reducer: folds the worker→renderer JSON-RPC stream (the SAME
 * lines the desktop renderer receives, mirrored via RemoteHostManager.
 * broadcastRaw) into a flat list of view items. It also consumes `session.
 * history` replay, which emits the identical `agent/streamEvent` envelopes, so
 * one reducer serves both live and replay (design §4).
 *
 * Event names mirror core's StreamEvent union (packages/core/src/types.ts):
 *   stream_request_start | text_delta | thinking_delta | tool_use_start |
 *   tool_use_args_delta | tool_result | tool_summary | assistant_message |
 *   turn_complete | goal_progress | task_update | agent_start | agent_end |
 *   error | session_title …
 *
 * Subagent events carry an optional `agentId`. We tag items with it so a future
 * UI can scope subagent rows (see commit fbe6f68 — task_update must be isolated
 * by agentId so a subagent never clobbers the main list).
 */

/** Strip <system-reminder>…</system-reminder> blocks from tool output before
 *  rendering — they're context for the model, not status for the user. */
function stripSystemReminders(s: string): string {
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
}

export type RunState = "idle" | "running" | "waiting" | "completed" | "error";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | {
      kind: "assistant";
      id: string;
      text: string;
      reasoning: string;
      done: boolean;
      agentId?: string;
    }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: Record<string, unknown>;
      result?: string;
      error?: boolean;
      summary?: string;
      done: boolean;
      agentId?: string;
    }
  | { kind: "subagent"; id: string; agentId: string; label: string; status: string }
  | { kind: "system_error"; id: string; text: string };

export interface ChatState {
  items: ChatItem[];
  run: RunState;
  /** Latest goal-progress status line, if any (display-only). */
  goal?: string;
  sessionId?: string;
  /** Per-session title pushed via session_title. */
  title?: string;
  /** Internal: id of the assistant item currently accumulating text/thinking
   *  deltas, keyed by agentId ("" = the main agent). Keying by agent keeps a
   *  concurrently-streaming subagent's text out of the main bubble (and vice
   *  versa) — mirrors the renderer's per-agent message routing. */
  liveByAgent: Record<string, string>;
  /** Internal: monotonic counter for fresh ids (replaces Date.now/random,
   *  which would make replay non-deterministic). */
  seq: number;
  /** Internal: tool_result events that arrived BEFORE their tool_use_start
   *  (WebSocket reordering / buffering). Keyed by tool id; applied when the
   *  matching tool_use_start lands so the result isn't silently lost. */
  orphanResults?: Record<string, { result: string; error: boolean }>;
}

export function initialChatState(): ChatState {
  return { items: [], run: "idle", seq: 0, liveByAgent: {} };
}

/** The agentId bucket key for an event ("" = main agent). */
function agentKey(event: Record<string, unknown>): string {
  return (event.agentId as string | undefined) ?? "";
}

/**
 * Map a core TerminalReason (types.ts) to a phone run-state. Only genuine
 * failures (prompt_too_long / model_error / image_error) are "error"; budget/
 * turn/hook limits are EXPECTED stops and must not flash a red error on the
 * StatusBar. Aborts (user-initiated) drop back to idle. Unknown future reasons
 * default to "completed" rather than "error" — a stop we don't recognize is
 * still a stop, and mislabeling it a failure is the worse default.
 */
function runStateForReason(reason: string): RunState {
  switch (reason) {
    case "aborted_streaming":
    case "aborted_tools":
      return "idle";
    case "prompt_too_long":
    case "model_error":
    case "image_error":
      return "error";
    // "completed", "max_turns", "goal_budget_exhausted", "stop_hook_prevented",
    // "hook_stopped", and any future/unknown terminal reason: a normal stop.
    default:
      return "completed";
  }
}

/** Unwrap an incoming line into the inner StreamEvent, or null if it isn't an
 *  agent/streamEvent envelope. Accepts both the JSON-RPC notification shape
 *  ({method, params:{event, sessionId}}) and a bare event (replay convenience). */
function asStreamEvent(
  raw: unknown,
): { event: Record<string, unknown>; sessionId?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.method === "agent/streamEvent" && obj.params && typeof obj.params === "object") {
    const params = obj.params as Record<string, unknown>;
    if (params.event && typeof params.event === "object") {
      return {
        event: params.event as Record<string, unknown>,
        sessionId: typeof params.sessionId === "string" ? params.sessionId : undefined,
      };
    }
  }
  // Bare event (history replay may hand us {type, …} directly).
  if (typeof obj.type === "string") return { event: obj };
  return null;
}

export function reduceStream(state: ChatState, raw: unknown): ChatState {
  const unwrapped = asStreamEvent(raw);
  if (!unwrapped) return state;
  const { event, sessionId } = unwrapped;
  const type = event.type as string;
  let s = state;
  if (sessionId && sessionId !== s.sessionId) {
    s = { ...s, sessionId };
  }

  const freshId = (prefix: string): [string, ChatState] => {
    const next = s.seq + 1;
    return [`${prefix}-${next}`, { ...s, seq: next }];
  };

  switch (type) {
    case "stream_request_start": {
      // Open a fresh assistant message (for THIS agent) to accumulate text into.
      const key = agentKey(event);
      const [id, s2] = freshId("a");
      const item: ChatItem = {
        kind: "assistant",
        id,
        text: "",
        reasoning: "",
        done: false,
        agentId: event.agentId as string | undefined,
      };
      return {
        ...s2,
        items: [...s2.items, item],
        liveByAgent: { ...s2.liveByAgent, [key]: id },
        run: "running",
      };
    }

    case "text_delta": {
      const text = (event.text as string) ?? "";
      const key = agentKey(event);
      const liveId = s.liveByAgent[key];
      const live = liveId && s.items.find((i) => i.id === liveId && i.kind === "assistant");
      if (live) {
        return {
          ...s,
          run: "running",
          items: s.items.map((i) =>
            i.id === liveId && i.kind === "assistant" ? { ...i, text: i.text + text } : i,
          ),
        };
      }
      // No open assistant for this agent (e.g. text before stream_request_start)
      // → open one scoped to this agent.
      const [id, s2] = freshId("a");
      const item: ChatItem = {
        kind: "assistant",
        id,
        text,
        reasoning: "",
        done: false,
        agentId: event.agentId as string | undefined,
      };
      return {
        ...s2,
        items: [...s2.items, item],
        liveByAgent: { ...s2.liveByAgent, [key]: id },
        run: "running",
      };
    }

    case "thinking_delta": {
      const text = (event.text as string) ?? "";
      const key = agentKey(event);
      const liveId = s.liveByAgent[key];
      if (liveId && s.items.some((i) => i.id === liveId && i.kind === "assistant")) {
        return {
          ...s,
          run: "running",
          items: s.items.map((i) =>
            i.id === liveId && i.kind === "assistant"
              ? { ...i, reasoning: i.reasoning + text }
              : i,
          ),
        };
      }
      const [id, s2] = freshId("a");
      const item: ChatItem = {
        kind: "assistant",
        id,
        text: "",
        reasoning: text,
        done: false,
        agentId: event.agentId as string | undefined,
      };
      return {
        ...s2,
        items: [...s2.items, item],
        liveByAgent: { ...s2.liveByAgent, [key]: id },
        run: "running",
      };
    }

    case "tool_use_start": {
      const call = event.toolCall as
        | { id: string; toolName: string; args?: Record<string, unknown>; summary?: string }
        | undefined;
      if (!call) return s;
      // Idempotent: a duplicate start for the same call id is a no-op.
      if (s.items.some((i) => i.kind === "tool" && i.id === call.id)) return s;
      // A tool_result may have arrived BEFORE this start (out-of-order); apply
      // the buffered orphan now so the card isn't stuck open with no result.
      const orphan = s.orphanResults?.[call.id];
      const item: ChatItem = {
        kind: "tool",
        id: call.id,
        name: call.toolName,
        args: call.args,
        // Room tool messages carry a human summary instead of structured args.
        summary: call.summary,
        done: orphan ? true : false,
        result: orphan?.result,
        error: orphan?.error,
        agentId: event.agentId as string | undefined,
      };
      let orphanResults = s.orphanResults;
      if (orphan) {
        const { [call.id]: _used, ...restOrphans } = s.orphanResults!;
        orphanResults = Object.keys(restOrphans).length > 0 ? restOrphans : undefined;
      }
      return { ...s, run: "running", items: [...s.items, item], orphanResults };
    }

    case "tool_use_args_delta": {
      // Tool args stream incrementally (large Edit/Write/Bash payloads). Merge
      // each delta into the matching tool item, mirroring the desktop renderer's
      // argsLive accumulation (renderer/types.ts) — otherwise the tool card and
      // the approval summary derived from these args would show only the partial
      // snapshot tool_use_start carried.
      const callId = event.toolCallId as string | undefined;
      const delta = event.args as Record<string, unknown> | undefined;
      if (!callId || !delta) return s;
      return {
        ...s,
        items: s.items.map((i) =>
          i.kind === "tool" && i.id === callId
            ? { ...i, args: { ...(i.args ?? {}), ...delta } }
            : i,
        ),
      };
    }

    case "tool_result": {
      const result = event.result as
        | { id: string; result?: string; error?: string; isError?: boolean }
        | undefined;
      if (!result) return s;
      const matched = s.items.some((i) => i.kind === "tool" && i.id === result.id);
      if (!matched) {
        // tool_result arrived before its tool_use_start (out-of-order) — buffer it
        // so tool_use_start can apply it, instead of silently dropping (which would
        // leave the card stuck done:false with no result).
        return {
          ...s,
          orphanResults: {
            ...(s.orphanResults ?? {}),
            [result.id]: {
              result: result.result ?? result.error ?? "",
              error: Boolean(result.isError || result.error),
            },
          },
        };
      }
      return {
        ...s,
        items: s.items.map((i) =>
          i.kind === "tool" && i.id === result.id
            ? {
                ...i,
                done: true,
                result: stripSystemReminders(result.result ?? result.error ?? ""),
                error: Boolean(result.isError || result.error),
              }
            : i,
        ),
      };
    }

    case "room_tool_result": {
      // Room transcripts emit a coarse tool_result with no id linking it to its
      // start; seal the most recent open tool item with the summary + error.
      const summary = (event.summary as string) ?? "";
      const resultText = stripSystemReminders(summary);
      const isError = Boolean(event.isError);
      let idx = -1;
      for (let i = s.items.length - 1; i >= 0; i--) {
        if (s.items[i].kind === "tool" && !(s.items[i] as Extract<ChatItem, { kind: "tool" }>).done) {
          idx = i;
          break;
        }
      }
      if (idx === -1) return s;
      const items = s.items.slice();
      const tool = items[idx] as Extract<ChatItem, { kind: "tool" }>;
      items[idx] = { ...tool, done: true, result: resultText, summary: resultText || tool.summary, error: isError };
      return { ...s, items };
    }

    case "tool_summary": {
      // tool_summary carries no id; attach to the last tool item.
      const summary = (event.summary as string) ?? "";
      let idx = -1;
      for (let i = s.items.length - 1; i >= 0; i--) {
        if (s.items[i].kind === "tool") {
          idx = i;
          break;
        }
      }
      if (idx === -1) return s;
      const items = s.items.slice();
      items[idx] = { ...(items[idx] as Extract<ChatItem, { kind: "tool" }>), summary };
      return { ...s, items };
    }

    case "assistant_message": {
      // Final assistant message for the request — seal THIS agent's live bubble
      // AND mark its open assistant items done. Without the latter, a finalized
      // message keeps rendering the streaming cursor (▋) until turn_complete
      // arrives; if turn_complete is delayed/dropped (network drop, buffering) it
      // never clears. Mirror turn_complete's item seal (desktop types.ts does the
      // same). run-state is left to turn_complete.
      const key = agentKey(event);
      if (!(key in s.liveByAgent)) return s;
      const { [key]: _gone, ...rest } = s.liveByAgent;
      const items = s.items.map((i) =>
        i.kind === "assistant" && !i.done && (i.agentId ?? "") === key
          ? { ...i, done: true }
          : i,
      );
      return { ...s, liveByAgent: rest, items };
    }

    case "turn_complete": {
      const reason = (event.reason as string) ?? "completed";
      const key = agentKey(event);
      // Seal this agent's live bubble and mark its open assistant items done.
      const { [key]: _gone, ...rest } = s.liveByAgent;
      const items = s.items.map((i) =>
        i.kind === "assistant" && !i.done && (i.agentId ?? "") === key
          ? { ...i, done: true }
          : i,
      );
      // A SUBAGENT's turn_complete (agentId present) must NOT flip the global run
      // state — the parent turn is still running (mirrors renderer App.tsx).
      if (event.agentId) {
        return { ...s, liveByAgent: rest, items };
      }
      return { ...s, liveByAgent: rest, items, run: runStateForReason(reason) };
    }

    case "goal_set": {
      // Persistent goal established/replaced. Show the objective directly.
      const objective = (event.objective as string | undefined) ?? "";
      return { ...s, goal: objective ? `◎ ${objective}` : "◎ 目标" };
    }

    case "goal_cleared": {
      return { ...s, goal: undefined };
    }

    case "goal_progress": {
      const status = (event.status as string) ?? "";
      // Goal achieved / gave up → drop the banner.
      if (status === "met" || status === "exhausted") return { ...s, goal: undefined };
      const round = event.round as number | undefined;
      const label = round ? `目标 · 第 ${round} 轮 (${status})` : `目标 (${status})`;
      return { ...s, goal: label };
    }

    case "task_update": {
      // Only SUBAGENT task lists render as a compact status row, keyed by
      // agentId (fbe6f68). The MAIN agent's own TodoWrite emits task_update with
      // NO agentId (core task.ts) — like the desktop renderer (renderer/types.ts
      // drops agentId-less task_updates from the subagent path), we must NOT turn
      // the user's own todo list into a spurious "sub-main" child-agent row.
      const agentId = event.agentId as string | undefined;
      if (!agentId) return s;
      const tasks = (event.tasks as { status: string }[] | undefined) ?? [];
      const done = tasks.filter((t) => t.status === "completed").length;
      const label = `任务 ${done}/${tasks.length}`;
      const existing = s.items.findIndex(
        (i) => i.kind === "subagent" && i.agentId === agentId,
      );
      const sub: ChatItem = {
        kind: "subagent",
        id: `sub-${agentId}`,
        agentId,
        label,
        // Empty list ⇒ not started, not "completed" (Array.every is vacuously
        // true on []). Only call it completed when there is at least one task and
        // all are done.
        status: tasks.length > 0 && done === tasks.length ? "completed" : "running",
      };
      if (existing >= 0) {
        const items = s.items.slice();
        items[existing] = sub;
        return { ...s, items };
      }
      return { ...s, items: [...s.items, sub] };
    }

    case "agent_start": {
      const agentId = event.agentId as string;
      if (!agentId) return s;
      const sub: ChatItem = {
        kind: "subagent",
        id: `sub-${agentId}`,
        agentId,
        label: (event.name as string) || (event.description as string) || "子代理",
        status: "running",
      };
      if (s.items.some((i) => i.kind === "subagent" && i.agentId === agentId)) return s;
      return { ...s, items: [...s.items, sub] };
    }

    case "agent_end": {
      const agentId = event.agentId as string;
      return {
        ...s,
        items: s.items.map((i) =>
          i.kind === "subagent" && i.agentId === agentId
            ? { ...i, status: event.error ? "error" : "completed" }
            : i,
        ),
      };
    }

    case "error": {
      const [id, s2] = freshId("err");
      return {
        ...s2,
        run: "error",
        liveByAgent: {},
        items: [
          ...s2.items,
          { kind: "system_error", id, text: (event.error as string) || "运行出错" },
        ],
      };
    }

    case "session_title": {
      return { ...s, title: event.title as string | undefined };
    }

    case "user_message": {
      // History replay surfaces past user turns as a synthetic event so the
      // same reducer rebuilds the full conversation (the live path uses
      // appendUserMessage instead, since the phone echoes locally).
      const [id, s2] = freshId("u");
      return {
        ...s2,
        items: [...s2.items, { kind: "user", id, text: (event.text as string) ?? "" }],
      };
    }

    case "assistant_text": {
      // A WHOLE assistant text message (not a token delta). Used by CC-room
      // replay/live, where each `type:"text"` room message is a complete,
      // self-contained chunk that claude emitted between tool calls. Each one
      // becomes its OWN finished bubble (done:true) and is NOT registered in
      // liveByAgent — so a later text message opens a fresh bubble instead of
      // being appended to this one. That restores the "说一句 → 干活 → 再说一
      // 句" progression (the糊成一坨 / "卡住最后才出" complaint came from
      // text_delta folding every chunk into one open bubble). Streaming token
      // deltas still go through text_delta.
      const [id, s2] = freshId("a");
      return {
        ...s2,
        run: "running",
        items: [
          ...s2.items,
          {
            kind: "assistant",
            id,
            text: (event.text as string) ?? "",
            reasoning: "",
            done: true,
            agentId: event.agentId as string | undefined,
          },
        ],
      };
    }

    default:
      // Unknown / not-displayed events (session_started, usage_update,
      // context_compact, tombstone, …) are no-ops.
      return s;
  }
}

/** Append a local user echo (the phone shows its own message immediately). */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  const id = `u-${state.seq + 1}`;
  return {
    ...state,
    seq: state.seq + 1,
    items: [...state.items, { kind: "user", id, text }],
  };
}
