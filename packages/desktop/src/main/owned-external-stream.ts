import type { SessionSnapshotStore } from "./SessionSnapshotStore.js";

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
): void {
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
}
