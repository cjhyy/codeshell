import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateImageTool,
  generateImageToolDef,
} from "../packages/core/src/tool-system/builtin/generate-image.js";
import type { ToolContext } from "../packages/core/src/tool-system/context.js";

// SettingsManager defaults to "project" scope: it reads <cwd>/.code-shell/
// settings.json and never touches ~/.code-shell. So a temp cwd with a written
// settings.json fully isolates these tests from the host environment.
function makeCwd(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "genimg-"));
  mkdirSync(join(dir, ".code-shell"), { recursive: true });
  writeFileSync(join(dir, ".code-shell", "settings.json"), JSON.stringify(settings));
  return dir;
}

const OPENAI_SETTINGS = {
  providers: [
    { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" },
  ],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// A 1x1 transparent PNG, base64. Decoding it proves the write path works.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function ctxFor(cwd: string): ToolContext {
  return { cwd } as unknown as ToolContext;
}

describe("GenerateImage tool", () => {
  it("sends the correct payload and writes the decoded PNG, returning its path", async () => {
    const cwd = makeCwd(OPENAI_SETTINGS);
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    let capturedAuth = "";

    globalThis.fetch = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedBody = JSON.parse(init.body as string);
      capturedAuth = (init.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await generateImageTool(
      { prompt: "a red mug", size: "1536x1024", quality: "high" },
      ctxFor(cwd),
    );

    expect(capturedUrl).toBe("https://api.openai.com/v1/images/generations");
    expect(capturedAuth).toBe("Bearer sk-test");
    expect(capturedBody.model).toBe("gpt-image-2");
    expect(capturedBody.prompt).toBe("a red mug");
    expect(capturedBody.size).toBe("1536x1024");
    expect(capturedBody.quality).toBe("high");
    expect(capturedBody.n).toBe(1);

    const match = result.match(/^Generated image saved to (.+\.png)$/);
    expect(match).not.toBeNull();
    const path = match![1];
    expect(existsSync(path)).toBe(true);
    // Written bytes equal the decoded base64.
    expect(readFileSync(path).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
  });

  it("defaults size and quality when omitted", async () => {
    const cwd = makeCwd(OPENAI_SETTINGS);
    let body: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ data: [{ b64_json: PNG_B64 }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await generateImageTool({ prompt: "x" }, ctxFor(cwd));
    expect(body.size).toBe("1024x1024");
    expect(body.quality).toBe("auto");
  });

  it("returns an error when no openai provider is configured", async () => {
    const cwd = makeCwd({
      providers: [
        { key: "ds", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      ],
    });
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await generateImageTool({ prompt: "x" }, ctxFor(cwd));
    expect(result).toContain("no OpenAI provider");
    expect(called).toBe(false); // never hit the network
  });

  it("returns an error string on a non-2xx response", async () => {
    const cwd = makeCwd(OPENAI_SETTINGS);
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    const result = await generateImageTool({ prompt: "x" }, ctxFor(cwd));
    expect(result).toContain("429");
    expect(result).toContain("rate limited");
  });

  it("returns an error when prompt is missing", async () => {
    const result = await generateImageTool({}, ctxFor(makeCwd(OPENAI_SETTINGS)));
    expect(result).toBe("Error: prompt is required");
  });

  it("exposes a well-formed tool definition", () => {
    expect(generateImageToolDef.name).toBe("GenerateImage");
    expect(generateImageToolDef.inputSchema.required).toContain("prompt");
  });
});
