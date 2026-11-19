import type { BackgroundJobProgress } from "@cjhyy/code-shell-core/extension";
import { parseClaudePermissionDenials } from "./agent-adapter.js";

type Activity = Pick<BackgroundJobProgress, "phase" | "summary" | "permissionDenials">;
const MAX_SUMMARY_CHARS = 240;
const MAX_RECENT_EVENTS = 8;

/** Only selected public activity metadata reaches the UI. Never expose raw
 * reasoning, tool arguments/results, stderr, or an unknown JSON event. */
function label(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY_CHARS);
}

function toolActivity(name: unknown, input?: unknown): Activity {
  const tool = label(name) || "tool";
  // Paths help identify the current file without copying arbitrary command
  // arguments, prompts, credentials, or file contents into status history.
  const path =
    input && typeof input === "object"
      ? label(
          (input as Record<string, unknown>).file_path ?? (input as Record<string, unknown>).path,
        )
      : "";
  return { phase: "tool", summary: label(`Running ${tool}${path ? ` · ${path}` : ""}`) };
}

function claudeActivity(data: any): Activity | undefined {
  if (data.type === "system" && data.subtype === "init")
    return { phase: "starting", summary: "Claude Code session connected" };
  if (data.type === "stream_event") {
    const event = data.event;
    if (event?.type === "message_start")
      return { phase: "thinking", summary: "Processing request" };
    if (event?.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "tool_use") return toolActivity(block.name, block.input);
      if (block?.type === "thinking" || block?.type === "redacted_thinking")
        return { phase: "thinking", summary: "Thinking" };
      if (block?.type === "text") return { phase: "responding", summary: "Writing response" };
    }
    if (event?.type === "content_block_delta") {
      if (event.delta?.type === "thinking_delta" || event.delta?.type === "signature_delta")
        return { phase: "thinking", summary: "Thinking" };
      if (event.delta?.type === "text_delta")
        return { phase: "responding", summary: "Writing response" };
      // input_json_delta only refreshes the activity clock; keep the tool name
      // supplied by content_block_start without exposing partial arguments.
    }
  }
  if (data.type === "assistant" && Array.isArray(data.message?.content)) {
    const blocks = data.message.content;
    const tool = blocks.find((block: any) => block?.type === "tool_use");
    if (tool) return toolActivity(tool.name, tool.input);
    if (blocks.some((block: any) => block?.type === "text"))
      return { phase: "responding", summary: "Response received" };
    if (
      blocks.some((block: any) => block?.type === "thinking" || block?.type === "redacted_thinking")
    )
      return { phase: "thinking", summary: "Thinking" };
  }
  if (data.type === "user" && Array.isArray(data.message?.content)) {
    const results = data.message.content.filter((block: any) => block?.type === "tool_result");
    if (results.length)
      return {
        phase: "tool",
        summary: results.some((block: any) => block.is_error)
          ? "Tool reported an error"
          : "Tool finished",
      };
  }
  if (data.type === "result") {
    // The CLI's own terminal count is authoritative: it also covers refusals
    // that never reached a permission prompt (deny rules, a non-asking mode).
    const denied = parseClaudePermissionDenials(data.permission_denials).length;
    return {
      phase: "responding",
      summary: data.is_error
        ? "Run reported an error"
        : denied > 0
          ? `Response complete · ${denied} operation(s) denied by permissions`
          : "Response complete",
      ...(denied > 0 ? { permissionDenials: denied } : {}),
    };
  }
  return undefined;
}

function codexActivity(data: any): Activity | undefined {
  if (data.type === "thread.started")
    return { phase: "starting", summary: "Codex session connected" };
  if (data.type === "turn.started") return { phase: "thinking", summary: "Processing request" };
  if (["item.started", "item.updated", "item.completed"].includes(data.type)) {
    const item = data.item;
    const completed = data.type === "item.completed";
    if (item?.type === "reasoning") return { phase: "thinking", summary: "Thinking" };
    if (item?.type === "agent_message")
      return { phase: "responding", summary: completed ? "Response received" : "Writing response" };
    if (item?.type === "command_execution")
      return {
        phase: "tool",
        summary: completed
          ? `Command finished${Number.isInteger(item.exit_code) ? ` (exit ${item.exit_code})` : ""}`
          : "Running command",
      };
    if (item?.type === "mcp_tool_call")
      return {
        phase: "tool",
        summary: label(
          `${completed ? "Finished" : "Running"} ${label(item.server)} ${label(item.tool)}`,
        ),
      };
    if (item?.type === "file_change") {
      const paths = Array.isArray(item.changes)
        ? item.changes
            .map((change: any) => label(change?.path))
            .filter(Boolean)
            .slice(0, 3)
        : [];
      return {
        phase: "tool",
        summary: label(
          `${completed ? "Updated files" : "Editing files"}${paths.length ? ` · ${paths.join(", ")}` : ""}`,
        ),
      };
    }
    if (item?.type === "web_search")
      return { phase: "tool", summary: completed ? "Web search finished" : "Searching the web" };
    if (item?.type === "todo_list") return { phase: "thinking", summary: "Updated task plan" };
  }
  if (data.type === "turn.completed") return { phase: "responding", summary: "Response complete" };
  if (data.type === "turn.failed" || data.type === "error")
    return { summary: "CLI reported an error" };
  return undefined;
}

/**
 * Whether this `codex exec --json` record (the shape both Codex transports are
 * reported in) is a command that ended failed: a `failed` status or a non-zero
 * exit code. A command Codex declined never ran and is not one.
 *
 * Nothing but those two fields is read. Codex gives a failed command no cause,
 * so this is a count of failures and never a statement of why: a network call
 * cut off by the sandbox and a `grep` without a match look the same here.
 *
 * Claude Code has no equal signal. Its `tool_result.is_error` names no tool and
 * is also set for a tool that was refused, so it is not counted.
 */
export function codexCommandFailed(data: unknown): boolean {
  const record = data as { type?: unknown; item?: Record<string, unknown> } | null;
  const item = record?.type === "item.completed" ? record.item : undefined;
  if (item?.type !== "command_execution" || item.status === "declined") return false;
  return item.status === "failed" || (Number.isInteger(item.exit_code) && item.exit_code !== 0);
}

export function initialAgentProgress(cli: string, now = Date.now()): BackgroundJobProgress {
  return {
    lastActivityAt: now,
    eventCount: 0,
    phase: "starting",
    summary: `Starting ${cli === "claude" ? "Claude Code" : cli === "codex" ? "Codex" : "agent"}`,
    recentEvents: [],
  };
}

/**
 * Record that the CLI's own sandbox or policy refused operations without an
 * approval request. `count` is the run's total so far. It is kept apart from
 * `permissionDenials`: nobody was asked, so nobody denied anything.
 */
export function recordSandboxBlocked(
  previous: BackgroundJobProgress,
  count: number,
  now = Date.now(),
): BackgroundJobProgress {
  const summary = `${count} operation(s) blocked by the sandbox`;
  return {
    ...previous,
    sandboxBlocked: count,
    summary,
    lastActivityAt: now,
    recentEvents: [...(previous.recentEvents ?? []), { at: now, summary }].slice(
      -MAX_RECENT_EVENTS,
    ),
  };
}

/** A real output event refreshes activity even when its schema is unknown.
 * Timestamps are host receive times, not untrusted CLI-provided timestamps. */
export function advanceAgentProgress(
  previous: BackgroundJobProgress,
  cli: string,
  line: string,
  now = Date.now(),
): BackgroundJobProgress {
  if (!line.trim()) return previous;
  let data: unknown;
  try {
    data = JSON.parse(line);
  } catch {
    // Non-JSON stdout and diagnostic output prove activity but are not a
    // user-facing summary. No raw content is retained in progress metadata.
  }
  return advanceAgentProgressWith(previous, cli, data, now);
}

/** Same as advanceAgentProgress for a line the caller already parsed;
 * `undefined` records activity without a summary. */
export function advanceAgentProgressWith(
  previous: BackgroundJobProgress,
  cli: string,
  data: unknown,
  now = Date.now(),
): BackgroundJobProgress {
  let activity: Activity | undefined;
  if (data && typeof data === "object") {
    activity =
      cli === "claude" ? claudeActivity(data) : cli === "codex" ? codexActivity(data) : undefined;
  }
  const recentEvents = [...(previous.recentEvents ?? [])];
  if (activity?.summary && activity.summary !== previous.summary)
    recentEvents.push({ at: now, summary: activity.summary });
  return {
    ...previous,
    ...activity,
    ...(cli === "codex" && codexCommandFailed(data)
      ? { failedCommands: (previous.failedCommands ?? 0) + 1 }
      : {}),
    lastActivityAt: now,
    eventCount: previous.eventCount + 1,
    recentEvents: recentEvents.slice(-MAX_RECENT_EVENTS),
  };
}
