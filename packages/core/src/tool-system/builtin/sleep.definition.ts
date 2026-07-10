/**
 * Sleep tool metadata.
 *
 * Kept separate from the executor so registration and presets can consume the
 * definition without importing implementation code.
 */

import type { ToolDefinition } from "../../types.js";

export const sleepToolDef: ToolDefinition = {
  name: "Sleep",
  description:
    "Pause execution for a brief, deterministic wait (e.g. letting a just-started service settle for a few seconds). " +
    "Do NOT use Sleep to poll for or wait on background work (background shells, async sub-agents, video generation): " +
    "the system wakes you automatically when that work completes — just end your turn instead of looping Sleep. " +
    "If you want a safety net in case a background task hangs and never signals completion, do NOT loop Sleep either — " +
    "instead end your turn and schedule a one-shot self-wakeup with CronCreate " +
    "({ schedule: '5m', once: true, continueInSession: true, permissionLevel: 'read-only', " +
    "prompt: 'check whether <that task> finished; if still running, wait again' }). " +
    "That returns control to you at the interval without burning a turn spinning. " +
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
