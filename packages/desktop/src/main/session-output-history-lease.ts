/** Main-owned fence shared by native ingress and external-runtime submissions. */
const revisions = new Map<string, number>();
const held = new Set<string>();
export function outputHistoryRecoveryRevision(sessionId: string): number {
  return revisions.get(sessionId) ?? 0;
}
export function assertOutputHistoryWriteAvailable(
  sessionId: string,
  expectedRevision?: number,
): void {
  if (
    held.has(sessionId) ||
    (expectedRevision !== undefined &&
      expectedRevision !== outputHistoryRecoveryRevision(sessionId))
  )
    throw new Error(
      "Session output recovery changed; review the current conversation before sending",
    );
}
export function acquireOutputHistoryRecovery(sessionId: string): () => void {
  assertOutputHistoryWriteAvailable(sessionId);
  if (!revisions.has(sessionId) && revisions.size >= 8192)
    throw new Error("Output recovery fence capacity");
  revisions.set(sessionId, outputHistoryRecoveryRevision(sessionId) + 1);
  held.add(sessionId);
  return () => {
    held.delete(sessionId);
  };
}
