export function resolveOpenCliSessionBucket(
  sourceSessionId: string,
  engineToBucket: ReadonlyMap<string, string>,
  activeBucket: string,
): string {
  return engineToBucket.get(sourceSessionId) ?? activeBucket;
}
