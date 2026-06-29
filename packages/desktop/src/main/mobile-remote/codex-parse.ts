import type { ResidentAgentEvent } from "./resident-agent.js";

/**
 * Parse ONE line of `codex exec --json` (JSONL) output into zero-or-more
 * NORMALIZED ResidentAgentEvents — the exact same render-friendly union the
 * claude room emits, so desktop + mobile UIs render a codex room with no
 * UI-side changes. Pure + synchronous → unit-testable against recorded codex
 * output without spawning codex.
 *
 * Codex event shapes (verified against codex-cli 0.142.4):
 *   {type:"thread.started", thread_id}                       → [] (id captured by the process, not here)
 *   {type:"turn.started"}                                    → []
 *   {type:"item.started"|"item.updated"|"item.completed", item:{id,type,...}}
 *       item.type "agent_message"     → text   (on completed only — dedup)
 *       item.type "reasoning"         → []      (thinking noise)
 *       item.type "command_execution" → tool(Bash) on start, tool_result on complete
 *       item.type "mcp_tool_call"     → tool(server__tool) on start, tool_result on complete
 *       item.type "web_search"        → tool(WebSearch) on start
 *       item.type "file_change"       → tool(Edit) on start
 *   {type:"turn.completed", usage}                           → turn_end
 *   {type:"turn.failed", error}                              → error
 *   {type:"error", message}                                  → error
 *
 * NOTE: codex never produces an approval_request — its only guardrail is the
 * sandbox tier chosen at spawn time (read-only / workspace-write / bypass).
 */
export function parseCodexJsonLine(line: string): ResidentAgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [];
  }

  if (msg.type === "turn.completed") return [{ type: "turn_end", reason: "completed" }];
  if (msg.type === "turn.failed") {
    return [{ type: "error", error: errText(msg.error) || "turn failed" }];
  }
  if (msg.type === "error") {
    return [{ type: "error", error: errText(msg.message ?? msg.error) || "error" }];
  }

  const phase: "started" | "updated" | "completed" | null =
    msg.type === "item.started" ? "started" : msg.type === "item.updated" ? "updated" : msg.type === "item.completed" ? "completed" : null;
  if (!phase) return []; // thread.started / turn.started / unknown → noise

  const item = msg.item;
  if (!item || typeof item !== "object") return [];
  const id = typeof item.id === "string" ? item.id : undefined;

  switch (item.type) {
    case "agent_message":
      // Only the final text (avoid duplicating the streaming updates).
      return phase === "completed" && typeof item.text === "string" ? [{ type: "text", text: item.text }] : [];

    case "reasoning":
      return []; // thinking — not in the render union

    case "command_execution":
      if (phase === "completed") {
        return [{
          type: "tool_result",
          id,
          summary: String(item.aggregated_output ?? "").slice(0, 400),
          isError: typeof item.exit_code === "number" ? item.exit_code !== 0 : false,
        }];
      }
      return phase === "started"
        ? [{ type: "tool", id, tool: "Bash", summary: String(item.command ?? ""), input: { command: String(item.command ?? "") } }]
        : [];

    case "mcp_tool_call":
      if (phase === "completed") {
        return [{
          type: "tool_result",
          id,
          summary: String(item.result ?? item.output ?? "").slice(0, 400),
          isError: item.status === "failed" || Boolean(item.is_error),
        }];
      }
      return phase === "started"
        ? [{
            type: "tool",
            id,
            tool: `${item.server ?? "mcp"}__${item.tool ?? "tool"}`,
            summary: "",
            input: { arguments: item.arguments },
          }]
        : [];

    case "web_search":
      return phase === "started"
        ? [{ type: "tool", id, tool: "WebSearch", summary: String(item.query ?? ""), input: { query: String(item.query ?? "") } }]
        : [];

    case "file_change":
      return phase === "started"
        ? [{
            type: "tool",
            id,
            tool: "Edit",
            summary: String(item.path ?? ""),
            input: item.kind !== undefined ? { path: String(item.path ?? ""), kind: item.kind } : { path: String(item.path ?? "") },
          }]
        : [];

    default:
      return [];
  }
}

/**
 * Pull the codex thread id out of a `thread.started` line, or undefined for any
 * other line. Kept here (not inline in the room agent) so ALL codex JSONL
 * knowledge lives in one file — parseCodexJsonLine deliberately drops
 * thread.started (it's resume-control info, not a render event), so the room
 * agent uses THIS to capture the id without a second hand-rolled JSON.parse.
 */
export function extractThreadId(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  return msg.type === "thread.started" && typeof msg.thread_id === "string" ? msg.thread_id : undefined;
}

function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as any).message === "string") return (e as any).message;
  return "";
}
