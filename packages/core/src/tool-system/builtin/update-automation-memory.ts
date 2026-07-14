/**
 * UpdateAutomationMemory — lets an automation (cron/scheduled) run persist a
 * one-paragraph summary of what it did, so the NEXT run starts with context.
 *
 * This is a FACTORY: core must not depend on desktop's filesystem layer, so the
 * actual persistence is supplied by an injected `sink` callback. A later task
 * (the desktop automation runner) injects a sink that appends to the task's
 * memory.md; this module only builds the tool + validates input.
 */

import type { BuiltinTool } from "./index.js";
import type { ToolDefinition } from "../../types.js";

/**
 * Bare tool definition (name/description/inputSchema) — mirrors the export
 * style of the other builtin tool defs (e.g. cron.ts). The factory below wraps
 * this into a registry-ready RegisteredTool.
 */
export const updateAutomationMemoryToolDef: ToolDefinition = {
  name: "UpdateAutomationMemory",
  description:
    "Persist a short memory note for this automation task so your NEXT scheduled run " +
    "starts with context. Call this EXACTLY ONCE, at the very end of the run, with a " +
    "concise one-paragraph summary of what you did, what you found, and anything the " +
    "next run should know or continue (e.g. items processed, last cursor/timestamp, " +
    "open issues). Keep it to a few sentences — it is prepended to your future prompts.",
  inputSchema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "A concise one-paragraph summary of this run for the next run to build on.",
      },
    },
    required: ["summary"],
  },
};

/**
 * Build an UpdateAutomationMemory tool bound to a persistence `sink`.
 *
 * @param sink Called with the trimmed summary when a non-empty summary is given.
 *             The caller decides where/how to persist it.
 */
export function makeUpdateAutomationMemoryTool(sink: (summary: string) => void): BuiltinTool {
  return {
    definition: {
      ...updateAutomationMemoryToolDef,
      source: "builtin",
      // The summary is automation-internal bookkeeping (not user code); no prompt.
      permissionDefault: "allow",
      // Writes (via the injected sink), so not read-only / not concurrency-safe.
      isReadOnly: false,
      isConcurrencySafe: false,
    },
    // Host-injected automation contribution, never part of a default preset.
    exposure: { presetTags: [] },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const raw = typeof args.summary === "string" ? args.summary : "";
      const summary = raw.trim();
      if (!summary) {
        return "Error: summary is required and must not be empty";
      }
      sink(summary);
      return "Automation memory saved for the next run.";
    },
  };
}
