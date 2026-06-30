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
 * (executor defers to classifyBashCommand, admitting only "safe-read").
 * Write/Edit/ApplyPatch/NotebookEdit and other mutating tools are
 * intentionally excluded.
 */

/**
 * The built-in tools that only READ — no file writes, no side effects, no
 * network mutations. Single source of truth shared by:
 *   - investigation-guard.ts (which tools count as "just looking")
 *   - permission.ts HeadlessApprovalBackend (approve-read-only mode)
 *   - permission.ts assessRisk (these are genuinely low-risk; everything else,
 *     including MCP tools, is at least medium so it isn't auto-approved blind)
 * These three lists were independent byte-for-byte copies that could drift.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "ToolSearch",
]);
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
  // Skill: loads a skill's guidance text into context — read-only, no file
  // writes. Planning is exactly when methodology skills (brainstorming,
  // writing-plans, …) are most useful, so it belongs in the allow-list.
  "Skill",
  // Task tracking (non-destructive) — both the TodoWrite and the Task* family
  "TodoWrite",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  // Bash: visible to the model; executor gates it to read-only commands.
  "Bash",
]);
