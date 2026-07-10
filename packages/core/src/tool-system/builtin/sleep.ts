/**
 * SleepTool — pause execution for a specified duration.
 */

export { sleepToolDef } from "./sleep.definition.js";

export async function sleepTool(args: Record<string, unknown>): Promise<string> {
  const seconds = Math.min(Math.max(Number(args.seconds) || 1, 0.1), 300);

  const signal = args.__signal as AbortSignal | undefined;
  if (signal?.aborted) return "Sleep aborted.";

  await new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Sleep aborted"));
    };
    const timer = setTimeout(() => {
      // Remove the abort listener on normal completion — otherwise every Sleep
      // call leaks a listener on the (shared, per-turn) signal.
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, seconds * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
  }).catch(() => {});

  return `Slept for ${seconds} seconds.`;
}
