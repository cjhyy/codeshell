import type { SessionSnapshot, StreamEventEnvelope } from "../../preload/types";

export type PetChatBufferedEvent = StreamEventEnvelope | { workerExited: true };
export type PetChatReplayEvent = PetChatBufferedEvent | { snapshot: SessionSnapshot };

/** Merge the retained prefix with live events, keeping process exits between runs. */
export function petChatReplay(
  sessionId: string,
  snapshot: SessionSnapshot | undefined,
  buffered: PetChatBufferedEvent[],
): PetChatReplayEvent[] {
  if (!snapshot) return buffered;
  // The disk read owns historical turns. Their ordinary user inputs are not
  // in this stream, so replaying old replies creates unanchored duplicates.
  let latestRun = 0;
  for (let index = snapshot.events.length - 1; index >= 0; index -= 1) {
    const { event } = snapshot.events[index]!;
    if (event.type === "session_started" && !("agentId" in event && event.agentId)) {
      latestRun = index;
      break;
    }
  }
  const events = snapshot.events.slice(latestRun);
  const firstSeq = events[0]?.seq ?? snapshot.nextSeq;
  const result: PetChatReplayEvent[] = [];
  let cursor = 0;
  let snapshotApplied = false;
  const flush = (beforeSeq = Infinity): void => {
    while (cursor < events.length && events[cursor]!.seq < beforeSeq) {
      result.push({ sessionId, epoch: snapshot.epoch, ...events[cursor++]! });
    }
    if (cursor === events.length && !snapshotApplied) {
      result.push({ snapshot });
      snapshotApplied = true;
    }
  };
  for (let index = 0; index < buffered.length; index += 1) {
    const entry = buffered[index]!;
    if ("workerExited" in entry) {
      // A snapshot can already contain a replacement worker's run. Insert
      // this exit before the next observed event instead of after that run.
      const next = buffered
        .slice(index + 1)
        .find(
          (item): item is StreamEventEnvelope =>
            !("workerExited" in item) &&
            item.sessionId === sessionId &&
            item.epoch === snapshot.epoch &&
            item.seq !== undefined,
        );
      flush(next?.seq);
      result.push(entry);
    } else if (entry.sessionId === sessionId) {
      if (entry.epoch === snapshot.epoch && entry.seq !== undefined && entry.seq < firstSeq)
        continue;
      flush(entry.epoch === snapshot.epoch && entry.seq !== undefined ? entry.seq + 1 : Infinity);
      result.push(entry);
    }
  }
  flush();
  return result;
}
