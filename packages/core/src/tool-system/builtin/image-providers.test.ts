/**
 * 7.1 (块1) — ImageProvider 适配器接口 + OpenAI 适配器。
 *
 * Goal: lift the hardcoded gpt-image-2 / OpenAI Images call behind an
 * ImageProvider interface so GenerateImage can target multiple providers
 * (OpenAI now; Gemini next) and accept an optional provider/model. Behavior
 * for the existing OpenAI path must be byte-identical.
 */
import { describe, test, expect } from "bun:test";
import { OpenAIImageProvider, type ImageProviderCreds } from "./image-providers.js";

const creds: ImageProviderCreds = { baseUrl: "https://api.example.com/v1/", apiKey: "sk-test" };

describe("OpenAIImageProvider", () => {
  test("posts to {baseUrl}/images/generations with model/prompt/size/quality, returns b64", async () => {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: "QUJD" }] }),
      } as Response;
    }) as unknown as typeof fetch;

    const p = new OpenAIImageProvider(fakeFetch);
    const res = await p.generate({
      prompt: "a cat",
      size: "1024x1024",
      quality: "high",
      model: "gpt-image-2",
      creds,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.b64).toBe("QUJD");
    // Trailing slash on baseUrl must be trimmed (no double slash).
    expect(calls[0].url).toBe("https://api.example.com/v1/images/generations");
    expect(calls[0].body).toMatchObject({ model: "gpt-image-2", prompt: "a cat", size: "1024x1024", quality: "high", n: 1 });
    expect(calls[0].headers.Authorization).toBe("Bearer sk-test");
  });

  test("uses the model passed in (not a hardcoded one)", async () => {
    let sentModel = "";
    const fakeFetch: typeof fetch = (async (_url: string, init: any) => {
      sentModel = JSON.parse(init.body).model;
      return { ok: true, status: 200, json: async () => ({ data: [{ b64_json: "x" }] }) } as Response;
    }) as unknown as typeof fetch;
    const p = new OpenAIImageProvider(fakeFetch);
    await p.generate({ prompt: "p", size: "auto", quality: "auto", model: "gpt-image-9000", creds });
    expect(sentModel).toBe("gpt-image-9000");
  });

  test("non-OK response → error result with status + body", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: false, status: 429, text: async () => "rate limited" } as Response)) as unknown as typeof fetch;
    const p = new OpenAIImageProvider(fakeFetch);
    const res = await p.generate({ prompt: "p", size: "auto", quality: "auto", model: "m", creds });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("429");
      expect(res.error).toContain("rate limited");
    }
  });

  test("missing b64 in response → error result", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ data: [{}] }) } as Response)) as unknown as typeof fetch;
    const p = new OpenAIImageProvider(fakeFetch);
    const res = await p.generate({ prompt: "p", size: "auto", quality: "auto", model: "m", creds });
    expect(res.ok).toBe(false);
  });
});
