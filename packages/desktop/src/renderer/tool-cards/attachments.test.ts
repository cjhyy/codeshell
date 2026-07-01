import { describe, expect, test } from "bun:test";
import { detectAttachments, classifyPath } from "./attachments";

describe("classifyPath", () => {
  test("classifies by extension", () => {
    expect(classifyPath("/a/b.png")).toBe("image");
    expect(classifyPath("x.JPEG")).toBe("image");
    expect(classifyPath("notes.md")).toBe("markdown");
    expect(classifyPath("page.html")).toBe("html");
    expect(classifyPath("data.bin")).toBe("file");
  });
});

describe("detectAttachments", () => {
  test("extracts the PNG path from a GenerateImage result", () => {
    const result =
      "Generated image with openai (gpt-image-1), saved to /Users/me/p/.code-shell/generated_images/1718-ab12cd.png";
    const att = detectAttachments("GenerateImage", "{}", result);
    expect(att).toEqual([
      { path: "/Users/me/p/.code-shell/generated_images/1718-ab12cd.png", kind: "image" },
    ]);
  });

  test("extracts a Write file_path from args on success", () => {
    const att = detectAttachments("Write", JSON.stringify({ file_path: "/abs/notes.md" }), "wrote /abs/notes.md");
    expect(att).toEqual([{ path: "/abs/notes.md", kind: "markdown" }]);
  });

  test("skips Write when the result is an error", () => {
    const att = detectAttachments("Write", JSON.stringify({ file_path: "/abs/notes.md" }), "Error: permission denied");
    // result-scrape still won't find a path-with-ext here, so empty
    expect(att).toEqual([]);
  });

  test("dedupes the same path mentioned twice", () => {
    const result = "saved to /a/x.png then /a/x.png again";
    expect(detectAttachments("GenerateImage", "{}", result)).toEqual([
      { path: "/a/x.png", kind: "image" },
    ]);
  });

  test("ignores paths with unknown/no extension", () => {
    expect(detectAttachments("Bash", "{}", "ran the command in /tmp/workdir")).toEqual([]);
  });

  test("tolerates corrupt args JSON", () => {
    expect(detectAttachments("Write", "{not json", "saved to /a/y.png")).toEqual([
      { path: "/a/y.png", kind: "image" },
    ]);
  });

  test("strips trailing punctuation off a scraped path", () => {
    expect(detectAttachments("GenerateImage", "{}", "saved to /a/z.png.")).toEqual([
      { path: "/a/z.png", kind: "image" },
    ]);
  });

  test("ignores a bare filename scraped from prose (no directory)", () => {
    // A CronCreate result mentions `TODO.md` in a sentence. It's a bare
    // filename with no directory, so we can't know which cwd it's relative
    // to — scraping it into a clickable chip opens a wrong Finder location.
    // Only paths that carry a directory (or are absolute / ./-prefixed) are
    // trustworthy from prose.
    const result =
      '一次性任务 #4 "10分钟后复查 TODO.md 优化点" 已创建(到点续接当前对话)';
    expect(detectAttachments("CronCreate", "{}", result)).toEqual([]);
  });

  test("keeps a ./-prefixed relative path scraped from prose", () => {
    expect(detectAttachments("Bash", "{}", "wrote report to ./docs/out.md")).toEqual([
      { path: "./docs/out.md", kind: "markdown" },
    ]);
  });

  test("keeps a relative path with a directory scraped from prose", () => {
    expect(detectAttachments("Bash", "{}", "see docs/out.html for details")).toEqual([
      { path: "docs/out.html", kind: "html" },
    ]);
  });

  test("still trusts a bare filename from Write args (cwd is known)", () => {
    // Args-derived paths are trusted even when bare-relative, because the
    // card supplies the session cwd to resolve them.
    const att = detectAttachments("Write", JSON.stringify({ file_path: "TODO.md" }), "wrote TODO.md");
    expect(att).toEqual([{ path: "TODO.md", kind: "markdown" }]);
  });

  test("keeps the full path when segments contain non-ASCII (CJK) characters", () => {
    // A workspace under a Chinese path: `\w` is ASCII-only, so a naive matcher
    // resyncs at the next ASCII `/`-run and drops the `/Users/.../个人学习/代码学习/`
    // prefix — yielding a wrong, non-existent absolute path. The thumbnail then
    // can't load. The full path must survive.
    const result =
      "Generated image with openai (gpt-image-2), saved to /Users/me/个人学习/代码学习/proj/.code-shell/generated_images/1782-57adaf.png";
    expect(detectAttachments("GenerateImage", "{}", result)).toEqual([
      {
        path: "/Users/me/个人学习/代码学习/proj/.code-shell/generated_images/1782-57adaf.png",
        kind: "image",
      },
    ]);
  });
});
