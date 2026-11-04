import type { StreamEvent } from "@cjhyy/code-shell-core";

/** Bound uncommitted text while keeping every original event and its durable cursor. */
export class ExternalRuntimeDeltaBuffer {
  private pending: StreamEvent[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly consume: {
      batch(events: readonly StreamEvent[]): void;
      single(event: StreamEvent): void;
      failed(error: unknown): void;
    },
  ) {}

  push(event: StreamEvent): void {
    if (event.type !== "text_delta" && event.type !== "thinking_delta") {
      this.flush();
      this.consume.single(event);
      return;
    }
    const bytes = Buffer.byteLength(JSON.stringify(event));
    // Leave room for the timing envelope prepared by the recorder. A single
    // oversized event retains the journal's existing individual-event bound.
    if (this.pending.length && (this.pending.length >= 64 || this.bytes + bytes > 192 * 1024))
      this.flush();
    this.pending.push({ ...event });
    this.bytes += bytes;
    if (this.bytes >= 192 * 1024) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        try {
          this.flush();
        } catch (error) {
          this.consume.failed(error);
        }
      }, 8);
      this.timer.unref?.();
    }
  }

  /** A tool/control/terminal or a lifecycle fence must commit earlier text first. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const events = this.pending;
    this.pending = [];
    this.bytes = 0;
    if (events.length) this.consume.batch(events);
  }
}
