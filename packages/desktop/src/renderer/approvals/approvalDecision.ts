/**
 * Pure mapping from a UI approve-scope choice to the engine's ApprovalResult
 * shape. Kept DOM-free so the once/session/project semantics are unit-testable
 * without rendering the card.
 *
 * The core InteractiveApprovalBackend (packages/core .../permission.ts) reads
 * `always` + `scope`:
 *   - once    → a one-shot approval (no rule remembered)
 *   - session → remembered in-memory for the rest of the session
 *   - project → persisted to <cwd>/.code-shell/settings.local.json
 *
 * "once" deliberately carries NEITHER `always` NOR `scope` so it is byte-for-
 * byte the legacy approve payload — guaranteeing the default path is a no-op
 * regression-wise.
 */

export type ApproveChoice = "once" | "session" | "project";
export type ApprovalScope = "once" | "session" | "project";

/** The approve branch of the engine's ApprovalResult (renderer-side mirror). */
export interface ApproveDecision {
  approved: true;
  always?: boolean;
  scope?: ApprovalScope;
}

/** Map a split-button choice to the decision payload sent over RPC. */
export function decisionFromChoice(choice: ApproveChoice): ApproveDecision {
  if (choice === "once") return { approved: true };
  return { approved: true, always: true, scope: choice };
}

/** The three approve choices, in menu order, with user-facing labels. */
export const APPROVE_CHOICES: ReadonlyArray<{
  choice: ApproveChoice;
  label: string;
  /** Optional secondary line (e.g. where a project grant is written). */
  hint?: string;
}> = [
  { choice: "once", label: "仅本次" },
  { choice: "session", label: "本会话一直允许" },
  {
    choice: "project",
    label: "本项目一直允许",
    hint: "写入 .code-shell/settings.local.json",
  },
];
