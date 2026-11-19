import type { StreamEvent } from "@cjhyy/code-shell-core";

/** Structure of an open wait_for_user question, as `goal_progress` carries it. */
export type GoalQuestionDetail = NonNullable<
  Extract<StreamEvent, { type: "goal_progress" }>["waitingForUserDetail"]
>;
/** One wait_for_user question with mutually exclusive options. */
export type GoalUserQuestion = NonNullable<GoalQuestionDetail["questions"]>[number];
/** L1 "preference": has a sensible default. L2 "consent": needs explicit agreement. */
export type GoalQuestionLevel = GoalQuestionDetail["level"];

/** A validated wait_for_user call, as the host shows it (never repeated in reply text). */
export interface GoalQuestion {
  /** Plain-text form: the context the asker wrote, else the questions spelled out. */
  text: string;
  level: GoalQuestionLevel;
  questions?: GoalUserQuestion[];
}

/** `question` is one or two sentences; background belongs in the reply text. */
export const GOAL_MAX_QUESTION_CHARS = 600;
const MAX_QUESTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_STRUCTURED_QUESTION_CHARS = 300;
const MAX_HEADER_CHARS = 24;
const MAX_LABEL_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 200;

const OPTION_LABEL = { type: "string", maxLength: MAX_LABEL_CHARS } as const;

/** JSON schema of wait_for_user's own arguments (goalId/revision are added by the catalog). */
export const GOAL_WAIT_FOR_USER_PROPERTIES = {
  question: {
    type: "string",
    maxLength: GOAL_MAX_QUESTION_CHARS,
    description:
      "One or two sentences: the question itself, or the context for `questions` (optional when `questions` is given). Longer background belongs in your reply text.",
  },
  questions: {
    type: "array",
    minItems: 1,
    maxItems: MAX_QUESTIONS,
    description:
      "Questions shown as choices in the goal's reply banner. Prefer 1 and do not exceed 3. " +
      "Use this whenever the answer is a choice between known options; never write a multiple-choice question as text.",
    items: {
      type: "object",
      properties: {
        id: { type: "string", description: "Stable snake_case identifier for this question." },
        header: {
          type: "string",
          description: "Short label shown beside the question (12 or fewer characters).",
        },
        question: { type: "string", description: "Single-sentence prompt shown to the user." },
        options: {
          type: "array",
          minItems: MIN_OPTIONS,
          maxItems: MAX_OPTIONS,
          description:
            "2-4 mutually exclusive choices, the recommended one first. Do not add a recommended marker " +
            'or an "Other" option: the banner marks the recommendation and the user can always type another answer.',
          items: {
            type: "object",
            properties: {
              label: { ...OPTION_LABEL, description: "User-facing label (1-5 words)." },
              description: {
                type: "string",
                description: "One short sentence on the impact or tradeoff of this choice.",
              },
            },
            required: ["label"],
          },
        },
        default: {
          type: "string",
          description:
            "Optional: the option label you would take if the user has no preference. Omit it when that is the first option.",
        },
      },
      required: ["id", "question", "options"],
    },
  },
  options: {
    type: "array",
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    items: OPTION_LABEL,
    description:
      "Shorthand for a single question: the answer labels for `question`, recommended first. Use `questions` when a choice needs a header or descriptions; never pass both.",
  },
  default: {
    type: "string",
    description: "With `options` only: the label you would take if the user has no preference.",
  },
  level: {
    type: "string",
    enum: ["preference", "consent"],
    description:
      '"preference": a choice with a sensible default. "consent": an irreversible, outward-facing, production, credential or spending action that needs the user\'s explicit agreement; it must be a single question, is shown as agree / disagree, and options and defaults are ignored.',
  },
} as const;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Option labels and the default among them; `where` names the argument in errors. */
function parseChoices(
  rawOptions: unknown,
  rawDefault: unknown,
  where: string,
  labelPath: string,
): { options: GoalUserQuestion["options"]; default?: string } | { error: string } {
  if (
    !Array.isArray(rawOptions) ||
    rawOptions.length < MIN_OPTIONS ||
    rawOptions.length > MAX_OPTIONS
  ) {
    return { error: `${where}options must list ${MIN_OPTIONS} to ${MAX_OPTIONS} choices.` };
  }
  const labels = new Set<string>();
  const options: GoalUserQuestion["options"] = [];
  for (const [index, rawOption] of rawOptions.entries()) {
    const option = (rawOption ?? {}) as Record<string, unknown>;
    const label = text(option.label);
    if (!label || label.length > MAX_LABEL_CHARS || labels.has(label)) {
      return {
        error: `${where}options[${index}]${labelPath} must be a short, distinct label (at most ${MAX_LABEL_CHARS} characters).`,
      };
    }
    labels.add(label);
    const description = text(option.description).slice(0, MAX_DESCRIPTION_CHARS);
    options.push({ label, ...(description ? { description } : {}) });
  }
  const fallback = text(rawDefault);
  if (rawDefault !== undefined && rawDefault !== null && !labels.has(fallback)) {
    return { error: `${where}default must be one of the option labels, or omitted.` };
  }
  return { options, ...(fallback ? { default: fallback } : {}) };
}

function parseQuestions(value: unknown): { questions: GoalUserQuestion[] } | { error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUESTIONS) {
    return { error: `questions must list 1 to ${MAX_QUESTIONS} questions.` };
  }
  const ids = new Set<string>();
  const questions: GoalUserQuestion[] = [];
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== "object") return { error: `questions[${index}] must be an object.` };
    const entry = raw as Record<string, unknown>;
    const question = text(entry.question);
    if (!question || question.length > MAX_STRUCTURED_QUESTION_CHARS) {
      return {
        error: `questions[${index}].question must be one short sentence (at most ${MAX_STRUCTURED_QUESTION_CHARS} characters); put background in your reply.`,
      };
    }
    const id = text(entry.id) || `q${index + 1}`;
    if (ids.has(id)) return { error: `questions[${index}].id "${id}" is repeated.` };
    ids.add(id);
    const header = text(entry.header).slice(0, MAX_HEADER_CHARS);
    const choices = parseChoices(entry.options, entry.default, `questions[${index}].`, ".label");
    if ("error" in choices) return choices;
    const { options, default: fallback } = choices;
    questions.push({
      id,
      ...(header ? { header } : {}),
      question,
      options,
      ...(fallback ? { default: fallback } : {}),
    });
  }
  return { questions };
}

/**
 * The one validation of a wait_for_user call (and of a replayed one). A bare
 * `question` stays valid; flat `options`/`default` are shorthand for a
 * single-entry `questions`; a consent call is one question without choices.
 */
export function normalizeGoalQuestion(
  args: Record<string, unknown>,
): { question: GoalQuestion } | { error: string } {
  if (args.level !== undefined && args.level !== "preference" && args.level !== "consent") {
    return { error: 'level must be "preference" or "consent".' };
  }
  const level: GoalQuestionLevel = args.level === "consent" ? "consent" : "preference";
  const context = text(args.question);
  const tooLong = {
    error: `The question must be at most ${GOAL_MAX_QUESTION_CHARS} characters: ask one short question and put background in your reply.`,
  };
  if (context.length > GOAL_MAX_QUESTION_CHARS) return tooLong;
  if (args.questions != null && args.options != null) {
    return { error: "Pass either questions or the flat options shorthand, not both." };
  }

  let questions: GoalUserQuestion[] | undefined;
  if (args.questions != null) {
    const parsed = parseQuestions(args.questions);
    if ("error" in parsed) return parsed;
    questions = parsed.questions;
  } else if (level !== "consent" && (args.options != null || args.default != null)) {
    if (!context) return { error: "options need the question they answer." };
    const labels = Array.isArray(args.options)
      ? args.options.map((label) => ({ label }))
      : args.options;
    const choices = parseChoices(labels, args.default, "", "");
    if ("error" in choices) return choices;
    questions = [{ id: "q1", question: context, ...choices }];
  }

  if (level === "consent") {
    // Silence or an ambiguous reply is not agreement: the host offers 同意 / 不同意
    // itself, with no model options and no default.
    if (questions && questions.length > 1) {
      return {
        error:
          "A consent call must be a single question: ask for one agreement at a time, in `question`.",
      };
    }
    const asked = [context, questions?.[0]?.question].filter(Boolean).join("\n\n");
    if (!asked) return { error: "wait_for_user needs the question you are asking the user." };
    if (asked.length > GOAL_MAX_QUESTION_CHARS) return tooLong;
    return { question: { text: asked, level } };
  }
  const asked = context || (questions ? goalQuestionsText(questions) : "");
  if (!asked) return { error: "wait_for_user needs the question you are asking the user." };
  return { question: { text: asked, level, ...(questions ? { questions } : {}) } };
}

/**
 * `waitingForUserDetail` of a persisted or foreign event, dropped to what is
 * well-formed. Also reads the flat `options`/`default` this field once carried.
 */
export function replayedGoalQuestionDetail(
  waitingForUser: unknown,
  detail: unknown,
): GoalQuestionDetail | undefined {
  if (!detail || typeof detail !== "object") return undefined;
  const raw = detail as Record<string, unknown>;
  const level: GoalQuestionLevel = raw.level === "consent" ? "consent" : "preference";
  const parsed = normalizeGoalQuestion({ ...raw, level, question: waitingForUser });
  const questions = "question" in parsed ? parsed.question.questions : undefined;
  return { level, ...(questions ? { questions } : {}) };
}

/** Plain-text form of the choices, for readers that cannot render them. */
export function goalQuestionsText(questions: readonly GoalUserQuestion[]): string {
  return questions
    .map((q) => {
      const options = q.options.map((option) => option.label).join(" / ");
      return `${q.header ? `${q.header}: ` : ""}${q.question} [${options}]`;
    })
    .join("; ");
}

/** The asker's own context: empty when the text only restates the questions. */
export function goalQuestionContext(
  waitingForUser: string,
  questions: readonly GoalUserQuestion[] | undefined,
): string {
  if (!questions?.length) return waitingForUser;
  if (waitingForUser === goalQuestionsText(questions)) return "";
  if (questions.length === 1 && waitingForUser === questions[0]!.question) return "";
  return waitingForUser;
}

/** Question and choices in one line, for the model and for text-only notices. */
export function goalQuestionFullText(
  waitingForUser: string,
  questions: readonly GoalUserQuestion[] | undefined,
): string {
  if (!questions?.length) return waitingForUser;
  const context = goalQuestionContext(waitingForUser, questions);
  return [context, goalQuestionsText(questions)].filter(Boolean).join(" ");
}

/** The option the asker would take: its stated default, else the first one. */
export function goalQuestionRecommended(question: GoalUserQuestion): string {
  return question.default ?? question.options[0]!.label;
}
