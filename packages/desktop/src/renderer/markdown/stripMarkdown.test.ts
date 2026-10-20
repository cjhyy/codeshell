import { expect, test, describe } from "bun:test";
import { stripMarkdownToPlain } from "./stripMarkdown";

describe("stripMarkdownToPlain", () => {
  test("strips prose emphasis, links and headings", () => {
    expect(stripMarkdownToPlain("# Title\n\n**bold** and _italic_ [doc](https://x.dev)")).toBe(
      "Title\n\nbold and italic doc (https://x.dev)",
    );
  });

  // Regression (audit R2-05): fence bodies were exposed to the emphasis and
  // heading passes, so copied code lost `__` and `*` characters.
  test("keeps fenced code bodies verbatim and only drops the fences", () => {
    const body =
      'if __name__ == "__main__":\n    result = a*b*c\n\n\n\n    print("*literal*")\n# not a heading\n- not a list';
    expect(stripMarkdownToPlain("Run this:\n\n```python\n" + body + "\n```\n\nDone **now**.")).toBe(
      `Run this:\n\n${body}\n\nDone now.`,
    );
  });

  test("keeps inline code content verbatim", () => {
    expect(stripMarkdownToPlain("Call `__init__` with `a*b*c` *now*")).toBe(
      "Call __init__ with a*b*c now",
    );
  });
});
