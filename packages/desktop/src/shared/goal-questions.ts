import type { StreamEvent } from "@cjhyy/code-shell-core";

export type GoalUserQuestion = NonNullable<
  Extract<StreamEvent, { type: "goal_progress" }>["waitingQuestions"]
>[number];

const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_QUESTION_CHARS = 300;
const MAX_HEADER_CHARS = 24;
const MAX_LABEL_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;

/** JSON schema for wait_for_user's structured `questions` argument. */
export const GOAL_QUESTIONS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: MAX_QUESTIONS,
  description:
    "Questions shown as choices in the goal's reply card. Prefer 1 and do not exceed 3. " +
    "Use this whenever the answer is a choice between known options; never write a multiple-choice question as text.",
  items: {
    type: "object",
    properties: {
      id: { type: "string", description: "Stable snake_case identifier for this question." },
      header: {
        type: "string",
        description: "Short label shown above the question (12 or fewer characters).",
      },
      question: { type: "string", description: "Single-sentence prompt shown to the user." },
      options: {
        type: "array",
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description:
          "2-3 mutually exclusive choices. Put the recommended option first and mark its label as recommended, " +
          'for example "(Recommended)" or "（推荐）". Do not add an "Other" option; the card adds a free-form one.',
        items: {
          type: "object",
          properties: {
            label: { type: "string", description: "User-facing label (1-5 words)." },
            description: {
              type: "string",
              description: "One short sentence on the impact or tradeoff of this choice.",
            },
          },
          required: ["label"],
        },
      },
    },
    required: ["id", "question", "options"],
  },
} as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Validates wait_for_user `questions`. Returns undefined when absent, the
 * parsed questions when valid, or an error the model can act on.
 */
export function parseGoalQuestions(value: unknown): {
  questions?: GoalUserQuestion[];
  error?: string;
} {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) {
    return { error: `questions must list 1 to ${MAX_QUESTIONS} questions.` };
  }
  const ids = new Set<string>();
  const questions: GoalUserQuestion[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return { error: `questions[${index}] must be an object.` };
    const entry = raw as Record<string, unknown>;
    const question = text(entry.question);
    if (!question || question.length > MAX_QUESTION_CHARS) {
      return {
        error: `questions[${index}].question must be one short sentence (at most ${MAX_QUESTION_CHARS} characters); put background in your reply.`,
      };
    }
    const id = text(entry.id) || `q${index + 1}`;
    if (ids.has(id)) return { error: `questions[${index}].id "${id}" is repeated.` };
    ids.add(id);
    const header = text(entry.header).slice(0, MAX_HEADER_CHARS);
    const rawOptions = entry.options;
    if (
      !Array.isArray(rawOptions) ||
      rawOptions.length < MIN_OPTIONS ||
      rawOptions.length > MAX_OPTIONS
    ) {
      return {
        error: `questions[${index}].options must list ${MIN_OPTIONS} to ${MAX_OPTIONS} choices.`,
      };
    }
    const labels = new Set<string>();
    const options: GoalUserQuestion["options"] = [];
    for (const [optionIndex, rawOption] of rawOptions.entries()) {
      const option = (rawOption ?? {}) as Record<string, unknown>;
      const label = text(option.label);
      if (!label || label.length > MAX_LABEL_CHARS || labels.has(label)) {
        return {
          error: `questions[${index}].options[${optionIndex}].label must be a short, distinct label.`,
        };
      }
      labels.add(label);
      const description = text(option.description).slice(0, MAX_DESCRIPTION_CHARS);
      options.push({ label, ...(description ? { description } : {}) });
    }
    questions.push({ id, ...(header ? { header } : {}), question, options });
  }
  return { questions };
}

/** Plain-text form, for older readers and for repeating the open question to the model. */
export function goalQuestionsText(questions: readonly GoalUserQuestion[]): string {
  return questions
    .map((q) => {
      const options = q.options.map((option) => option.label).join(" / ");
      return `${q.header ? `${q.header}: ` : ""}${q.question} [${options}]`;
    })
    .join("; ");
}
