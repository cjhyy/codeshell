import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildInputAttachmentContext } from "../../../packages/core/src/engine/input-attachments.ts";
import type { InputAttachmentMeta } from "../../../packages/core/src/types.ts";
import { detectAttachments } from "../../../packages/desktop/src/renderer/tool-cards/attachments.ts";

const temporaryRoots: string[] = [];
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-attachments-audit-r9-")));
  temporaryRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ordinary artifact path projection", () => {
  test("a generated-image result under a spaced workspace becomes a nonexistent relative card path", () => {
    const cwd = join(workspace(), "project with spaces");
    const imagePath = join(cwd, ".code-shell", "generated_images", "1782-audit.png");
    mkdirSync(dirname(imagePath), { recursive: true });
    writeFileSync(imagePath, "synthetic artifact bytes; no image decoder is invoked");
    // Production generate-image.ts:496 interpolates its full joined path in this format.
    // This test runs only the ordinary renderer detector, never the generator/provider.
    const result = `Generated image with openai (fixture-model), saved to ${imagePath}`;
    const cards = detectAttachments("GenerateImage", "{}", result);
    expect(existsSync(imagePath)).toBe(true);
    expect(cards).toEqual([
      { path: "spaces/.code-shell/generated_images/1782-audit.png", kind: "image" },
    ]);
    expect(cards.some((card) => card.path === imagePath)).toBe(false);
    expect(resolve(cwd, cards[0]!.path)).not.toBe(imagePath);
    expect(existsSync(resolve(cwd, cards[0]!.path))).toBe(false);
  });

  test("a known artifact filename containing a space disappears from result scraping", () => {
    expect(
      detectAttachments("mcpToolCall", "{}", "saved to /fixture/project/final report.png"),
    ).toEqual([]);
    expect(
      detectAttachments("mcpToolCall", "{}", "saved to /fixture/project/final-report.png"),
    ).toEqual([{ path: "/fixture/project/final-report.png", kind: "image" }]);
  });

  test("ordinary complete CJK paths and structured args with spaces retain the full path", () => {
    const cjkPath = "/fixture/个人学习/项目/output.png";
    expect(detectAttachments("GenerateImage", "{}", `saved to ${cjkPath}`)).toEqual([
      { path: cjkPath, kind: "image" },
    ]);
    const spacedPath = "/fixture/project with spaces/final report.png";
    expect(
      detectAttachments("Write", JSON.stringify({ file_path: spacedPath }), "File written successfully"),
    ).toEqual([{ path: spacedPath, kind: "image" }]);
    expect(detectAttachments("mcpToolCall", "{}", "a report.png is mentioned")).toEqual([]);
  });
});

describe("ordinary core attachment metadata controls", () => {
  test("regular file metadata uses the real byte count without injecting the file body", async () => {
    const cwd = workspace();
    const bytes = Buffer.from("ordinary fixture text\n", "utf8");
    const path = "notes.txt";
    const absPath = join(cwd, path);
    writeFileSync(absPath, bytes);
    const meta: InputAttachmentMeta = {
      id: "fixture-note", sessionId: "fixture-session", kind: "file", origin: "mention",
      path, absPath, relPath: path, mime: "text/plain", size: 0,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      originalName: "notes.txt", createdAt: 1,
    };
    const context = await buildInputAttachmentContext([meta], cwd, {
      expectedSessionId: "fixture-session",
    });
    expect(context.errors).toEqual([]);
    expect(context.images).toEqual([]);
    expect(context.hasStructuredImageAttachments).toBe(false);
    expect(context.text).toContain('path="notes.txt"');
    expect(context.text).toContain(`size: ${bytes.length}`);
    expect(context.text).toContain(`absolutePath: ${absPath}`);
    expect(context.text).not.toContain(bytes.toString("utf8"));
  });

  test("directory metadata describes ordinary children and keeps the documented noisy directories out", async () => {
    const cwd = workspace();
    const selected = join(cwd, "selected");
    mkdirSync(join(selected, "nested"), { recursive: true });
    mkdirSync(join(selected, "node_modules"), { recursive: true });
    mkdirSync(join(selected, ".git"), { recursive: true });
    writeFileSync(join(selected, "notes.txt"), "notes");
    writeFileSync(join(selected, "nested", "inside.txt"), "inside");
    writeFileSync(join(selected, "node_modules", "ignored.txt"), "dependency");
    const meta: InputAttachmentMeta = {
      id: "fixture-directory", sessionId: "fixture-session", kind: "directory", origin: "mention",
      path: "selected", absPath: selected, relPath: "selected", size: 0, sha256: "",
      originalName: "selected", createdAt: 1,
    };
    const context = await buildInputAttachmentContext([meta], cwd, {
      expectedSessionId: "fixture-session",
    });
    expect(context.errors).toEqual([]);
    expect(context.images).toEqual([]);
    expect(context.text).toContain('entries="3" truncated="false"');
    expect(context.text).toContain("file selected/notes.txt");
    expect(context.text).toContain("file selected/nested/inside.txt");
    expect(context.text).not.toContain("node_modules");
    expect(context.text).not.toContain(".git");
  });
});
