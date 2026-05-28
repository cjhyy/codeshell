import { describe, expect, it } from "bun:test";
import {
  classifyPath,
  detectAttachments,
} from "../packages/desktop/src/renderer/tool-cards/attachments";

describe("classifyPath", () => {
  it("recognises image extensions", () => {
    expect(classifyPath("/x/y.png")).toBe("image");
    expect(classifyPath("foo.JPG")).toBe("image");
    expect(classifyPath("a/b/c.webp")).toBe("image");
    expect(classifyPath("d.svg")).toBe("image");
  });
  it("recognises markdown / html", () => {
    expect(classifyPath("README.md")).toBe("markdown");
    expect(classifyPath("notes.mdx")).toBe("markdown");
    expect(classifyPath("index.html")).toBe("html");
    expect(classifyPath("about.HTM")).toBe("html");
  });
  it("falls back to 'file' for unknown extensions", () => {
    expect(classifyPath("script.ts")).toBe("file");
    expect(classifyPath("no-ext")).toBe("file");
  });
});

describe("detectAttachments", () => {
  it("extracts the path GenerateImage saved to", () => {
    const result = "Generated image saved to /Users/me/proj/.code-shell/generated_images/123.png";
    const a = detectAttachments("GenerateImage", undefined, result);
    expect(a).toHaveLength(1);
    expect(a[0]!.kind).toBe("image");
    expect(a[0]!.path).toBe(
      "/Users/me/proj/.code-shell/generated_images/123.png",
    );
  });

  it("picks up a Write tool's file_path arg on success", () => {
    const args = JSON.stringify({ file_path: "/abs/output.html", content: "<p>x</p>" });
    const a = detectAttachments("Write", args, "wrote /abs/output.html");
    expect(a).toHaveLength(1);
    expect(a[0]!.path).toBe("/abs/output.html");
    expect(a[0]!.kind).toBe("html");
  });

  it("skips Write when the result starts with 'error'", () => {
    const args = JSON.stringify({ file_path: "/abs/output.md", content: "x" });
    const a = detectAttachments("Write", args, "Error: cannot write — read-only fs");
    expect(a).toHaveLength(0);
  });

  it("dedupes when the path appears in both args and result", () => {
    const args = JSON.stringify({ file_path: "/p/notes.md", content: "x" });
    const a = detectAttachments("Write", args, "wrote /p/notes.md");
    expect(a).toHaveLength(1);
  });

  it("ignores non-artifact extensions", () => {
    const a = detectAttachments(
      "Bash",
      undefined,
      "running script.ts and main.py in /tmp",
    );
    expect(a).toHaveLength(0);
  });

  it("returns multiple distinct artifacts", () => {
    const out = "wrote /a/x.md and /a/y.png and /a/z.html";
    const a = detectAttachments("Bash", undefined, out);
    expect(a.map((x) => x.kind)).toEqual(["markdown", "image", "html"]);
  });
});
