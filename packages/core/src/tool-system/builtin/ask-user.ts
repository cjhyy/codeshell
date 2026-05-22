/**
 * Built-in AskUserQuestion tool — ask the user a question during execution.
 *
 * Two modes:
 *   - Plain text (no `options`): user types a free-text answer.
 *   - Multiple choice (`options` provided): user picks from a list. An
 *     implicit "Other..." entry is appended by the UI for free text.
 *
 * The actual prompt-the-user implementation is provided per-Engine via
 * ToolContext.askUser. Headless mode (no UI wired up) leaves askUser
 * undefined and the tool reports back asking the LLM to assume.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext, AskUserOptions } from "../context.js";

// Re-export AskUserFn from its canonical home in tool-system/context.ts so
// existing imports of `AskUserFn` from this module keep working. Type-only.
export type { AskUserFn, AskUserOptions, AskUserChoice } from "../context.js";

export const askUserToolDef: ToolDefinition = {
  name: "AskUserQuestion",
  description:
    "Ask the user a question and wait for their response. " +
    "Use this when you need clarification, confirmation, or additional input from the user. " +
    "Pass `options` to present a multiple-choice list (recommended when the answer is one of a small known set — much better UX than free text). " +
    "Each option needs a short `label` (the choice the user sees) and a `description` (what it means). " +
    "Lead with the recommended option and append a recommendation marker to its label in the same language as the question (e.g. '(Recommended)' for an English question, '(推荐)' for a Chinese question). " +
    "Set `multiSelect: true` when more than one choice can apply. " +
    "ALWAYS write the `question`, every option `label`, every option `description`, and the `header` in the SAME LANGUAGE the user has been writing in. If the user wrote to you in Chinese, write all of these fields in Chinese; if Japanese, in Japanese; etc. The framework's UI chrome (separator hints, the implicit 'Other...' entry) is fixed — only your fields need to match the user's language. " +
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
