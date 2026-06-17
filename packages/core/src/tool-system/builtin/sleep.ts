/**
 * SleepTool — pause execution for a specified duration.
 */

import type { ToolDefinition } from "../../types.js";

export const sleepToolDef: ToolDefinition = {
  name: "Sleep",
  description:
    "Pause execution for a brief, deterministic wait (e.g. letting a just-started service settle for a few seconds). " +
    "Do NOT use Sleep to poll for or wait on background work (background shells, async sub-agents, video generation): " +
    "the system wakes you automatically when that work completes — just end your turn instead of looping Sleep. " +
    "Maximum duration is 300 seconds (5 minutes).",
  inputSchema: {
    type: "object",
    properties: {
      seconds: {
        type: "number",
        description: "Number of seconds to sleep (max 300)",
      },
    },
    required: ["seconds"],
  },
};

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
