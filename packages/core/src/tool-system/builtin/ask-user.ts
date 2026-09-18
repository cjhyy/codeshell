/**
 * Built-in question tools — ask the user during execution, either waiting
 * for an answer or allowing the user to answer later.
 *
 * Two modes:
 *   - Plain text (no `options`): user types a free-text answer.
 *   - Multiple choice (`options` provided): user picks from a list. An
 *     implicit "Other..." entry is appended by the UI for free text.
 *
 * The actual prompt-the-user implementation is provided per-Engine via
 * ToolContext.askUser / askUserAsync. Unsupported hosts leave the relevant
 * handler undefined; asynchronous questions never fall back to blocking.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext, AskUserOptions } from "../context.js";

// Re-export AskUserFn from its canonical home in tool-system/context.ts so
// existing imports of `AskUserFn` from this module keep working. Type-only.
export type { AskUserFn, AskUserAsyncFn, AskUserOptions, AskUserChoice } from "../context.js";

const questionPresentationDescription =
  "Pass `options` to present a multiple-choice list (recommended when the answer is one of a small known set — much better UX than free text). " +
  "Each option needs a short `label` (the choice the user sees) and a `description` (what it means). " +
  "Lead with the recommended option and append a recommendation marker to its label in the same language as the question (e.g. '(Recommended)' for an English question, '(推荐)' for a Chinese question). " +
  "Set `multiSelect: true` when more than one choice can apply. " +
  "ALWAYS write the `question`, every option `label`, every option `description`, and the `header` in the SAME LANGUAGE the user has been writing in. If the user wrote to you in Chinese, write all of these fields in Chinese; if Japanese, in Japanese; etc. The framework's UI chrome (separator hints, the implicit 'Other...' entry) is fixed — only your fields need to match the user's language. ";

export const askUserToolDef: ToolDefinition = {
  name: "AskUserQuestion",
  description:
    "Ask the user a question and wait for their response. " +
    "Use this when you need clarification, confirmation, or additional input from the user. " +
    questionPresentationDescription +
    "In headless mode this tool will return an error.",
  inputSchema: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question to ask the user — in the user's language",
      },
      header: {
        type: "string",
        description:
          "Optional short label (≤12 chars) shown as a chip above the question (e.g. 'Language', 'Approach', '语言', '方案'). Use the user's language.",
      },
      options: {
        type: "array",
        description:
          "Optional 2-4 multiple-choice options. Omit for free-text input. An implicit 'Other...' entry is appended automatically by the framework.",
        items: {
          type: "object",
          properties: {
            label: {
              type: "string",
              description: "Short display text (1-5 words) — in the user's language",
            },
            description: {
              type: "string",
              description:
                "What this option means or implies — shown next to the label, in the user's language",
            },
          },
          required: ["label", "description"],
        },
      },
      multiSelect: {
        type: "boolean",
        description:
          "If true, the user can select multiple options. Defaults to false (single choice).",
      },
    },
    required: ["question"],
  },
};

export const askUserAsyncToolDef: ToolDefinition = {
  name: "AskUserQuestionAsync",
  description:
    "Display a question the user can answer later, and return immediately after it is displayed. " +
    "Use this for optional clarification or preferences while you continue useful work that does not depend on the answer. " +
    "The result is a delivery receipt, not an answer. A later answer arrives as a new user message in this session. " +
    "Do not repeat a pending question or treat an unanswered question, elapsed time, or dismissal as agreement or permission. " +
    "For a required answer or permission decision, use AskUserQuestion and wait before doing the dependent work. " +
    questionPresentationDescription +
    "If the host does not support asynchronous questions, this tool returns an error.",
  inputSchema: askUserToolDef.inputSchema,
};

/**
 * Tool execution. Forwards to ToolContext.askUser.
 */
export async function askUserTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const question = args.question as string;
  if (!question) return "Error: question is required";

  if (!ctx?.askUser) {
    return "Error: AskUserQuestion is not available in headless mode. Make a reasonable assumption and proceed.";
  }

  const opts: AskUserOptions | undefined = parseOptions(args);

  try {
    const answer = await ctx.askUser(question, opts);
    return answer || "(user provided empty response)";
  } catch (err) {
    return `Error asking user: ${(err as Error).message}`;
  }
}

/** Return the host's delivery receipt without waiting for a later answer. */
export async function askUserAsyncTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const question = args.question;
  if (typeof question !== "string" || !question.trim()) return "Error: question is required";

  if (!ctx?.askUserAsync) {
    return "Error: AskUserQuestionAsync is not available in this host. No question was displayed. Continue independent work, or use AskUserQuestion if you need to wait for an answer.";
  }

  try {
    const receipt = await ctx.askUserAsync(question, parseOptions(args));
    return receipt || "Question displayed. The user may answer later; no answer has been received.";
  } catch (err) {
    return `Error displaying question: ${(err as Error).message}`;
  }
}

function parseOptions(args: Record<string, unknown>): AskUserOptions | undefined {
  const rawOptions = args.options;
  const header = typeof args.header === "string" ? args.header : undefined;
  const multiSelect = args.multiSelect === true;

  if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
    if (header === undefined && !multiSelect) return undefined;
    return { header, multiSelect, options: undefined };
  }

  const options = rawOptions
    .filter((o): o is { label: string; description: string } => {
      return (
        typeof o === "object" &&
        o !== null &&
        typeof (o as { label?: unknown }).label === "string" &&
        typeof (o as { description?: unknown }).description === "string"
      );
    })
    .map((o) => ({ label: o.label, description: o.description }));

  if (options.length === 0) return { header, multiSelect, options: undefined };
  return { header, multiSelect, options };
}
