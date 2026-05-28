import { describe, expect, it } from "bun:test";
import { stripMarkdownToPlain } from "../packages/desktop/src/renderer/markdown/stripMarkdown";

describe("stripMarkdownToPlain", () => {
  it("strips headings, bold, italic, inline code", () => {
    const input = "# Title\n\nThis is **bold** and *italic* and `code`.";
    expect(stripMarkdownToPlain(input)).toBe(
      "Title\n\nThis is bold and italic and code.",
    );
  });

  it("keeps the body of fenced code blocks but drops the fences", () => {
    const input = "before\n```ts\nconst x = 1;\n```\nafter";
    expect(stripMarkdownToPlain(input)).toBe("before\nconst x = 1;\nafter");
  });

  it("renders [label](url) as label (url) when they differ", () => {
    expect(stripMarkdownToPlain("see [docs](https://x.com)")).toBe(
      "see docs (https://x.com)",
    );
  });

  it("renders [url](url) as just url", () => {
    expect(stripMarkdownToPlain("see [https://x](https://x)")).toBe(
      "see https://x",
    );
  });

  it("keeps the alt text of images", () => {
    expect(stripMarkdownToPlain("![diagram](/img/x.png)")).toBe("diagram");
  });

  it("turns unordered list markers into bullets", () => {
    const input = "- one\n- two\n* three";
    expect(stripMarkdownToPlain(input)).toBe("• one\n• two\n• three");
  });

  it("drops blockquotes and horizontal rules", () => {
    const input = "> quoted\n\n---\n\nbody";
    expect(stripMarkdownToPlain(input)).toBe("quoted\n\nbody");
  });

  it("collapses excessive blank lines", () => {
    const input = "a\n\n\n\nb";
    expect(stripMarkdownToPlain(input)).toBe("a\n\nb");
  });

  it("strikethrough markers are removed", () => {
    expect(stripMarkdownToPlain("a ~~done~~ thing")).toBe("a done thing");
  });
});
