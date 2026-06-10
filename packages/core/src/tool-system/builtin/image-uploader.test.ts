import { describe, test, expect } from "bun:test";
import { FalStorageUploader, getImageUploader, isHttpUrl } from "./image-uploader.js";

describe("isHttpUrl", () => {
  test("http/https → true; local path → false", () => {
    expect(isHttpUrl("https://x/a.png")).toBe(true);
    expect(isHttpUrl("http://x/a.png")).toBe(true);
    expect(isHttpUrl("/Users/me/a.png")).toBe(false);
    expect(isHttpUrl("./a.png")).toBe(false);
  });
});

describe("FalStorageUploader.toUrl", () => {
  const creds = { baseUrl: "https://queue.fal.run", apiKey: "k" };

  test("already-a-URL → returned unchanged, no fetch", async () => {
    let called = false;
    const fakeFetch: typeof fetch = (async () => { called = true; return {} as Response; }) as unknown as typeof fetch;
    const up = new FalStorageUploader(fakeFetch);
    const r = await up.toUrl("https://x/a.png", creds);
    expect(r).toEqual({ ok: true, url: "https://x/a.png" });
    expect(called).toBe(false);
  });

  test("getImageUploader('fal') returns a FalStorageUploader", () => {
    expect(getImageUploader("fal")?.kind).toBe("fal");
  });

  test("local path → initiate + PUT, returns file_url", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    const fakeFetch: typeof fetch = (async (url: string, init: any) => {
      calls.push({ url, method: init?.method });
      if (url.endsWith("/storage/upload/initiate")) {
        return { ok: true, status: 200, json: async () => ({ file_url: "https://v3b.fal.media/files/x/out.png", upload_url: "https://v3b.fal.media/files/x/out.png?signature=sig" }) } as Response;
      }
      return { ok: true, status: 200 } as Response; // PUT
    }) as unknown as typeof fetch;
    const up = new FalStorageUploader(fakeFetch);
    // 用一个真实存在的临时文件路径
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const f = join(mkdtempSync(join(tmpdir(), "up-")), "a.png");
    writeFileSync(f, Buffer.from("PNGBYTES"));
    const r = await up.toUrl(f, { baseUrl: "https://queue.fal.run", apiKey: "k" });
    expect(r).toEqual({ ok: true, url: "https://v3b.fal.media/files/x/out.png" });
    expect(calls[0].url).toBe("https://rest.alpha.fal.ai/storage/upload/initiate");
    expect(calls[0].method).toBe("POST");
    expect(calls[1].url).toBe("https://v3b.fal.media/files/x/out.png?signature=sig");
    expect(calls[1].method).toBe("PUT");
  });
});
