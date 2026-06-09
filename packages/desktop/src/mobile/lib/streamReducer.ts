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
  /** Internal: id of the assistant item currently accumulating text_delta. */
  liveAssistantId?: string;
  /** Internal: monotonic counter for fresh ids (replaces Date.now/random,
   *  which would make replay non-deterministic). */
  seq: number;
}

export function initialChatState(): ChatState {
  return { items: [], run: "idle", seq: 0 };
}

/** A successful terminal reason; everything else that isn't an abort is error. */
function runStateForReason(reason: string): RunState {
  if (reason === "completed") return "completed";
  if (reason === "aborted_streaming" || reason === "aborted_tools") return "idle";
  return "error";
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
      // Open a fresh assistant message to accumulate text into.
      const [id, s2] = freshId("a");
      const item: ChatItem = {
        kind: "assistant",
        id,
        text: "",
        reasoning: "",
        done: false,
        agentId: event.agentId as string | undefined,
      };
      return { ...s2, items: [...s2.items, item], liveAssistantId: id, run: "running" };
    }

    case "text_delta": {
      const text = (event.text as string) ?? "";
      const liveId = s.liveAssistantId;
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
      // No open assistant (e.g. text before stream_request_start) → open one.
      const [id, s2] = freshId("a");
      const item: ChatItem = {
        kind: "assistant",
        id,
        text,
        reasoning: "",
        done: false,
        agentId: event.agentId as string | undefined,
      };
      return { ...s2, items: [...s2.items, item], liveAssistantId: id, run: "running" };
    }

    case "thinking_delta": {
      const text = (event.text as string) ?? "";
      const liveId = s.liveAssistantId;
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
      return { ...s2, items: [...s2.items, item], liveAssistantId: id, run: "running" };
    }

    case "tool_use_start": {
      const call = event.toolCall as
        | { id: string; toolName: string; args?: Record<string, unknown> }
        | undefined;
      if (!call) return s;
      // Idempotent: a duplicate start for the same call id is a no-op.
      if (s.items.some((i) => i.kind === "tool" && i.id === call.id)) return s;
      const item: ChatItem = {
        kind: "tool",
        id: call.id,
        name: call.toolName,
        args: call.args,
        done: false,
        agentId: event.agentId as string | undefined,
      };
      return { ...s, run: "running", items: [...s.items, item] };
    }

    case "tool_result": {
      const result = event.result as
        | { id: string; result?: string; error?: string; isError?: boolean }
        | undefined;
      if (!result) return s;
      return {
        ...s,
        items: s.items.map((i) =>
          i.kind === "tool" && i.id === result.id
            ? {
                ...i,
                done: true,
                result: result.result ?? result.error ?? "",
                error: Boolean(result.isError || result.error),
              }
            : i,
        ),
      };
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
      // Final assistant message for the request — seal the live one.
      return { ...s, liveAssistantId: undefined };
    }

    case "turn_complete": {
      const reason = (event.reason as string) ?? "completed";
      return {
        ...s,
        liveAssistantId: undefined,
        items: s.items.map((i) =>
          i.kind === "assistant" && !i.done ? { ...i, done: true } : i,
        ),
        run: runStateForReason(reason),
      };
    }

    case "goal_progress": {
      const status = (event.status as string) ?? "";
      const round = event.round as number | undefined;
      const label = round ? `目标 · 第 ${round} 轮 (${status})` : `目标 (${status})`;
      return { ...s, goal: label };
    }

    case "task_update": {
      // Subagent task list. Reflect a compact status line keyed by agentId so it
      // never clobbers the main flow (fbe6f68).
      const agentId = (event.agentId as string) ?? "main";
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
        status: tasks.every((t) => t.status === "completed") ? "completed" : "running",
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
        liveAssistantId: undefined,
        items: [
          ...s2.items,
          { kind: "system_error", id, text: (event.error as string) || "运行出错" },
        ],
      };
    }

    case "session_title": {
      return { ...s, title: event.title as string | undefined };
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
