/**
 * 7.1 (块1) — GenerateImage tool resolves provider/model from args + settings.
 * Verifies the default model, the model override, and the unknown-provider
 * error path. Uses a temp workspace settings file + a stubbed global fetch.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImageTool } from "./generate-image.js";
import type { ToolContext } from "../context.js";

let ws: string;
const realFetch = globalThis.fetch;
let lastBody: any = null;

function stubFetchOk(): void {
  globalThis.fetch = (async (_url: string, init: any) => {
    lastBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "genimg-"));
  mkdirSync(join(ws, ".code-shell"), { recursive: true });
  writeFileSync(
    join(ws, ".code-shell", "settings.json"),
    JSON.stringify({
      providers: [{ key: "oa", kind: "openai", baseUrl: "https://api.example.com/v1", apiKey: "sk-x" }],
    }),
  );
  lastBody = null;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(ws, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return { cwd: ws } as unknown as ToolContext;
}

describe("GenerateImage provider/model resolution", () => {
  test("defaults to openai gpt-image-2 and saves a PNG", async () => {
    stubFetchOk();
    const out = await generateImageTool({ prompt: "a cat" }, ctx());
    expect(out).toMatch(/Generated image with .+ saved to/);
    expect(lastBody.model).toBe("gpt-image-2");
    const dir = join(ws, ".code-shell", "generated_images");
    expect(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".png"))).toBe(true);
  });

  test("honors an explicit model override", async () => {
    stubFetchOk();
    await generateImageTool({ prompt: "p", model: "gpt-image-9000" }, ctx());
    expect(lastBody.model).toBe("gpt-image-9000");
  });

  test("requesting an unconfigured provider kind errors clearly", async () => {
    stubFetchOk();
    const out = await generateImageTool({ prompt: "p", provider: "google" }, ctx());
    expect(out).toMatch(/no image provider "google"/);
  });

  test("no providers configured at all → helpful error", async () => {
    writeFileSync(join(ws, ".code-shell", "settings.json"), JSON.stringify({ providers: [] }));
    const out = await generateImageTool({ prompt: "p" }, ctx());
    expect(out).toMatch(/no image provider available/);
  });
});
