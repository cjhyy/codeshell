/**
 * 7.1 (块3) — VideoProvider 适配器接口(submit / poll / download 三段式)。
 *
 * Video generation is inherently long-running and asynchronous: you submit a
 * job, poll its status until done, then download the bytes. The interface
 * captures exactly those three steps so concrete adapters (Seedance/Kling,
 * filled in later once their private API docs are available) and the
 * GenerateVideo tool's background polling loop share one contract.
 */
import { describe, test, expect } from "bun:test";
import { FakeVideoProvider, getVideoProvider, FalVideoProvider } from "./video-providers.js";

describe("VideoProvider contract (FakeVideoProvider)", () => {
  test("submit returns a jobId; poll reports running then succeeded; download returns bytes", async () => {
    const creds = { baseUrl: "https://x", apiKey: "k" };
    // succeedAfterPolls: 1 → first poll running, second succeeded.
    const p = new FakeVideoProvider({ succeedAfterPolls: 1, bytes: "VIDEO_BYTES" });

    const submit = await p.submit({ prompt: "a wave", model: "fake-1", creds });
    expect(submit.ok).toBe(true);
    if (!submit.ok) return;
    expect(typeof submit.jobId).toBe("string");

    const poll1 = await p.poll({ jobId: submit.jobId, creds });
    expect(poll1.ok && poll1.status).toBe("running");

    const poll2 = await p.poll({ jobId: submit.jobId, creds });
    expect(poll2.ok && poll2.status).toBe("succeeded");

    const dl = await p.download({ jobId: submit.jobId, creds });
    expect(dl.ok).toBe(true);
    if (dl.ok) expect(Buffer.from(dl.bytes).toString()).toBe("VIDEO_BYTES");
  });

  test("a failed job surfaces status=failed with a message", async () => {
    const p = new FakeVideoProvider({ failAfterPolls: 0, failMessage: "content policy" });
    const submit = await p.submit({ prompt: "p", model: "m", creds: { baseUrl: "x", apiKey: "k" } });
    if (!submit.ok) throw new Error("submit failed");
    const poll = await p.poll({ jobId: submit.jobId, creds: { baseUrl: "x", apiKey: "k" } });
    expect(poll.ok && poll.status).toBe("failed");
    if (poll.ok && poll.status === "failed") expect(poll.error).toContain("content policy");
  });
});

describe("registry", () => {
  test("getVideoProvider returns null for unknown kind (no real adapters yet)", () => {
    expect(getVideoProvider("seedance")).toBeNull();
    expect(getVideoProvider("kling")).toBeNull();
  });
  test("getVideoProvider('fake') returns the fake (test/dev) adapter", () => {
    expect(getVideoProvider("fake")?.kind).toBe("fake");
  });
  test("getVideoProvider('fal') returns FalVideoProvider", () => {
    expect(getVideoProvider("fal")?.kind).toBe("fal");
  });
});

describe("FalVideoProvider", () => {
  const creds = { baseUrl: "https://queue.fal.run", apiKey: "k-123" };

  // Real fal submit response shape (verified against live API 2026-06-10):
  // status/result URLs use the model-FAMILY prefix, not the full submit path.
  const STATUS_URL = "https://queue.fal.run/fal-ai/kling-video/requests/req-1/status";
  const RESPONSE_URL = "https://queue.fal.run/fal-ai/kling-video/requests/req-1";
  const falSubmitBody = (id: string) => ({
    status: "IN_QUEUE",
    request_id: id,
    response_url: `https://queue.fal.run/fal-ai/kling-video/requests/${id}`,
    status_url: `https://queue.fal.run/fal-ai/kling-video/requests/${id}/status`,
  });

  test("submit (text-to-video): POST {baseUrl}/{model}; jobId encodes status_url|response_url", async () => {
    const calls: Array<{ url: string; body: any; headers: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return { ok: true, status: 200, json: async () => falSubmitBody("req-1") } as Response;
    }) as unknown as typeof fetch;

    const p = new FalVideoProvider(fakeFetch);
    const model = "fal-ai/kling-video/v3/pro/text-to-video";
    const res = await p.submit({ prompt: "a wave", model, creds });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.jobId).toBe(`${STATUS_URL}|${RESPONSE_URL}`);
    expect(calls[0].url).toBe(`https://queue.fal.run/${model}`);
    expect(calls[0].headers.Authorization).toBe("Key k-123");
    expect(calls[0].body).toEqual({ prompt: "a wave" });
  });

  test("submit (image-to-video): image switches t2v model to i2v and sends image_url", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, json: async () => falSubmitBody("req-2") } as Response;
    }) as unknown as typeof fetch;

    const p = new FalVideoProvider(fakeFetch);
    const res = await p.submit({
      prompt: "zoom in",
      model: "fal-ai/kling-video/v3/pro/text-to-video",
      image: "https://example.com/a.png",
      creds,
    });

    expect(res.ok).toBe(true);
    expect(calls[0].url).toBe("https://queue.fal.run/fal-ai/kling-video/v3/pro/image-to-video");
    expect(calls[0].body).toEqual({ prompt: "zoom in", image_url: "https://example.com/a.png" });
  });

  test("submit non-OK → ok:false with status", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: false, status: 401, text: async () => "bad key" } as Response)) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const res = await p.submit({ prompt: "p", model: "m", creds });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("401");
  });

  test("submit missing status_url/response_url → ok:false", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ request_id: "x" }) } as Response)) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const res = await p.submit({ prompt: "p", model: "m", creds });
    expect(res.ok).toBe(false);
  });

  test("poll uses status_url verbatim; maps IN_QUEUE/IN_PROGRESS→running, COMPLETED→succeeded; 202 ok", async () => {
    const seq = [
      { status: 200, body: "IN_QUEUE" },
      { status: 202, body: "IN_PROGRESS" }, // live API returns 202 while running
      { status: 200, body: "COMPLETED" },
    ];
    let i = 0;
    const urls: string[] = [];
    const fakeFetch: typeof fetch = (async (url: string) => {
      urls.push(url);
      const s = seq[i++];
      return { ok: s.status >= 200 && s.status < 300, status: s.status, json: async () => ({ status: s.body }) } as Response;
    }) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const jobId = `${STATUS_URL}|${RESPONSE_URL}`;

    const r1 = await p.poll({ jobId, creds });
    expect(r1.ok && r1.status).toBe("running");
    const r2 = await p.poll({ jobId, creds });
    expect(r2.ok && r2.status).toBe("running");
    const r3 = await p.poll({ jobId, creds });
    expect(r3.ok && r3.status).toBe("succeeded");
    expect(urls[0]).toBe(STATUS_URL);
  });

  test("poll network error → ok:false", async () => {
    const fakeFetch: typeof fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const r = await p.poll({ jobId: `${STATUS_URL}|${RESPONSE_URL}`, creds });
    expect(r.ok).toBe(false);
  });

  test("download: hop1 uses response_url → video.url, hop2 fetch bytes, ext from url", async () => {
    const urls: string[] = [];
    const fakeFetch: typeof fetch = (async (url: string) => {
      urls.push(url);
      if (url === RESPONSE_URL) {
        return { ok: true, status: 200, json: async () => ({ video: { url: "https://cdn.fal/v/out.mp4" } }) } as Response;
      }
      // hop2: video bytes
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode("VIDEOBYTES").buffer } as Response;
    }) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const jobId = `${STATUS_URL}|${RESPONSE_URL}`;
    const dl = await p.download({ jobId, creds });
    expect(dl.ok).toBe(true);
    if (dl.ok) {
      expect(Buffer.from(dl.bytes).toString()).toBe("VIDEOBYTES");
      expect(dl.ext).toBe("mp4");
    }
    expect(urls[0]).toBe(RESPONSE_URL);
    expect(urls[1]).toBe("https://cdn.fal/v/out.mp4");
  });

  test("download: missing video.url → ok:false", async () => {
    const fakeFetch: typeof fetch = (async () =>
      ({ ok: true, status: 200, json: async () => ({ video: {} }) } as Response)) as unknown as typeof fetch;
    const p = new FalVideoProvider(fakeFetch);
    const dl = await p.download({ jobId: `${STATUS_URL}|${RESPONSE_URL}`, creds });
    expect(dl.ok).toBe(false);
  });
});
