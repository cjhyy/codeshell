export function resolveOpenCliSessionBucket(
  sourceSessionId: string,
  engineToBucket: ReadonlyMap<string, string>,
  sessionIndices: Record<
    string,
    { sessions: Array<{ id: string; engineSessionId?: string | null }> }
  >,
): string | null {
  const direct = engineToBucket.get(sourceSessionId);
  if (direct) return direct;
  for (const [projectBucketSegment, index] of Object.entries(sessionIndices)) {
    const owner = index.sessions.find((session) => session.engineSessionId === sourceSessionId);
    if (owner) return `${projectBucketSegment}::${owner.id}`;
  }
  return null;
}
