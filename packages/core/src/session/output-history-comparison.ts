import type { StreamEvent, TranscriptEvent } from "../types.js";
import type { OutputHistoryComparison } from "../protocol/output-history-recovery-types.js";
import { outputUserMessage } from "../engine/run-output-user-message.js";

/** JSON equality independent of property insertion order; no content leaves this comparison. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
const empty = () => ({
  users: [] as unknown[],
  assistant: "",
  tools: [] as Array<{ id: string; name: string; args: unknown }>,
  results: [] as unknown[],
  errors: [] as unknown[],
});
const inputProjection = (event: Record<string, any>) => ({
  sessionId: event.sessionId,
  text: event.text,
  clientMessageId: event.clientMessageId,
  injected: event.injected,
  authority: event.authority,
  transcriptMessage: event.transcriptMessage,
});
// These events do not replace canonical conversation records. Their exact raw
// journal frames are retained in the new epoch, including Goal/background UI.
const observational = new Set([
  "session_started",
  "stream_request_start",
  "usage_update",
  "memory_recalled",
  "goal_set",
  "goal_updated",
  "goal_cleared",
  "goal_progress",
  "task_update",
  "agent_start",
  "agent_end",
  "background_agent_completed",
  "turn_diff",
  "session_title",
]);

/** Narrow, fail-closed proof for the external recorder's canonical transcript format. */
export function compareOutputHistory(
  transcript: TranscriptEvent[],
  events: StreamEvent[],
  sessionId: string,
  cwd: string,
):
  | { ok: true; comparison: OutputHistoryComparison; checkpointEvents?: StreamEvent[] }
  | {
      ok: false;
      reason: "history_mismatch" | "unsupported_history";
    } {
  const unsupported = () => ({ ok: false as const, reason: "unsupported_history" as const });
  try {
    const recorded: ReturnType<typeof empty>[] = [],
      published: ReturnType<typeof empty>[] = [];
    let native = empty(),
      journal = empty();
    const blocks: unknown[] = [];
    let metadata = 0;
    for (const event of transcript) {
      const data = event.data as Record<string, any>;
      if (!data || typeof data !== "object") return unsupported();
      switch (event.type) {
        case "session_meta":
          if (
            ++metadata !== 1 ||
            recorded.length ||
            native.users.length ||
            data.sessionId !== sessionId
          )
            return unsupported();
          break;
        case "message":
          if (data.role === "user") {
            native.users.push(inputProjection(outputUserMessage(data, sessionId, cwd)));
          } else if (data.role === "assistant") {
            if (typeof data.content === "string") native.assistant += data.content;
            else if (Array.isArray(data.content)) {
              for (const block of data.content) {
                if (block.type === "text" && typeof block.text === "string")
                  native.assistant += block.text;
                else if (block.type === "tool_use")
                  blocks.push({ id: block.id, name: block.name, args: block.input });
                else return unsupported();
              }
            } else return unsupported();
          } else return unsupported();
          break;
        case "tool_use":
          native.tools.push({ id: data.toolCallId, name: data.toolName, args: data.args });
          break;
        case "tool_result":
          native.results.push({
            id: data.toolCallId,
            name: data.toolName,
            result: data.result,
            error: data.error,
            contentBlocks: data.contentBlocks,
          });
          break;
        case "error":
          native.errors.push(data.error);
          break;
        case "turn_boundary":
          recorded.push(native);
          native = empty();
          break;
        default:
          return unsupported();
      }
    }
    for (const raw of events) {
      const event = raw as Record<string, any>;
      if (event.outputRecovery === "incomplete") return unsupported();
      switch (event.type) {
        case "session_user_message":
          journal.users.push(inputProjection(event));
          break;
        case "text_delta":
          if (typeof event.text !== "string") return unsupported();
          journal.assistant += event.text;
          break;
        case "tool_use_start": {
          const call = event.toolCall;
          if (
            !call ||
            typeof call.id !== "string" ||
            journal.tools.some((tool) => tool.id === call.id)
          )
            return unsupported();
          journal.tools.push({ id: call.id, name: call.toolName, args: call.args });
          break;
        }
        case "tool_use_args_delta": {
          const tool = journal.tools.find((value) => value.id === event.toolCallId);
          if (!tool) return unsupported();
          tool.args = event.args;
          break;
        }
        case "tool_result": {
          const result = event.result;
          if (!result) return unsupported();
          journal.results.push({
            id: result.id,
            name: result.toolName,
            result: result.result,
            error: result.error,
            contentBlocks: result.contentBlocks,
          });
          break;
        }
        case "error":
          journal.errors.push(event.error);
          break;
        case "turn_complete":
          published.push(journal);
          journal = empty();
          break;
        default:
          if (!observational.has(event.type)) return unsupported();
      }
    }
    if (
      metadata !== 1 ||
      !recorded.length ||
      canonical(native) !== canonical(empty()) ||
      canonical(journal) !== canonical(empty())
    )
      return unsupported();
    if (
      canonical(recorded) !== canonical(published) ||
      canonical(blocks) !== canonical(recorded.flatMap((turn) => turn.tools))
    )
      return { ok: false, reason: "history_mismatch" };
    for (const turn of recorded) {
      if (turn.users.length !== 1 || turn.tools.length !== turn.results.length)
        return unsupported();
      const ids = new Set(turn.tools.map((tool) => tool.id));
      if (
        ids.size !== turn.tools.length ||
        turn.results.some((result: any) => !ids.delete(result.id)) ||
        ids.size
      )
        return unsupported();
    }
    return {
      ok: true,
      comparison: {
        turns: recorded.length,
        userInputs: recorded.reduce((count, turn) => count + turn.users.length, 0),
        toolCalls: recorded.reduce((count, turn) => count + turn.tools.length, 0),
        toolResults: recorded.reduce((count, turn) => count + turn.results.length, 0),
      },
    };
  } catch {
    return unsupported();
  }
}
