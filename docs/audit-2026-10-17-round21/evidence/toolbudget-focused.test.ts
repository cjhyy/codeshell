import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/types.ts";
import { estimateStringTokens } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/context/token-counter.ts";
import {
  createToolTextReplacement,
  exceedsToolOutputBudget,
  replaceToolResultText,
  toolResultText,
  TOOL_OUTPUT_TRUNCATED,
  truncateToolOutput,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/context/tool-output-budget.ts";

describe("round21 actual tool-output-budget leaf controls", () => {
  test("text extraction joins only valid text slots in their original order", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "first" },
      { type: "image" },
      { type: "reasoning", text: "not text output" },
      { type: "text" },
      { type: "text", text: "last" },
    ];
    expect(toolResultText(content)).toBe("first\n\nlast");
    expect(toolResultText("scalar")).toBe("scalar");
    expect(toolResultText(undefined)).toBeUndefined();
    expect(toolResultText([{ type: "image" }])).toBeUndefined();
  });

  test("empty text slots participate in positional metadata and separators", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "" },
      { type: "image" },
      { type: "text", text: "last" },
      { type: "text", text: "" },
    ];
    const replacement = createToolTextReplacement(content, { maxChars: 8, maxTokens: 2 });
    expect(replacement).toEqual({ text: "\n\nlast\n\n", parts: ["", "last", ""] });
    expect(exceedsToolOutputBudget(replacement.text, { maxChars: 8, maxTokens: 2 })).toBe(false);
    expect(replaceToolResultText(content, replacement.text, replacement.parts)).toEqual(content);
  });

  test("the exact char and heuristic token limits are inclusive", () => {
    expect(estimateStringTokens("abcd")).toBe(1);
    expect(exceedsToolOutputBudget("abcd", { maxChars: 4, maxTokens: 1 })).toBe(false);
    expect(truncateToolOutput("abcd", { maxChars: 4, maxTokens: 1 })).toBe("abcd");
    expect(exceedsToolOutputBudget("abcde", { maxChars: 5, maxTokens: 1 })).toBe(true);
    expect(truncateToolOutput("abcde", { maxChars: 5, maxTokens: 1 })).toBe("");
  });

  test("a small positive char allowance does not add an oversized notice", () => {
    expect(truncateToolOutput("owned short output", { maxChars: 4 })).toBe("");
    expect(createToolTextReplacement("owned short output", { maxChars: 4 })).toEqual({ text: "" });
    expect(exceedsToolOutputBudget("", { maxChars: 4 })).toBe(false);
  });

  test("small scalar head-tail output fits the actual joined budget and is deterministic", () => {
    const text = "HEAD\n" + "a".repeat(150) + "\nTAIL";
    const budget = { maxChars: 80, maxTokens: 20 };
    const replacement = createToolTextReplacement(text, budget);
    expect(replacement.text).toStartWith("HEAD");
    expect(replacement.text).toEndWith("TAIL");
    expect(replacement.text).toContain(TOOL_OUTPUT_TRUNCATED);
    expect(exceedsToolOutputBudget(replacement.text, budget)).toBe(false);
    expect(createToolTextReplacement(text, budget)).toEqual(replacement);
  });

  test("short positional slots survive while long owned ASCII slots share allowance", () => {
    const image: ContentBlock = { type: "image" };
    const content: ContentBlock[] = [
      { type: "text", text: "OK" },
      image,
      { type: "text", text: "FIRST\n" + "a".repeat(350) + "\nEND FIRST" },
      { type: "text", text: "SECOND\n" + "b".repeat(350) + "\nEND SECOND" },
    ];
    const original = structuredClone(content);
    for (const part of content) Object.freeze(part);
    Object.freeze(content);
    const budget = { maxChars: 260, maxTokens: 75 };
    const replacement = createToolTextReplacement(content, budget);
    const out = replaceToolResultText(content, replacement.text, replacement.parts) as ContentBlock[];
    expect(replacement.parts?.[0]).toBe("OK");
    expect(replacement.parts?.[1]).toContain("END FIRST");
    expect(replacement.parts?.[2]).toContain("END SECOND");
    expect(out[1]).toBe(image);
    expect(out[0]).toBe(content[0]);
    expect(toolResultText(out)).toBe(replacement.text);
    expect(exceedsToolOutputBudget(replacement.text, budget)).toBe(false);
    expect(content).toEqual(original);
  });

  test("explicit replacement metadata cannot reorder or remove nontext blocks", () => {
    const image: ContentBlock = { type: "image" };
    const reasoning: ContentBlock = { type: "reasoning", text: "owned metadata" };
    const content: ContentBlock[] = [
      { type: "text", text: "before" }, image, reasoning, { type: "text", text: "after" },
    ];
    const out = replaceToolResultText(content, "new before\n\nnew after", ["new before", "new after"]) as ContentBlock[];
    expect(out.map((part) => part.type)).toEqual(["text", "image", "reasoning", "text"]);
    expect(out[1]).toBe(image);
    expect(out[2]).toBe(reasoning);
    expect(toolResultText(out)).toBe("new before\n\nnew after");
    expect(toolResultText(content)).toBe("before\n\nafter");
  });

  test("under-budget arrays retain each original text and media block identity", () => {
    const content: ContentBlock[] = [{ type: "image" }, { type: "text", text: "owned caption" }];
    const replacement = createToolTextReplacement(content, { maxChars: 100, maxTokens: 30 });
    const out = replaceToolResultText(content, replacement.text, replacement.parts) as ContentBlock[];
    expect(replacement.parts).toEqual(["owned caption"]);
    expect(out[0]).toBe(content[0]);
    expect(out[1]).toBe(content[1]);
    expect(replaceToolResultText(content, "ambiguous", [])).toBe(content);
  });

  test("301 small slots can shrink to the exact real backstop char cap", () => {
    const content: ContentBlock[] = Array.from({ length: 301 }, () => ({ type: "text", text: "x" }));
    const budget = { maxChars: 600, maxTokens: 200 };
    const replacement = createToolTextReplacement(content, budget);
    expect(toolResultText(content)?.length).toBe(901);
    expect(replacement.parts).toHaveLength(301);
    expect(replacement.parts?.every((part) => part === "")).toBe(true);
    expect(replacement.text.length).toBe(600);
    expect(estimateStringTokens(replacement.text)).toBe(150);
    expect(exceedsToolOutputBudget(replacement.text, budget)).toBe(false);
  });

  test("old budget-floor concern: 302 handcrafted slots retain 602 separators under the real 600 char backstop", () => {
    const content: ContentBlock[] = Array.from({ length: 302 }, () => ({ type: "text", text: "x" }));
    const budget = { maxChars: 600, maxTokens: 200 };
    const replacement = createToolTextReplacement(content, budget);
    const out = replaceToolResultText(content, replacement.text, replacement.parts) as ContentBlock[];
    expect(toolResultText(content)?.length).toBe(904);
    expect(replacement.parts).toHaveLength(302);
    expect(replacement.parts?.every((part) => part === "")).toBe(true);
    expect(replacement.text.length).toBe(602);
    expect(estimateStringTokens(replacement.text)).toBe(151);
    expect(exceedsToolOutputBudget(replacement.text, budget)).toBe(true);
    expect(toolResultText(out)).toBe(replacement.text);
    expect(out).toHaveLength(302);
    expect(content.every((part) => part.text === "x")).toBe(true);
  });
});
