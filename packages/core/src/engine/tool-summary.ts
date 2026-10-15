/**
 * Tool use summary — generates a 1-line progress label after tool batch execution.
 *
 * Common built-ins use metadata-only local labels, avoiding a model request
 * for routine progress. Other tools retain the asynchronous summary path.
 */

import type { ToolCall, ToolResult } from "../types.js";
import { logger } from "../logging/logger.js";

const SUMMARY_SYSTEM_PROMPT =
  "Generate a very brief (under 40 chars) summary of what these tools did. " +
  "Use past tense, commit-subject style. Examples: " +
  '"Read 3 config files", "Fixed import in auth.ts", "Searched for API endpoints". ' +
  "Respond with ONLY the summary text, nothing else.";

export type SummarizeFn = (
  systemPrompt: string,
  userMessage: string,
  signal?: AbortSignal,
) => Promise<string>;

const LOCAL_LABELS: Readonly<Record<string, string>> = {
  Read: "Read",
  Write: "Wrote",
  Edit: "Edited",
  ApplyPatch: "Applied patch",
  apply_patch: "Applied patch",
  Grep: "Searched",
  Glob: "Listed files",
  Bash: "Ran command",
  PowerShell: "Ran command",
  REPL: "Ran code",
  TodoWrite: "Updated tasks",
  ToolSearch: "Discovered tools",
  Skill: "Loaded skill",
  BashOutput: "Read process output",
  ListShells: "Listed processes",
  KillShell: "Stopped process",
};

function localSummary(toolCalls: ToolCall[], results: ToolResult[]): string | undefined {
  const labels = new Map<string, number>();
  const resultsById = new Map(results.map((result) => [result.id, result]));
  let failed = 0;
  for (const call of toolCalls) {
    if (!Object.hasOwn(LOCAL_LABELS, call.toolName)) return undefined;
    const result = resultsById.get(call.id);
    if (!result) return undefined;
    if (result.isError || result.error) failed += 1;
    let label = LOCAL_LABELS[call.toolName]!;
    if (call.toolName === "Bash" && call.args.run_in_background === true) {
      label = "Started background command";
    } else if (
      call.toolName === "Skill" &&
      !call.args.skill &&
      typeof call.args.query === "string"
    ) {
      label = "Searched skills";
    }
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }
  // Never turn a failed operation into a successful-sounding progress label,
  // or copy potentially sensitive command arguments/output into the label.
  if (failed > 0) return `Finished ${toolCalls.length} tools (${failed} failed)`;
  const label = [...labels]
    .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
    .join(", ");
  return label.length <= 80 ? label : `Finished ${toolCalls.length} tools`;
}

/**
 * Generate a 1-line summary of completed tool executions.
 * Returns null on failure (non-critical).
 */
export async function generateToolUseSummary(
  toolCalls: ToolCall[],
  results: ToolResult[],
  summarize: SummarizeFn,
  signal?: AbortSignal,
): Promise<string | null> {
  if (toolCalls.length === 0 || signal?.aborted) return null;
  const local = localSummary(toolCalls, results);
  if (local !== undefined) return local;

  try {
    const parts: string[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const result = results[i];
      const input = JSON.stringify(tc.args).slice(0, 200);
      const output = (result?.result ?? result?.error ?? "").slice(0, 300);
      parts.push(`Tool: ${tc.toolName}(${input}) → ${output}`);
    }

    const summary = await summarize(SUMMARY_SYSTEM_PROMPT, parts.join("\n"), signal);
    return summary?.trim() || null;
  } catch (err) {
    logger.warn("tool_summary.failed", { error: (err as Error).message });
    return null;
  }
}
