/**
 * 7.1 (块2) — Gemini image adapter.
 *
 * Gemini's Images path differs from OpenAI's: it's the generateContent
 * endpoint, the key goes in an x-goog-api-key header, the prompt is a
 * contents/parts text part, and the PNG comes back base64 in
 * candidates[].content.parts[].inline_data.data (REST may also return the
 * camelCase inlineData). The adapter normalizes all of that to the shared
 * ImageGenerateResult.
 */
import { describe, test, expect } from "bun:test";
import { GeminiImageProvider, getImageProvider, DEFAULT_IMAGE_MODEL } from "./image-providers.js";
import type { ImageProviderCreds } from "./image-providers.js";

const creds: ImageProviderCreds = {
  baseUrl: "https://generativelanguage.googleapis.com/v1/",
  apiKey: "AIza-test",
};

describe("GeminiImageProvider", () => {
  test("posts to generateContent for the model, key in x-goog-api-key header, prompt as text part", async () => {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "ok" }, { inline_data: { mime_type: "image/png", data: "QUJD" } }] } }],
        }),
      } as Response;
    }) as unknown as typeof fetch;

    const p = new GeminiImageProvider(fakeFetch);
    const res = await p.generate({ prompt: "a fox", size: "1024x1024", quality: "auto", model: "gemini-2.5-flash-image", creds });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.b64).toBe("QUJD");
    expect(calls[0].url).toBe(
      "https://generativelanguage.googleapis.com/v1/models/gemini-2.5-flash-image:generateContent",
    );
    expect(calls[0].headers["x-goog-api-key"]).toBe("AIza-test");
    expect(calls[0].body.contents[0].parts[0].text).toBe("a fox");
    expect(calls[0].body.generationConfig.responseModalities).toContain("IMAGE");
  });

  test("also reads camelCase inlineData (REST variant)", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: "WFla" } }] } }] }),
      } as Response)) as unknown as typeof fetch;
    const p = new GeminiImageProvider(fakeFetch);
    const res = await p.generate({ prompt: "p", size: "auto", quality: "auto", model: "m", creds });
    expect(res.ok && res.b64).toBe("WFla");
  });

  test("non-OK → error with status + body", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: false, status: 400, text: async () => "bad key" } as Response)) as unknown as typeof fetch;
    const p = new GeminiImageProvider(fakeFetch);
    const res = await p.generate({ prompt: "p", size: "auto", quality: "auto", model: "m", creds });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("400");
      expect(res.error).toContain("bad key");
    }
  });

  test("no image part in response → error", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: "only text" }] } }] }) } as Response)) as unknown as typeof fetch;
    const p = new GeminiImageProvider(fakeFetch);
    const res = await p.generate({ prompt: "p", size: "auto", quality: "auto", model: "m", creds });
    expect(res.ok).toBe(false);
  });
});

describe("registry wiring", () => {
  test("getImageProvider('google') returns a Gemini adapter", () => {
    expect(getImageProvider("google")?.kind).toBe("google");
  });
  test("google has a default model", () => {
    expect(typeof DEFAULT_IMAGE_MODEL.google).toBe("string");
  });
});
