import { test, expect } from "bun:test";
import { renderSessionMarkdown } from "../../../packages/tui/src/cli/commands/builtin/export-md.ts";
import { marked } from "../../../packages/tui/node_modules/marked/lib/marked.esm.js";

test("R2-03 literal triple-backtick tool output escapes the exported code block", () => {
  const output = "before\n```\n# literal tool output\n```\nafter";
  const result = renderSessionMarkdown("fixture", [{ type: "message", data: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: output }] } }], "/fixture");
  const tokens = marked.lexer(result.md);
  expect(tokens.some((t: any) => t.type === "heading" && t.text === "literal tool output")).toBe(true);
  expect(tokens.filter((t: any) => t.type === "code")).toHaveLength(2);
  expect(result.sidecars).toHaveLength(0);
});

test("R2-03 simple tool output remains one fenced code block", () => {
  const result = renderSessionMarkdown("fixture", [{ type: "message", data: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "before\nafter" }] } }], "/fixture");
  const code = marked.lexer(result.md).filter((t: any) => t.type === "code");
  expect(code).toHaveLength(1);
  expect(code[0].text).toBe("before\nafter");
});
