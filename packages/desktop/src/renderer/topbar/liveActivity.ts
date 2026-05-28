/**
 * Summarise the currently-streaming turn for the TopBar status
 * popover. Runs on every render of App while busy, so it has to be
 * cheap — single pass from the end of the messages array, no
 * allocations beyond the returned object.
 *
 * The "current turn" is everything after the most recent UserMessage.
 * If the user hasn't sent anything yet (no UserMessage in history),
 * we walk the whole array — that's the initial system prompt / boot
 * tool calls case.
 */

import type { Message } from "../types";

export interface LiveActivity {
  /** Name of the most recent in-flight tool, or the last completed
   *  tool if nothing is in-flight. Empty string while there are no
   *  tools yet (e.g. assistant is just thinking). */
  lastToolName: string;
  /** Tool calls fired since the most recent user message. */
  toolCount: number;
  /** Earliest tool startedAt in this turn — drives the elapsed
   *  ticker. 0 means no tools yet; consumers should fall back to
   *  the user message timestamp or "just started" copy. */
  turnStartedAt: number;
  /** True while there's a tool in-flight (status === "running"). */
  toolInFlight: boolean;
}

export function summarizeLiveActivity(messages: Message[]): LiveActivity {
  // Walk backward to find the last user message; anything after it
  // is the current turn.
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.kind === "user") {
      turnStart = i + 1;
      break;
    }
  }

  let toolCount = 0;
  let earliestStart = Infinity;
  let lastTool: { name: string; startedAt: number; running: boolean } | null =
    null;
  let runningTool: { name: string; startedAt: number } | null = null;

  for (let i = turnStart; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.kind !== "tool") continue;
    toolCount += 1;
    if (m.startedAt < earliestStart) earliestStart = m.startedAt;
    const running = m.status === "running";
    lastTool = { name: m.toolName, startedAt: m.startedAt, running };
    if (running) runningTool = { name: m.toolName, startedAt: m.startedAt };
  }

  return {
    lastToolName: runningTool?.name ?? lastTool?.name ?? "",
    toolCount,
    turnStartedAt: isFinite(earliestStart) ? earliestStart : 0,
    toolInFlight: runningTool !== null,
  };
}

/** Format an elapsed millisecond delta like the AgentMessageView ticker. */
export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, ms)}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem === 0 ? `${m}m` : `${m}m${rem}s`;
}
