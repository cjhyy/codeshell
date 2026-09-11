import { rm } from "node:fs/promises";

/** Only resources owned by the current setup attempt may be released here. */
export async function releaseManagedTtsSetupResources(
  lock: { close(): Promise<void> } | undefined,
  lockPath: string,
  sample: string | undefined,
  primaryFailure?: Error,
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (cleanup: () => Promise<unknown>) => {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  };
  if (lock) {
    await attempt(() => lock.close());
    await attempt(() => rm(lockPath, { force: true }));
  }
  if (sample) await attempt(() => rm(sample, { force: true }));
  if (failures.length === 0) return;
  if (primaryFailure) {
    // Preserve the original message and AbortError identity while retaining
    // cleanup diagnostics; a finally rejection must not replace that failure.
    primaryFailure.cause = new AggregateError(
      [...(primaryFailure.cause === undefined ? [] : [primaryFailure.cause]), ...failures],
      "Managed speech setup failed and resource cleanup also failed",
    );
  } else {
    throw new AggregateError(failures, "Managed speech setup resource cleanup failed");
  }
}
