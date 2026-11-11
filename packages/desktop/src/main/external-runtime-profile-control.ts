import type { TerminalReason } from "@cjhyy/code-shell-core";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";

/** One provider turn's bounded capability loop; never shared with a successor. */
export class ExternalRuntimeProfileControl {
  private readonly reasons = new Set<"reply_committed" | "background_notification">();
  private calls = 0;
  private limitReached = false;
  private interruptRequested = false;
  readonly runYield: NonNullable<ToolContext["runYield"]> = {
    request: (reason) => {
      this.reasons.add(reason);
    },
    peek: (reason) => this.reasons.has(reason),
    consume: (reason) => this.reasons.delete(reason),
  };

  constructor(
    private readonly maxToolCalls: number,
    private readonly isCurrent: () => boolean,
    private readonly interrupt: () => Promise<void>,
  ) {}

  get replyCommitted(): boolean {
    return this.reasons.has("reply_committed");
  }

  async runTool<T>(operation: () => Promise<T>): Promise<T> {
    if (this.replyCommitted || this.calls >= this.maxToolCalls) {
      this.limitReached = !this.replyCommitted;
      this.requestInterrupt();
      throw new Error(
        this.replyCommitted
          ? "The reply is already committed. End this turn."
          : "The manager tool-call limit was reached.",
      );
    }
    this.calls++;
    try {
      return await operation();
    } finally {
      if (this.replyCommitted || this.calls >= this.maxToolCalls) {
        this.limitReached = !this.replyCommitted;
        this.requestInterrupt();
      }
    }
  }

  terminalReason(reason: TerminalReason): TerminalReason {
    if (!this.isCurrent()) return reason;
    if (this.replyCommitted && (reason === "aborted_tools" || reason === "aborted_streaming"))
      return "completed";
    if (
      this.limitReached &&
      (reason === "completed" || reason === "aborted_tools" || reason === "aborted_streaming")
    )
      return "max_turns";
    return reason;
  }

  private requestInterrupt(): void {
    if (this.interruptRequested) return;
    this.interruptRequested = true;
    // Let the accepted tool response leave the MCP bridge before interrupting
    // its provider; awaiting interrupt here would deadlock that response.
    setTimeout(() => {
      if (this.isCurrent()) void this.interrupt().catch(() => undefined);
    }, 0);
  }
}
