import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { webFetchTool, __setDnsLookupForTests } from "./web-fetch.js";

const realFetch = globalThis.fetch;

/** Stub fetch with a single non-redirect response. */
function stubFetch(opts: {
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  location?: string;
}): void {
  const headers = new Map<string, string>();
  if (opts.contentType) headers.set("content-type", opts.contentType);
  if (opts.location) headers.set("location", opts.location);
  globalThis.fetch = (async () => ({
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    ok: (opts.status ?? 200) < 400,
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    text: async () => opts.body ?? "",
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  // Default: every host resolves to a public IP so non-SSRF tests proceed.
  __setDnsLookupForTests(async () => ["93.184.216.34"]);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  __setDnsLookupForTests(null);
});

describe("webFetchTool — validation & SSRF guards", () => {
  it("requires a url", async () => {
    expect(await webFetchTool({})).toContain("url is required");
  });

  it("rejects an invalid URL", async () => {
    expect(await webFetchTool({ url: "not a url" })).toContain("invalid URL");
  });

  it("refuses a non-http(s) protocol", async () => {
    expect(await webFetchTool({ url: "file:///etc/passwd" })).toMatch(/not allowed|refusing/);
  });

  it("refuses a blocked host (localhost)", async () => {
    const out = await webFetchTool({ url: "http://localhost:8080/x" });
    expect(out).toMatch(/block list|refusing/);
  });

  it("refuses when DNS resolves to a private/metadata IP (SSRF)", async () => {
    // The classic cloud-metadata SSRF target.
    __setDnsLookupForTests(async () => ["169.254.169.254"]);
    const out = await webFetchTool({ url: "http://evil.example.com/" });
    expect(out).toContain("refusing");
    expect(out).toContain("169.254.169.254");
  });

  it("refuses when DNS resolves to a loopback IP", async () => {
    __setDnsLookupForTests(async () => ["127.0.0.1"]);
    const out = await webFetchTool({ url: "http://sneaky.example.com/" });
    expect(out).toContain("refusing");
  });
});

describe("webFetchTool — successful fetch", () => {
  it("extracts text from HTML", async () => {
    stubFetch({
      contentType: "text/html",
      body: "<html><body><h1>Hello</h1><p>World</p></body></html>",
    });
    const out = await webFetchTool({ url: "https://example.com/" });
    expect(out).toContain("Hello");
    expect(out).toContain("World");
    expect(out).not.toContain("<h1>");
  });

  it("returns plain text bodies as-is", async () => {
    stubFetch({ contentType: "text/plain", body: "raw text content" });
    expect(await webFetchTool({ url: "https://example.com/x.txt" })).toBe("raw text content");
  });

  it("truncates to max_length", async () => {
    stubFetch({ contentType: "text/plain", body: "x".repeat(5000) });
    const out = await webFetchTool({ url: "https://example.com/", max_length: 100 });
    expect(out).toContain("content truncated");
    expect(out.length).toBeLessThan(400);
  });

  it("a negative max_length does NOT silently return all-but-last-N (floors to default)", async () => {
    // Regression: max_length:-5 used to hit text.slice(0, -5) = drop the last 5
    // chars + a misleading "truncated" suffix. Non-positive must floor to default.
    const body = "abcdefghij"; // 10 chars, well under default → returned whole
    stubFetch({ contentType: "text/plain", body });
    const out = await webFetchTool({ url: "https://example.com/", max_length: -5 });
    expect(out).toBe(body); // whole body, last chars NOT dropped
    expect(out).not.toContain("truncated");
  });

  it("surfaces an HTTP error status", async () => {
    stubFetch({ status: 404, statusText: "Not Found" });
    expect(await webFetchTool({ url: "https://example.com/missing" })).toContain("HTTP 404");
  });
});
