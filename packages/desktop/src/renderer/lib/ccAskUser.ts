/**
 * AskUserQuestion over the external Claude Code (CC) `can_use_tool` control
 * protocol. Shared by the desktop CC view and the phone CC view (both import
 * from src/renderer/lib so the logic lives in exactly one place).
 *
 * CC's AskUserQuestion input is a NESTED `questions[]` array (each question with
 * its own `options`), distinct from codeshell's internal flat `options` shape.
 * The user's choice must be returned inside `updatedInput.answers`, keyed by the
 * question TEXT with the selected option's `label` as the value — auto-allowing
 * with the unmodified input makes claude report "the user did not answer the
 * questions" (see reference: CC AskUserQuestion protocol).
 *
 * We surface only the FIRST question (the phone/desktop approval card is a
 * single prompt). Multi-question requests are rare; the first is the one the
 * user is asked, and claude re-asks the rest if it still needs them.
 */

export interface CcAskUser {
  question: string;
  options: string[];
  multiSelect: boolean;
}

interface CcQuestion {
  question?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

function firstQuestion(input: unknown): CcQuestion | undefined {
  if (!input || typeof input !== "object") return undefined;
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs) || qs.length === 0) return undefined;
  const q = qs[0];
  return q && typeof q === "object" ? (q as CcQuestion) : undefined;
}

function optionLabels(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  return options
    .map((o) => (o && typeof o === "object" ? (o as { label?: unknown }).label : undefined))
    .filter((l): l is string => typeof l === "string");
}

/** Detect a CC AskUserQuestion input and pull its first question's options. */
export function extractCcAskUser(input: unknown): CcAskUser | undefined {
  const q = firstQuestion(input);
  if (!q) return undefined;
  const options = optionLabels(q.options);
  if (options.length === 0) return undefined;
  return {
    question: typeof q.question === "string" ? q.question : "",
    options,
    multiSelect: q.multiSelect === true,
  };
}

/**
 * Build the `{behavior:"allow", updatedInput}` control decision that delivers the
 * user's answer to claude. `answer` is the chosen option label (or, for
 * multiSelect, a comma-separated string the caller assembled).
 */
export function buildCcAskUserAnswer(
  input: unknown,
  answer: string,
): { behavior: "allow"; updatedInput: { questions: unknown; answers: Record<string, string> } } {
  const q = firstQuestion(input);
  const questions = (input as { questions?: unknown } | undefined)?.questions ?? [];
  const key = typeof q?.question === "string" && q.question ? q.question : "answer";
  return {
    behavior: "allow",
    updatedInput: { questions, answers: { [key]: answer } },
  };
}
