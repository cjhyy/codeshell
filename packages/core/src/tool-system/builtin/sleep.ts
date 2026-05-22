/**
 * SleepTool — pause execution for a specified duration.
 */

import type { ToolDefinition } from "../../types.js";

export const sleepToolDef: ToolDefinition = {
  name: "Sleep",
  description:
    "Pause execution for a specified number of seconds. " +
    "Useful for polling workflows or waiting for external processes. " +
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
    const timer = setTimeout(resolve, seconds * 1000);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("Sleep aborted"));
    });
  }).catch(() => {});

  return `Slept for ${seconds} seconds.`;
}
