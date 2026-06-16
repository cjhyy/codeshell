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
});
