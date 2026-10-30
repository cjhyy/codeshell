/** Drain every started read before returning, including when one sibling fails. */
export async function inspectBatch<T, U>(items: readonly T[], read: (item: T) => Promise<U>) {
  const results = await Promise.allSettled(
    items.map((item) => Promise.resolve().then(() => read(item))),
  );
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
}

// Keep descriptor and buffer concurrency bounded. Each file retains its normal
// validation and no result survives an inspection call.
export const INSPECTION_BATCH_SIZE = 4;
