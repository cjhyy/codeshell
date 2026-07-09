import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewImageTool } from "./view-image.js";
import type { ToolContext } from "../context.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ctxWith(model: string, providerKind: string, cwd: string): ToolContext {
  return {
    cwd,
    llmConfig: { provider: providerKind, model, providerKind },
  } as unknown as ToolContext;
}

describe("view_image", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "view-image-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an image content block for a PNG under a vision model", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool({ path: p }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("object");
    const blocks = (out as { contentBlocks: any[] }).contentBlocks;
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].source.media_type).toBe("image/png");
    expect(blocks[0].source.data).toBe(PNG_B64);
  });

  it("skips reading (returns text) when model has no vision", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool({ path: p }, ctxWith("deepseek-chat", "deepseek", dir));
    expect(typeof out).toBe("string");
    expect(out as string).toContain("不支持视觉");
  });

  it("fails closed (no image) when ctx.llmConfig is absent", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    // Missing llmConfig must NOT fall open and leak base64 into context;
    // treat as non-vision (DEFAULT_CAPABILITY.supportsVision === false).
    const out = await viewImageTool({ path: p }, { cwd: dir } as unknown as ToolContext);
    expect(typeof out).toBe("string");
    expect(out as string).toContain("不支持视觉");
  });

  it("loads the image for a vision OpenAI model (gpt-4o)", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool({ path: p }, ctxWith("gpt-4o", "openai", dir));
    expect(typeof out).toBe("object");
    expect((out as { contentBlocks: any[] }).contentBlocks[0].type).toBe("image");
  });

  it("accepts an optional detail parameter", async () => {
    const p = join(dir, "a.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool(
      { path: p, detail: "low" },
      ctxWith("claude-sonnet-4-6", "anthropic", dir),
    );
    expect(typeof out).toBe("object");
    expect((out as { contentBlocks: any[] }).contentBlocks[0].type).toBe("image");
  });

  it("rejects invalid detail values", async () => {
    const out = await viewImageTool(
      { path: "a.png", detail: "original" },
      ctxWith("claude-sonnet-4-6", "anthropic", dir),
    );
    expect(out).toBe("Error: detail must be one of low, standard, high");
  });

  it("rejects unsupported formats (svg) with text", async () => {
    const p = join(dir, "a.svg");
    await writeFile(p, "<svg/>");
    const out = await viewImageTool({ path: p }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("string");
    expect(out as string).toContain("不支持视觉预览");
  });

  it("resolves relative paths against ctx.cwd", async () => {
    const p = join(dir, "rel.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool(
      { path: "rel.png" },
      ctxWith("claude-sonnet-4-6", "anthropic", dir),
    );
    expect(typeof out).toBe("object");
  });

  it("returns text error for missing file", async () => {
    const out = await viewImageTool(
      { path: join(dir, "nope.png") },
      ctxWith("claude-sonnet-4-6", "anthropic", dir),
    );
    expect(typeof out).toBe("string");
    expect(out as string).toContain("无法读取");
  });

  it("rejects oversized files with text", async () => {
    const p = join(dir, "big.png");
    await writeFile(p, Buffer.alloc(6 * 1024 * 1024));
    const out = await viewImageTool({ path: p }, ctxWith("claude-sonnet-4-6", "anthropic", dir));
    expect(typeof out).toBe("string");
    expect(out as string).toContain("过大");
  });
});
