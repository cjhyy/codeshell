import { describe, expect, test } from "bun:test";
import type { ContentBlock } from "../types.js";
import { estimateStringTokens } from "./token-counter.js";
import {
  createToolTextReplacement,
  replaceToolResultText,
  toolResultText,
  TOOL_OUTPUT_TRUNCATED,
  truncateToolOutput,
} from "./tool-output-budget.js";

describe("tool output text budgets", () => {
  test("a CJK heuristic boundary cannot report truncation while retaining all input", () => {
    const text = "中中中aaaaaaa".repeat(2899) + "中".repeat(8) + "aa";
    expect(estimateStringTokens(text)).toBeGreaterThan(10_000);
    const result = truncateToolOutput(text, { maxChars: 30_000, maxTokens: 10_000 });
    expect(result.length).toBeLessThan(text.length);
    expect(result.replace(`\n${TOOL_OUTPUT_TRUNCATED}\n`, "")).not.toBe(text);
    expect(result).toContain(TOOL_OUTPUT_TRUNCATED);
    expect(estimateStringTokens(result)).toBeLessThanOrEqual(10_000);
    expect(truncateToolOutput(text, { maxChars: 30_000, maxTokens: 10_000 })).toBe(result);
  });

  test("a string result needs no positional replacement metadata", () => {
    expect(createToolTextReplacement("short output", { maxChars: 100 })).toEqual({
      text: "short output",
    });
    expect(replaceToolResultText("original", "replacement")).toBe("replacement");
  });

  test("head/tail truncation retains diagnostics without splitting Unicode characters", () => {
    const text = "START\n" + "🙂中文🚀".repeat(300) + "\nERROR: build exited 17";
    const result = truncateToolOutput(text, { maxChars: 173, maxTokens: 80 });
    expect(result).toStartWith("START\n");
    expect(result).toEndWith("ERROR: build exited 17");
    expect(result.length).toBeLessThanOrEqual(173);
    expect(estimateStringTokens(result)).toBeLessThanOrEqual(80);
    expect(
      Array.from(result).some((char) => char.length === 1 && /[\uD800-\uDFFF]/.test(char)),
    ).toBe(false);
  });

  test("tiny budgets shrink rather than adding an oversized notice", () => {
    expect(truncateToolOutput("short output", { maxChars: 3 })).toBe("");
    expect(truncateToolOutput("x".repeat(100), { maxChars: 100, maxTokens: 1 })).toBe("");
  });

  test("media and every text slot retain order, identity and their own head/tail", () => {
    const imageA: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "A" },
    };
    const imageB: ContentBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "B" },
    };
    const first = "FIRST HEAD\n" + "a".repeat(3000) + "\nFIRST TAIL";
    const second = "SECOND HEAD\n" + "中".repeat(3000) + "\nSECOND ERROR TAIL";
    const content: ContentBlock[] = [
      imageA,
      { type: "text", text: first },
      imageB,
      { type: "text", text: second },
    ];
    const original = structuredClone(content);
    for (const part of content) Object.freeze(part);
    Object.freeze(content);
    const replacement = createToolTextReplacement(content, { maxChars: 1000, maxTokens: 350 });
    const out = replaceToolResultText(
      content,
      replacement.text,
      replacement.parts,
    ) as ContentBlock[];
    expect(out.map((part) => part.type)).toEqual(["image", "text", "image", "text"]);
    expect(out[0]).toBe(imageA);
    expect(out[2]).toBe(imageB);
    expect(out[1].text).toStartWith("FIRST HEAD\n");
    expect(out[1].text).toEndWith("FIRST TAIL");
    expect(out[3].text).toStartWith("SECOND HEAD\n");
    expect(out[3].text).toEndWith("SECOND ERROR TAIL");
    expect(out[1].text).toContain(TOOL_OUTPUT_TRUNCATED);
    expect(out[3].text).toContain(TOOL_OUTPUT_TRUNCATED);
    expect(replacement.parts).toHaveLength(2);
    expect(replacement.text).toBe(replacement.parts!.join("\n\n"));
    expect(toolResultText(out)).toBe(replacement.text);
    expect(replacement.text.length).toBeLessThanOrEqual(1000);
    expect(estimateStringTokens(replacement.text)).toBeLessThanOrEqual(350);
    expect(content).toEqual(original);
    expect(createToolTextReplacement(out, { maxChars: 1000, maxTokens: 350 })).toEqual(replacement);
  });

  test("short slots stay intact while large slots share the remaining budget", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "short caption" },
      { type: "text", text: "LARGE ONE\n" + "a".repeat(3000) + "\nEND ONE" },
      { type: "text", text: "LARGE TWO\n" + "b".repeat(3000) + "\nEND TWO" },
    ];
    const replacement = createToolTextReplacement(content, { maxChars: 700, maxTokens: 200 });
    expect(replacement.parts![0]).toBe("short caption");
    expect(replacement.parts![1]).toContain("END ONE");
    expect(replacement.parts![2]).toContain("END TWO");
    expect(replacement.text.length).toBeLessThanOrEqual(700);
    expect(estimateStringTokens(replacement.text)).toBeLessThanOrEqual(200);
  });

  test("legacy scalar replacements cannot collapse multiple text slots", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "before image" },
      { type: "image" },
      { type: "text", text: "after image" },
    ];
    expect(replaceToolResultText(content, "ambiguous combined replacement")).toBe(content);
    expect(replaceToolResultText(content, "bad slot count", ["only one"])).toBe(content);
    expect(replaceToolResultText([{ type: "text", text: "old" }], "new")).toEqual([
      { type: "text", text: "new" },
    ]);
  });

  test("untouched slots and media-only results preserve their blocks", () => {
    const content: ContentBlock[] = [{ type: "image" }, { type: "text", text: "caption" }];
    const replacement = createToolTextReplacement(content, { maxChars: 100 });
    const out = replaceToolResultText(
      content,
      replacement.text,
      replacement.parts,
    ) as ContentBlock[];
    expect(out[0]).toBe(content[0]);
    expect(out[1]).toBe(content[1]);
    expect(createToolTextReplacement([{ type: "image" }], { maxChars: 100 })).toEqual({
      text: "",
      parts: [],
    });
  });
});
