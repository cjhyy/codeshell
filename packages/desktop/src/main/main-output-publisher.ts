/** Join independent Main output with committed, possibly late worker notifications. */
import { createHash } from "node:crypto";
import type { StreamEvent } from "@cjhyy/code-shell-core";
import { readOutputJournal, SessionOutputPublisher } from "@cjhyy/code-shell-core/internal";
import { applyOutputJournalPage, type OutputJournalRecovery } from "@cjhyy/code-shell-web";

function fingerprint(event: unknown): string {
  const value = { ...(event as Record<string, unknown>) };
  if (
    value.transcriptMessage &&
    ["session_user_message", "steer_injected"].includes(String(value.type))
  ) {
    // These two fields are a deterministic UI projection of transcriptMessage.
    delete value.text;
    delete value.attachments;
  }
  return createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest("hex");
}
export interface MainOutputSource {
  publish(event: unknown): void;
}
export class MainOutputPublisher {
  private readonly workerSources = new Map<string, SessionOutputPublisher>();
  private readonly replayed = new Map<string, Map<string, string>>();
  private replayCount = 0;
  constructor(
    private readonly options: {
      root(sessionId: string): string;
      latest(sessionId: string): string | undefined;
      worker(sessionId: string, event: StreamEvent): boolean;
    },
  ) {}

  /** Returns false only for a notification we have actually applied from disk. */
  observeWorker(sessionId: string, event: unknown): boolean {
    const cursor = (event as StreamEvent | null)?.outputCursor;
    if (!cursor) return true;
    let publisher = this.workerSources.get(sessionId);
    if (!publisher) {
      if (this.workerSources.size >= 8192) throw new Error("Main output source capacity");
      publisher = new SessionOutputPublisher(this.options.root, "host");
      this.workerSources.set(sessionId, publisher);
    }
    // Verify the first cursor before binding; a deleted/reused Session cannot
    // adopt a late first notification from its old worker incarnation.
    publisher.project(sessionId, event);
    const applied = this.replayed.get(sessionId)?.get(cursor);
    if (applied === undefined) return true;
    if (applied !== fingerprint(event))
      throw Object.assign(new Error("Replayed output notification changed"), {
        coverageIncomplete: true,
      });
    this.replayed.get(sessionId)!.delete(cursor);
    this.replayCount--;
    return false;
  }

  capture(sessionId: string, publish: (event: unknown) => boolean): MainOutputSource {
    const producer = new SessionOutputPublisher(this.options.root, "host");
    producer.capture(sessionId);
    return {
      publish: (raw) => {
        producer.capture(sessionId); // Reject a replaced Session before any publication.
        try {
          const event = producer.project(sessionId, raw) as StreamEvent;
          if (!event.outputCursor) {
            publish(event);
            return;
          }
          const root = this.options.root(sessionId);
          // Only a cursor actually applied to Main is a baseline. An RPC response
          // can include a committed Engine event not yet sent on stdout.
          const recovery: OutputJournalRecovery = {
            cursor: this.options.latest(sessionId),
            through: event.outputCursor,
            incomplete: false,
          };
          let done = false;
          const joined: Array<{ event: StreamEvent; host: boolean }> = [];
          let bytes = 0;
          while (!done) {
            const page = readOutputJournal(root, sessionId, {
              after: recovery.cursor,
              through: event.outputCursor,
            });
            done = applyOutputJournalPage(recovery, page, (value) => {
              bytes += Buffer.byteLength(JSON.stringify(value));
              if (joined.length >= 8192 || bytes > 32 * 1024 * 1024)
                throw new Error("Main output replay exceeds its staging bound");
              const frame = page.frames.find((frame) => frame.cursor === value.outputCursor);
              joined.push({ event: value, host: frame?.producer?.kind === "host" });
            });
            if (recovery.incomplete) throw new Error("Main output journal join is incomplete");
          }
          // Admission is bounded. Never silently forget deduplication evidence.
          const previous = this.replayed.get(sessionId) ?? new Map<string, string>();
          if (this.replayCount + joined.length > 8192)
            throw new Error("Main output replay identity capacity");
          this.replayed.set(sessionId, previous);
          for (const { event: value, host } of joined) {
            if (value.outputCursor === event.outputCursor || host) {
              if (!publish(value.outputCursor === event.outputCursor ? event : value))
                throw new Error("Main external output was not applied");
            } else {
              if (!this.options.worker(sessionId, value))
                throw new Error("Main output replay was not applied");
              previous.set(value.outputCursor!, fingerprint(value));
              this.replayCount++;
            }
          }
        } catch (cause) {
          // Keep genuine publication/coverage failures visible behind the
          // existing sticky barrier, but never aim them at a replacement.
          producer.capture(sessionId);
          publish({ ...(raw as object), outputCursor: undefined, outputRecovery: "incomplete" });
          throw cause;
        }
      },
    };
  }

  forget(sessionId: string): void {
    this.workerSources.delete(sessionId);
    this.replayCount -= this.replayed.get(sessionId)?.size ?? 0;
    this.replayed.delete(sessionId);
  }
}
