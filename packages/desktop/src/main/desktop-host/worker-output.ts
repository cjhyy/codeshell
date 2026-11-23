import type { SessionSnapshotStore, SnapshotEntry } from "../SessionSnapshotStore.js";
import type { MainOutputPublisher } from "../main-output-publisher.js";
import {
  annotateBrowserRuntimeStreamEvent,
  replaceStreamEventInLine,
} from "../browser-runtime/stream-projection.js";
import { parseLiveStreamEnvelope, parseSnapshotAppend } from "../parseStreamLine.js";
import type { ParsedWorkerLine } from "../worker-line.js";

export interface WorkerOutputObserver {
  observeLifecycle(sessionId: string, event: unknown): void;
  report(event: string, data: Record<string, unknown>): void;
}

/** Called only after private worker messages have been consumed. The live view
 * and downstream readers must share the same accepted event, epoch and sequence. */
export function projectWorkerOutput(
  parsed: ParsedWorkerLine,
  output: Pick<MainOutputPublisher, "observeWorker">,
  snapshots: Pick<SessionSnapshotStore, "append" | "epoch">,
  observer: WorkerOutputObserver,
) {
  const { line } = parsed;
  const append = parseSnapshotAppend(line, parsed);
  if (!append) {
    return {
      projectedLine: line,
      liveStreamEnvelope: parseLiveStreamEnvelope(line, undefined, parsed),
    };
  }

  const sessionId = append.sessionId;
  let event = append.event;
  try {
    if (!output.observeWorker(sessionId, event)) return;
  } catch (error) {
    observer.report("stream.source_unavailable", { sessionId, error: String(error) });
    if (!(error as { coverageIncomplete?: boolean })?.coverageIncomplete) return;
    event = { ...(event as object), outputCursor: undefined, outputRecovery: "incomplete" };
  }
  event = annotateBrowserRuntimeStreamEvent(event, "milestones");
  observer.observeLifecycle(sessionId, event);
  let snapshotEntry: SnapshotEntry & { sessionId: string; epoch: string };
  try {
    snapshotEntry = { sessionId, epoch: snapshots.epoch, ...snapshots.append(sessionId, event) };
  } catch {
    observer.report("stream.coverage_unavailable", { sessionId });
    return;
  }
  return {
    snapshotEntry,
    liveStreamEnvelope: { sessionId, event, seq: snapshotEntry.seq, epoch: snapshotEntry.epoch },
    projectedLine: replaceStreamEventInLine(line, event, parsed),
  };
}
