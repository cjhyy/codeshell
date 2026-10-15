import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewImageTool } from "./view-image.js";
import type { ToolContext } from "../context.js";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ctxWith(
  model: string,
  providerKind: string,
  cwd: string,
  supportsVision?: boolean,
): ToolContext {
  return {
    cwd,
    llmConfig: { provider: providerKind, model, providerKind, supportsVision },
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

  it.each([
    ["openai/gpt-6.1-sol", true, true],
    ["future/unknown-model", true, true],
    ["openai/gpt-5.6-sol", false, false],
    ["openai/gpt-5.6-sol", undefined, true],
    ["future/unknown-model", undefined, false],
  ] as const)(
    "uses the current configured vision capability for %s",
    async (model, configured, allowed) => {
      const p = join(dir, "configured.png");
      await writeFile(p, Buffer.from(PNG_B64, "base64"));
      const out = await viewImageTool({ path: p }, ctxWith(model, "openrouter", dir, configured));
      expect(typeof out).toBe(allowed ? "object" : "string");
      if (typeof out === "object") expect(out.contentBlocks?.[0]?.source?.data).toBe(PNG_B64);
      else expect(out).toContain("不支持视觉");
    },
  );

  it("reads the replacement model config rather than retaining the previous model capability", async () => {
    const p = join(dir, "switch.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const ctx = ctxWith("openai/gpt-6.1-sol", "openrouter", dir, true);
    expect(typeof (await viewImageTool({ path: p }, ctx))).toBe("object");

    ctx.llmConfig = ctxWith("openai/gpt-5.6-sol", "openrouter", dir, false).llmConfig;
    expect(await viewImageTool({ path: p }, ctx)).toContain("不支持视觉");

    ctx.llmConfig = ctxWith("future/unknown-model", "openrouter", dir).llmConfig;
    expect(await viewImageTool({ path: p }, ctx)).toContain("不支持视觉");
  });

  it("applies configured vision to historical images before reading the session", async () => {
    let reads = 0;
    const ctx = {
      ...ctxWith("openai/gpt-6.1-sol", "openrouter", dir, true),
      sessionId: "vision-history",
      engine: {
        getSessionManager: () => ({
          resume: () => {
            reads++;
            return {
              transcript: {
                toMessages: () => [
                  {
                    role: "user",
                    content: [
                      {
                        type: "image",
                        source: { type: "base64", media_type: "image/png", data: PNG_B64 },
                      },
                    ],
                  },
                ],
              },
            };
          },
        }),
      },
    } as unknown as ToolContext;
    const out = await viewImageTool({ imageNumber: 1 }, ctx);
    expect(typeof out).toBe("object");
    if (typeof out === "object") expect(out.contentBlocks?.[0]?.source?.data).toBe(PNG_B64);
    expect(reads).toBe(1);

    ctx.llmConfig = ctxWith("openai/gpt-5.6-sol", "openrouter", dir, false).llmConfig;
    expect(await viewImageTool({ imageNumber: 1 }, ctx)).toContain("不支持视觉");
    expect(reads).toBe(1);
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

  it("treats imageNumber: 0 beside a path as an unused model-generated sentinel", async () => {
    const p = join(dir, "sentinel.png");
    await writeFile(p, Buffer.from(PNG_B64, "base64"));
    const out = await viewImageTool(
      { path: p, imageNumber: 0, detail: "high" },
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
