/**
 * Built-in AskUserQuestion tool — ask the user a question during execution.
 *
 * The actual prompt-the-user implementation is provided per-Engine via
 * ToolContext.askUser. Headless mode (no UI wired up) leaves askUser
 * undefined and the tool reports back asking the LLM to assume.
 */

import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";

export const askUserToolDef: ToolDefinition = {
  name: "AskUserQuestion",
  description:
    "Ask the user a question and wait for their response. " +
    "Use this when you need clarification, confirmation, or additional input from the user. " +
    "In headless mode this tool will return an error.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask the user" },
    },
    required: ["question"],
  },
};

export type AskUserFn = (question: string) => Promise<string>;

export async function askUserTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const question = args.question as string;
  if (!question) return "Error: question is required";

  if (!ctx?.askUser) {
    return "Error: AskUserQuestion is not available in headless mode. Make a reasonable assumption and proceed.";
  }

  try {
    const answer = await ctx.askUser(question);
    return answer || "(user provided empty response)";
  } catch (err) {
    return `Error asking user: ${(err as Error).message}`;
  }
}
