import { describe, test, expect } from "bun:test";
import { lexer } from "marked";
import { renderSessionMarkdown } from "./export-md.js";

function exportItems(content: unknown[]): string {
  return renderSessionMarkdown(
    "fixture",
    [{ type: "message", data: { role: "user", content } }],
    "/x",
  ).md;
}

function codeBlocks(md: string): string[] {
  const out: string[] = [];
  const walk = (tokens: ReturnType<typeof lexer>): void => {
    for (const token of tokens) {
      if (token.type === "code") out.push(token.text);
      const nested = (token as { tokens?: ReturnType<typeof lexer> }).tokens;
      if (nested) walk(nested);
    }
  };
  walk(lexer(md));
  return out;
}

// Regression (audit R2-03): tool bodies were wrapped in a fixed ``` fence, so a
// tool result that itself contained a ``` line closed the export's code block
// early and its `# heading` became a heading of the exported document.
describe("renderSessionMarkdown code fences", () => {
  const body = "before\n```\n# literal tool output\n````\nafter";

  test("keeps a tool result containing backtick fences in one code block", () => {
    const md = exportItems([{ type: "tool_result", tool_use_id: "call-1", content: body }]);
    expect(lexer(md).some((t) => t.type === "heading" && t.text === "literal tool output")).toBe(
      false,
    );
    expect(codeBlocks(md)).toEqual([body]);
  });

  test("keeps reasoning containing backtick fences in one code block", () => {
    const md = exportItems([{ type: "reasoning", reasoningContent: body }]);
    expect(codeBlocks(md)).toEqual([body]);
  });

  test("keeps a truncated long tool result preview in one code block", () => {
    const long = `${body}\n${"x".repeat(3_000)}`;
    const rendered = renderSessionMarkdown(
      "fixture",
      [
        {
          type: "message",
          data: { role: "user", content: [{ type: "tool_result", content: long }] },
        },
      ],
      "/x",
    );
    const blocks = codeBlocks(rendered.md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.startsWith(body)).toBe(true);
    expect(rendered.sidecars[0]!.content).toBe(long);
  });

  test("still uses a plain triple-backtick fence for ordinary output", () => {
    const md = exportItems([{ type: "tool_result", tool_use_id: "call-1", content: "a\nb" }]);
    expect(md).toContain("```\na\nb\n```");
    expect(codeBlocks(md)).toEqual(["a\nb"]);
  });
});
