import { compareOutputCursors } from "@cjhyy/code-shell-web";

/** Bounded display-coverage proof, independent of the evictable Main event suffix. */
const visible = new Set([
  "session_started",
  "stream_request_start",
  "text_delta",
  "thinking_delta",
  "tool_use_start",
  "tool_use_args_delta",
  "tool_result",
  "room_tool_result",
  "tool_summary",
  "tombstone",
  "assistant_message",
  "turn_complete",
  "goal_set",
  "goal_updated",
  "goal_cleared",
  "goal_progress",
  "task_update",
  "agent_start",
  "agent_end",
  "error",
  "session_user_message",
  "steer_injected",
  "user_message",
  "assistant_text",
]);
function validCursor(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
    return false;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return (
      typeof cursor.identity === "string" &&
      typeof cursor.hash === "string" &&
      /^[a-f0-9]{64}$/.test(cursor.identity) &&
      /^[a-f0-9]{64}$/.test(cursor.hash) &&
      Number.isSafeInteger(cursor.sequence) &&
      cursor.sequence > 0 &&
      Number.isSafeInteger(cursor.offset) &&
      cursor.offset > 0
    );
  } catch {
    return false;
  }
}
export class OutputCoverage {
  private lastCursor?: string;
  private blocked = false;
  private overflowed = false;
  private readonly inputs = new Set<string>();

  observe(raw: unknown): void {
    if (this.overflowed) return;
    const event = raw as {
      type?: string;
      outputCursor?: unknown;
      runId?: unknown;
      clientMessageId?: unknown;
      agentId?: unknown;
      injected?: unknown;
      authority?: unknown;
    } | null;
    if (!event) return;
    if (event.outputCursor !== undefined) {
      const order = validCursor(event.outputCursor)
        ? this.lastCursor
          ? compareOutputCursors(event.outputCursor, this.lastCursor)
          : 1
        : undefined;
      if (order === undefined || order <= 0) {
        this.discardProof();
        return;
      }
      this.lastCursor = event.outputCursor as string;
      // A new Run does not remove historical errors or the current Goal from
      // the display reducer. Only explicit coverage can release their barrier.
      return;
    }
    if (!event.type || !visible.has(event.type)) return;
    if (
      ["session_user_message", "steer_injected", "user_message"].includes(event.type) &&
      (event.agentId ||
        event.injected === true ||
        ["agent", "system", "policy"].includes(String(event.authority)))
    )
      return;
    if (event.type === "session_user_message") {
      const id = event.clientMessageId;
      if (typeof id !== "string" || !id.trim() || id.length > 512 || this.inputs.has(id))
        this.blocked = true;
      else this.inputs.add(id);
      if (this.inputIds.length > 128 || this.memoryBytes > 32 * 1024) this.discardProof();
    } else this.blocked = true;
  }
  get inputIds(): string[] {
    return [...this.inputs];
  }
  get incomplete(): boolean {
    return this.blocked || this.overflowed;
  }
  get memoryBytes(): number {
    return this.inputIds.reduce((sum, id) => sum + Buffer.byteLength(id), 0);
  }
  discardProof(): void {
    // Overflow never silently forgets a required identity or becomes success.
    this.overflowed = true;
    this.inputs.clear();
  }
}
