/**
 * Single source of truth for which tools are permitted in plan mode.
 *
 * Two call sites consume this:
 *   - engine.ts: filters the tool DEFINITIONS shown to the model, so the
 *     model only sees tools it's allowed to use while planning.
 *   - executor.ts: gates tool EXECUTION, refusing anything outside the set.
 *
 * These two lists used to be maintained separately and drifted (engine had
 * the Task family + Bash but not TodoWrite; executor had TodoWrite but not the
 * Task family), so the model could be shown a tool the executor would then
 * block, or vice-versa. Keep them identical by importing this constant in
 * both places.
 *
 * Membership policy: read-only tools, planning/agent tools, and
 * non-destructive task-tracking tools. Bash is included so the model sees it;
 * the executor additionally gates Bash to read-only commands at call time
 * (see executor.isReadOnlyBashCommand). Write/Edit/ApplyPatch/NotebookEdit and
 * other mutating tools are intentionally excluded.
 */
export const PLAN_MODE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  // Plan lifecycle
  "EnterPlanMode",
  "ExitPlanMode",
  // Read-only investigation
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  // Agent / interaction / discovery
  "AskUserQuestion",
  "Agent",
  "ToolSearch",
  // Task tracking (non-destructive) — both the TodoWrite and the Task* family
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  // Bash: visible to the model; executor gates it to read-only commands.
  "Bash",
]);
