import type { SessionSnapshotStore, SnapshotEntry } from "./SessionSnapshotStore.js";

export interface OwnedExternalStreamEntry extends SnapshotEntry {
  sessionId: string;
  epoch: string;
  ownerWebContentsId: number;
}

interface StreamWindow {
  isDestroyed(): boolean;
  webContents: { id: number; send(channel: string, payload: unknown): void };
}

/** Append once to Main recovery state, then aim live output at its exact owner. */
export function publishOwnedExternalStream(
  snapshots: SessionSnapshotStore,
  windows: Iterable<StreamWindow>,
  ownerId: number | undefined,
  sessionId: string,
  event: unknown,
): OwnedExternalStreamEntry | undefined {
  const entry = snapshots.append(sessionId, event);
  const owner = [...windows].find(
    (window) => !window.isDestroyed() && window.webContents.id === ownerId,
  );
  try {
    owner?.webContents.send("agent:streamEvent", {
      sessionId,
      event,
      seq: entry.seq,
      epoch: snapshots.epoch,
    });
  } catch {
    /* Committed output remains recoverable if its owner remounts. */
  }
  return owner && ownerId !== undefined
    ? { ...entry, sessionId, epoch: snapshots.epoch, ownerWebContentsId: ownerId }
    : undefined;
}
