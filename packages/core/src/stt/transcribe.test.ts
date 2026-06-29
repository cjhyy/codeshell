/**
 * STT transcribe service — OpenAI-compatible /audio/transcriptions adapter.
 * fetch is injected; we assert URL / Bearer / multipart fields without network.
 */
import { describe, test, expect } from "bun:test";
import { transcribe, type TranscribeCreds } from "./transcribe.js";

const creds: TranscribeCreds = { baseUrl: "https://api.example.com/v1/", apiKey: "sk-test" };
const audio = new Uint8Array([1, 2, 3, 4]);

describe("transcribe", () => {
  test("posts multipart to {baseUrl}/audio/transcriptions and returns text", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ text: "你好世界" }) } as Response;
    }) as unknown as typeof fetch;

    const res = await transcribe({
      audio,
      mimeType: "audio/webm",
      filename: "audio.webm",
      model: "gpt-4o-transcribe",
      creds,
      fetchImpl: fakeFetch,
    });

    expect(res).toEqual({ ok: true, text: "你好世界" });
    // trailing slash trimmed → no double slash
    expect(calls[0].url).toBe("https://api.example.com/v1/audio/transcriptions");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer sk-test");
    // multipart body carries model + file (+ response_format)
    const form = calls[0].init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("model")).toBe("gpt-4o-transcribe");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file).toBeInstanceOf(Blob);
    // filename preserved
    expect((file as File).name).toBe("audio.webm");
  });

  test("forwards the language hint when given", async () => {
    let form!: FormData;
    const fakeFetch: typeof fetch = (async (_u: string, init: any) => {
      form = init.body;
      return { ok: true, status: 200, json: async () => ({ text: "x" }) } as Response;
    }) as unknown as typeof fetch;
    await transcribe({ audio, mimeType: "audio/webm", filename: "a.webm", model: "whisper-1", creds, language: "zh", fetchImpl: fakeFetch });
    expect(form.get("language")).toBe("zh");
  });

  test("omits language when not given", async () => {
    let form!: FormData;
    const fakeFetch: typeof fetch = (async (_u: string, init: any) => {
      form = init.body;
      return { ok: true, status: 200, json: async () => ({ text: "x" }) } as Response;
    }) as unknown as typeof fetch;
    await transcribe({ audio, mimeType: "audio/webm", filename: "a.webm", model: "whisper-1", creds, fetchImpl: fakeFetch });
    expect(form.has("language")).toBe(false);
  });

  test("non-OK response → error result with status + body", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: false, status: 401, text: async () => "bad key" }) as Response) as unknown as typeof fetch;
    const res = await transcribe({ audio, mimeType: "audio/webm", filename: "a.webm", model: "whisper-1", creds, fetchImpl: fakeFetch });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("401");
      expect(res.error).toContain("bad key");
    }
  });

  test("missing text field → error", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ foo: "bar" }) }) as Response) as unknown as typeof fetch;
    const res = await transcribe({ audio, mimeType: "audio/webm", filename: "a.webm", model: "whisper-1", creds, fetchImpl: fakeFetch });
    expect(res.ok).toBe(false);
  });

  test("network throw → error result, never rejects", async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const res = await transcribe({ audio, mimeType: "audio/webm", filename: "a.webm", model: "whisper-1", creds, fetchImpl: fakeFetch });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("ECONNREFUSED");
  });
});
