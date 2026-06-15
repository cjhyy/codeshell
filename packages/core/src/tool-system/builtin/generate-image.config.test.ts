/**
 * 7.1 — generic image-gen config: imageGen.providers[] (id+kind), with
 * fallback to LLM providers[] when imageGen is absent. Tests the tool's
 * resolution end-to-end through a temp workspace settings file + stubbed fetch.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateImageTool } from "./generate-image.js";
import type { ToolContext } from "../context.js";

let ws: string;
let homeDir: string;
const realFetch = globalThis.fetch;
const realHome = process.env.HOME;
let lastUrl = "";
let lastBody: any = null;
let lastAuthHeader: string | undefined;
let lastGoogHeader: string | undefined;

function stub(): void {
  globalThis.fetch = (async (url: string, init: any) => {
    lastUrl = url;
    lastBody = JSON.parse(init.body);
    lastAuthHeader = init.headers?.Authorization;
    lastGoogHeader = init.headers?.["x-goog-api-key"];
    // Return a shape valid for BOTH adapters.
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ b64_json: "QUJD" }],
        candidates: [{ content: { parts: [{ inline_data: { data: "QUJD" } }] } }],
      }),
    } as Response;
  }) as unknown as typeof fetch;
}

function writeSettings(obj: unknown): void {
  mkdirSync(join(ws, ".code-shell"), { recursive: true });
  writeFileSync(join(ws, ".code-shell", "settings.json"), JSON.stringify(obj));
}

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), "imgcfg-"));
  // Isolate the user-home settings layer so SettingsManager("full") doesn't
  // merge the real ~/.code-shell (which has the developer's actual keys).
  homeDir = mkdtempSync(join(tmpdir(), "imgcfg-home-"));
  process.env.HOME = homeDir;
  lastUrl = "";
  lastBody = null;
  lastAuthHeader = undefined;
  lastGoogHeader = undefined;
  stub();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(ws, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

const ctx = (): ToolContext => ({ cwd: ws } as unknown as ToolContext);

describe("unified modelConnections + credentials (image)", () => {
  test("resolves an image connection's key from the referenced credential", async () => {
    writeSettings({
      credentials: [{ id: "oa-acct", catalogId: "openai-images", apiKey: "sk-unified" }],
      modelConnections: [
        { id: "img1", catalogId: "openai-images", tag: "image", model: "gpt-image-2", credentialId: "oa-acct" },
      ],
      defaults: { image: "img1" },
    });
    await generateImageTool({ prompt: "p" }, ctx());
    expect(lastAuthHeader).toBe("Bearer sk-unified");
    expect(lastBody.model).toBe("gpt-image-2");
  });

  test("two image connections share one credential's key", async () => {
    writeSettings({
      credentials: [{ id: "oa-acct", catalogId: "openai-images", apiKey: "sk-shared-img" }],
      modelConnections: [
        { id: "a", catalogId: "openai-images", tag: "image", model: "gpt-image-2", credentialId: "oa-acct" },
        { id: "b", catalogId: "openai-images", tag: "image", model: "gpt-image-2", credentialId: "oa-acct" },
      ],
    });
    await generateImageTool({ prompt: "p", provider: "b" }, ctx());
    expect(lastAuthHeader).toBe("Bearer sk-shared-img");
  });
});

describe("imageGen.providers[] config", () => {
  test("selects by id via the provider arg, uses that instance's defaultModel", async () => {
    writeSettings({
      imageGen: {
        defaultProvider: "oa",
        providers: [
          { id: "oa", kind: "openai", baseUrl: "https://oa.test/v1", apiKey: "sk-oa", defaultModel: "gpt-image-2" },
          { id: "gem", kind: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "AIza-x", defaultModel: "gemini-2.5-flash-image" },
        ],
      },
    });
    const out = await generateImageTool({ prompt: "p", provider: "gem" }, ctx());
    expect(out).toMatch(/Generated image with .+ saved to/);
    // Routed to the Gemini adapter (x-goog-api-key + generateContent path).
    expect(lastGoogHeader).toBe("AIza-x");
    expect(lastUrl).toContain(":generateContent");
    expect(lastUrl).toContain("gemini-2.5-flash-image");
  });

  test("defaultProvider is used when no provider arg given", async () => {
    writeSettings({
      imageGen: {
        defaultProvider: "oa",
        providers: [{ id: "oa", kind: "openai", baseUrl: "https://oa.test/v1", apiKey: "sk-oa", defaultModel: "gpt-image-2" }],
      },
    });
    await generateImageTool({ prompt: "p" }, ctx());
    expect(lastAuthHeader).toBe("Bearer sk-oa");
    expect(lastBody.model).toBe("gpt-image-2");
  });

  test("model arg overrides the instance defaultModel", async () => {
    writeSettings({
      imageGen: { providers: [{ id: "oa", kind: "openai", baseUrl: "https://oa.test/v1", apiKey: "sk-oa", defaultModel: "gpt-image-2" }] },
    });
    await generateImageTool({ prompt: "p", model: "gpt-image-9000" }, ctx());
    expect(lastBody.model).toBe("gpt-image-9000");
  });

  test("unknown provider id errors clearly", async () => {
    writeSettings({
      imageGen: { providers: [{ id: "oa", kind: "openai", baseUrl: "https://oa.test/v1", apiKey: "sk-oa" }] },
    });
    const out = await generateImageTool({ prompt: "p", provider: "nope" }, ctx());
    expect(out).toMatch(/no image provider/i);
  });
});

describe("default-with-no-key falls back to a configured one", () => {
  test("defaultProvider lacks apiKey → uses the next entry that has one", async () => {
    writeSettings({
      imageGen: {
        defaultProvider: "gem",
        providers: [
          // default points here, but no apiKey → must not be chosen
          { id: "gem", kind: "google", baseUrl: "https://g.test/v1beta", defaultModel: "gemini-2.5-flash-image" },
          { id: "oa", kind: "openai", baseUrl: "https://oa.test/v1", apiKey: "sk-oa", defaultModel: "gpt-image-2" },
        ],
      },
    });
    const out = await generateImageTool({ prompt: "p" }, ctx());
    expect(out).toMatch(/Generated image with .+ saved to/);
    expect(lastAuthHeader).toBe("Bearer sk-oa"); // fell back to openai
  });

  test("explicit provider arg with no key still errors (no silent fallback)", async () => {
    writeSettings({
      imageGen: {
        providers: [
          { id: "gem", kind: "google", baseUrl: "https://g.test/v1beta" },
          { id: "oa", kind: "openai", baseUrl: "https://oa.test/v1", apiKey: "sk-oa" },
        ],
      },
    });
    // User explicitly asked for gem (no key) — respect intent, don't use oa.
    const out = await generateImageTool({ prompt: "p", provider: "gem" }, ctx());
    expect(out).toMatch(/no image provider|not configured|no api key/i);
  });
});

describe("result names the provider/model actually used", () => {
  test("success message includes the kind + model", async () => {
    writeSettings({
      imageGen: {
        defaultProvider: "gem",
        providers: [{ id: "gem", kind: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKey: "AIza", defaultModel: "gemini-2.5-flash-image" }],
      },
    });
    const out = (await generateImageTool({ prompt: "p" }, ctx())) as string;
    expect(out).toMatch(/google/);
    expect(out).toMatch(/gemini-2\.5-flash-image/);
  });
});

describe("apiKeyRef — reuse another instance's key", () => {
  test("instance with no own key reuses the referenced instance's key", async () => {
    writeSettings({
      imageGen: {
        defaultProvider: "oa2",
        providers: [
          { id: "oa1", kind: "openai", baseUrl: "https://oa.test/v1", apiKey: "sk-shared", defaultModel: "gpt-image-2" },
          // oa2 has no key of its own — reuses oa1's.
          { id: "oa2", kind: "openai", baseUrl: "https://oa.test/v1", apiKeyRef: "oa1", defaultModel: "gpt-image-2" },
        ],
      },
    });
    const out = await generateImageTool({ prompt: "p", provider: "oa2" }, ctx());
    expect(out).toMatch(/Generated image with .+ saved to/);
    expect(lastAuthHeader).toBe("Bearer sk-shared");
  });

  test("dangling apiKeyRef (target missing/keyless) → not usable", async () => {
    writeSettings({
      imageGen: {
        providers: [{ id: "oa2", kind: "openai", baseUrl: "https://oa.test/v1", apiKeyRef: "ghost" }],
      },
    });
    const out = await generateImageTool({ prompt: "p", provider: "oa2" }, ctx());
    expect(out).toMatch(/no image provider/i);
  });
});

describe("fallback to LLM providers[] when imageGen absent", () => {
  test("still resolves an openai LLM provider (back-compat)", async () => {
    writeSettings({
      providers: [{ key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk-legacy" }],
    });
    const out = await generateImageTool({ prompt: "p" }, ctx());
    expect(out).toMatch(/Generated image with .+ saved to/);
    expect(lastAuthHeader).toBe("Bearer sk-legacy");
    expect(lastBody.model).toBe("gpt-image-2");
  });
});
