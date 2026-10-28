import type { BackgroundJobProgress } from "@cjhyy/code-shell-core/extension";

type Activity = Pick<BackgroundJobProgress, "phase" | "summary">;
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
  if (data.type === "result")
    return {
      phase: "responding",
      summary: data.is_error ? "Run reported an error" : "Response complete",
    };
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

export function initialAgentProgress(cli: string, now = Date.now()): BackgroundJobProgress {
  return {
    lastActivityAt: now,
    eventCount: 0,
    phase: "starting",
    summary: `Starting ${cli === "claude" ? "Claude Code" : cli === "codex" ? "Codex" : "agent"}`,
    recentEvents: [],
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
  let activity: Activity | undefined;
  try {
    const data = JSON.parse(line);
    if (data && typeof data === "object") {
      activity =
        cli === "claude" ? claudeActivity(data) : cli === "codex" ? codexActivity(data) : undefined;
    }
  } catch {
    // Non-JSON stdout and diagnostic output prove activity but are not a
    // user-facing summary. No raw content is retained in progress metadata.
  }
  const recentEvents = [...(previous.recentEvents ?? [])];
  if (activity?.summary && activity.summary !== previous.summary)
    recentEvents.push({ at: now, summary: activity.summary });
  return {
    ...previous,
    ...activity,
    lastActivityAt: now,
    eventCount: previous.eventCount + 1,
    recentEvents: recentEvents.slice(-MAX_RECENT_EVENTS),
  };
}
