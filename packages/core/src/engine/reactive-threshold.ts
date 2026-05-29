/**
 * Reactive-compaction probe gating.
 *
 * During streaming the turn loop accumulates an estimate of the response
 * size and periodically asks the ContextManager whether we're nearing the
 * context limit. The old gate (`tokens % 2000 === 0`) almost never matched a
 * running `+= ceil(len/4)` accumulator, so the probe never fired. This fires
 * once per 2000-token bucket crossed, tracked by `lastBucket`.
 */

const REACTIVE_BUCKET = 2000;

export function crossedReactiveThreshold(
  accumulatedTokens: number,
  lastBucket: number,
): { crossed: boolean; bucket: number } {
  const bucket = Math.floor(accumulatedTokens / REACTIVE_BUCKET);
  if (bucket >= 1 && bucket > lastBucket) {
    return { crossed: true, bucket };
  }
  return { crossed: false, bucket: lastBucket };
}
