/**
 * Built-in AskUserQuestion tool — ask the user a question during execution.
 */

import type { ToolDefinition } from "../../types.js";

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

/**
 * Factory: the actual executor is injected at runtime by the Engine,
 * because it depends on the CLI/UI layer to collect user input.
 */
export type AskUserFn = (question: string) => Promise<string>;

let _askUserFn: AskUserFn | undefined;

export function setAskUserFn(fn: AskUserFn | undefined): void {
  _askUserFn = fn;
}

export async function askUserTool(args: Record<string, unknown>): Promise<string> {
  const question = args.question as string;
  if (!question) return "Error: question is required";

  if (!_askUserFn) {
    return "Error: AskUserQuestion is not available in headless mode. Make a reasonable assumption and proceed.";
  }

  try {
    const answer = await _askUserFn(question);
    return answer || "(user provided empty response)";
  } catch (err) {
    return `Error asking user: ${(err as Error).message}`;
  }
}
