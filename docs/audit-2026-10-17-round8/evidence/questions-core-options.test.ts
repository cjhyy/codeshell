import { expect, test } from "bun:test";
import { askUserTool, askUserAsyncTool } from "../../../packages/core/src/tool-system/builtin/ask-user.ts";
import type { AskUserOptions, ToolContext } from "../../../packages/core/src/tool-system/context.ts";

const options = [
  { label: "Core", description: "Engine implementation" },
  { label: "Web", description: "Browser client" },
];

test("sync choice question forwards ordinary rendering metadata and returns the user's label list", async () => {
  const calls: unknown[] = [];
  const context = { askUser: async (question: string, opts?: AskUserOptions) => {
    calls.push({ question, opts });
    return "Core, Web";
  }} as ToolContext;
  expect(await askUserTool({ question: "Which modules?", header: "Modules", options, multiSelect: true }, context)).toBe("Core, Web");
  expect(calls).toEqual([{ question: "Which modules?", opts: { header: "Modules", options, multiSelect: true } }]);
});

test("free text forwards no options and preserves an ordinary answer verbatim", async () => {
  const calls: unknown[] = [];
  const context = { askUser: async (question: string, opts?: AskUserOptions) => {
    calls.push({ question, opts });
    return "Review the reducer first";
  }} as ToolContext;
  expect(await askUserTool({ question: "What should be reviewed?" }, context)).toBe("Review the reducer first");
  expect(calls).toEqual([{ question: "What should be reviewed?", opts: undefined }]);
});

test("async question returns the host delivery receipt and preserves the same option metadata", async () => {
  const calls: unknown[] = [];
  const context = { askUserAsync: async (question: string, opts?: AskUserOptions) => {
    calls.push({ question, opts });
    return "Question displayed; no answer received";
  }} as ToolContext;
  expect(await askUserAsyncTool({ question: "Which modules?", header: "Modules", options, multiSelect: true }, context)).toBe("Question displayed; no answer received");
  expect(calls).toEqual([{ question: "Which modules?", opts: { header: "Modules", options, multiSelect: true } }]);
});

test("async question without an async host does not silently invoke the blocking handler", async () => {
  let calls = 0;
  const context = { askUser: async () => { calls++; return "Core"; }} as ToolContext;
  expect(await askUserAsyncTool({ question: "Which module?", options }, context)).toContain("No question was displayed");
  expect(calls).toBe(0);
});
