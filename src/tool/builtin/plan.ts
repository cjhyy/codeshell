/**
 * Plan mode — restricts the agent to read-only exploration and text output.
 *
 * In plan mode the agent:
 *   - Can only use read-only tools (Read, Glob, Grep, Bash read-only, WebSearch, etc.)
 *   - CANNOT write, edit, or create files
 *   - Outputs its plan as text directly in the conversation
 *   - Exits plan mode when the user approves or via ExitPlanMode tool
 */

import type { ToolDefinition } from "../../types.js";

export const enterPlanModeToolDef: ToolDefinition = {
  name: "EnterPlanMode",
  description:
    "Enter plan mode for complex, high-risk, or ambiguous tasks. " +
    "ONLY use this when: (1) the user explicitly asks for a plan before implementation, " +
    "(2) the task involves large-scale refactoring across many files, or " +
    "(3) the task is ambiguous and you need to propose an approach for user approval. " +
    "Do NOT enter plan mode for straightforward tasks like fixing a bug, adding a small feature, " +
    "or answering a question. In plan mode, output your plan as text, then call ExitPlanMode.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export const exitPlanModeToolDef: ToolDefinition = {
  name: "ExitPlanMode",
  description:
    "Exit plan mode and return to normal mode. Call this after outputting your plan " +
    "so you can proceed with implementation.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ─── Plan mode state ──────────────────────────────────────────

let _inPlanMode = false;

export function isInPlanMode(): boolean {
  return _inPlanMode;
}

export function setInPlanMode(value: boolean): void {
  _inPlanMode = value;
}

export function resetPlanMode(): void {
  _inPlanMode = false;
}

export function restorePlanMode(): void {
  _inPlanMode = true;
}

// ─── Tool implementations ─────────────────────────────────────

export async function enterPlanModeTool(_args: Record<string, unknown>): Promise<string> {
  if (_inPlanMode) {
    return "Already in plan mode. Output your plan as text, then call ExitPlanMode.";
  }

  _inPlanMode = true;

  return [
    "Entered plan mode.",
    "",
    "Rules:",
    "- You can ONLY use read-only tools: Read, Glob, Grep, WebSearch, WebFetch, and read-only Bash commands",
    "- You CANNOT write, edit, or create any files",
    "- Output your plan as text directly in the conversation",
    "- Use markdown formatting with clear steps, file paths, and rationale",
    "- Call ExitPlanMode when your plan is complete and ready for review",
  ].join("\n");
}

export async function exitPlanModeTool(_args: Record<string, unknown>): Promise<string> {
  if (!_inPlanMode) {
    return "Not currently in plan mode.";
  }

  _inPlanMode = false;
  return "Exited plan mode. You can now write and edit files to implement the plan.";
}
