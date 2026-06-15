/**
 * 7.1 (块1) — GenerateImage tool resolves provider/model from args + settings.
 * Verifies the default model, the model override, and the unknown-provider
 * error path. Uses a temp workspace settings file + a stubbed global fetch.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateImageTool,
  listConfiguredImageProviders,
  generateImageToolDefFor,
  isGenerateImageAvailable,
} from "./generate-image.js";
import type { ToolContext } from "../context.js";

let ws: string;
const realFetch = globalThis.fetch;
let lastBody: any = null;
// Isolate HOME so SettingsManager(cwd, "full") can't read the developer's real
// ~/.code-shell (an imageGen/providers entry there would override the temp
// workspace settings and break resolution). See project_test_pollutes_real_settings.
let prevHome: string | undefined;
let homeDir: string;

function stubFetchOk(): void {
  globalThis.fetch = (async (_url: string, init: any) => {
    lastBody = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  prevHome = process.env.HOME;
  homeDir = mkdtempSync(join(tmpdir(), "genimg-home-"));
  process.env.HOME = homeDir;
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
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(ws, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
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

describe("GenerateImage referenceImages (image-to-image)", () => {
  test("reads a workspace image and sends it as multipart to /images/edits", async () => {
    let sawUrl = "";
    let sawForm: FormData | null = null;
    globalThis.fetch = (async (url: string, init: any) => {
      sawUrl = url;
      sawForm = init.body as FormData;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "QUJD" }] }) } as Response;
    }) as unknown as typeof fetch;

    // A reference image living in the workspace (relative path).
    writeFileSync(join(ws, "ref.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const out = await generateImageTool(
      { prompt: "re-imagine her", referenceImages: ["ref.png"] },
      ctx(),
    );

    expect(out).toMatch(/from 1 reference image/);
    expect(sawUrl).toMatch(/\/images\/edits$/);
    expect(sawForm).toBeInstanceOf(FormData);
    expect((sawForm as unknown as FormData).getAll("image[]").length).toBe(1);
  });

  test("a missing reference path errors clearly (no API call)", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "x" }] }) } as Response;
    }) as unknown as typeof fetch;
    const out = await generateImageTool(
      { prompt: "p", referenceImages: ["does-not-exist.png"] },
      ctx(),
    );
    expect(out).toMatch(/could not read reference image/);
    expect(called).toBe(false);
  });

  test("an unsupported reference type errors clearly", async () => {
    const out = await generateImageTool(
      { prompt: "p", referenceImages: ["notes.txt"] },
      ctx(),
    );
    expect(out).toMatch(/unsupported reference image type/);
  });
});

describe("GenerateImage availability + dynamic description (TODO 7.1)", () => {
  test("isGenerateImageAvailable true when an image provider with a key exists", () => {
    // nowMs varied to dodge the 1s avail cache across tests sharing a cwd.
    expect(isGenerateImageAvailable(ws, 1)).toBe(true);
  });

  test("isGenerateImageAvailable false with no usable provider", () => {
    writeFileSync(join(ws, ".code-shell", "settings.json"), JSON.stringify({ providers: [] }));
    expect(isGenerateImageAvailable(ws, 2)).toBe(false);
  });

  test("lists configured providers (back-compat LLM providers[] path)", () => {
    expect(listConfiguredImageProviders(ws)).toEqual([{ kind: "openai" }]);
  });

  test("lists imageGen.providers[] ids when present", () => {
    writeFileSync(
      join(ws, ".code-shell", "settings.json"),
      JSON.stringify({
        imageGen: {
          providers: [
            { id: "my-oa", kind: "openai", baseUrl: "https://x/v1", apiKey: "k1" },
            { id: "my-gemini", kind: "google", baseUrl: "https://y", apiKey: "k2" },
          ],
        },
      }),
    );
    // catalogId 由 settings 加载时的 v0→v1 迁移按 kind+tag 回填(migrate-config)。
    expect(listConfiguredImageProviders(ws)).toEqual([
      { id: "my-oa", kind: "openai", catalogId: "openai-images" },
      { id: "my-gemini", kind: "google", catalogId: "google-images" },
    ]);
  });

  test("dynamic description names configured providers", () => {
    const def = generateImageToolDefFor(ws);
    expect(def.description).toContain("Configured provider(s): openai");
  });

  test("dynamic description falls back to static when none configured", () => {
    writeFileSync(join(ws, ".code-shell", "settings.json"), JSON.stringify({ providers: [] }));
    const def = generateImageToolDefFor(ws);
    expect(def.description).not.toContain("Configured provider(s)");
  });
});
