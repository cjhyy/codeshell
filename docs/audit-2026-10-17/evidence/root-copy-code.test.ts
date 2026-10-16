import { test, expect } from "bun:test";
import { stripMarkdownToPlain } from "../../../packages/desktop/src/renderer/markdown/stripMarkdown.ts";

test("R2-05 copy-as-plain-text modifies fenced Python code after stripping its fence", () => {
  const body = 'if __name__ == "__main__":\n    result = a*b*c\n    print("*literal*")';
  const actual = stripMarkdownToPlain("```python\n" + body + "\n```");
  expect(actual).not.toBe(body);
  expect(actual).toContain('if name == "main":');
  expect(actual).toContain("result = abc");
  expect(actual).toContain('print("literal")');
});

test("R2-05 prose emphasis conversion and simple fenced code are normal controls", () => {
  expect(stripMarkdownToPlain("**bold** and _italic_")).toBe("bold and italic");
  expect(stripMarkdownToPlain("```python\nprint(1)\n```")).toBe("print(1)");
});
