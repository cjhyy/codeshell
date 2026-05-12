import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchModelList } from "../src/llm/model-fetcher.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mf-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mock.restore();
});

function mockFetch(body: unknown, status = 200) {
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  spy.mockClear();
  return spy;
}

describe("fetchModelList", () => {
  it("openai-compat: normalizes /models payload", async () => {
    mockFetch({
      data: [
        { id: "gpt-4o", context_window: 128000, max_completion_tokens: 16384 },
        { id: "text-embedding-3-small" },
      ],
    });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.models.map((m) => m.id)).toEqual(["gpt-4o"]);
    expect(res.models[0].contextLength).toBe(128000);
  });

  it("deepseek: normalizes payload and filters non-chat", async () => {
    mockFetch({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-embed-v1" }] });
    const res = await fetchModelList(
      { key: "ds", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.models.map((m) => m.id)).toEqual(["deepseek-v4-flash"]);
  });

  it("ollama: hits /api/tags shape", async () => {
    mockFetch({ models: [{ name: "llama3:8b" }, { name: "nomic-embed-text" }] });
    const res = await fetchModelList(
      { key: "local", kind: "ollama", baseUrl: "http://localhost:11434", apiKey: undefined },
      { cacheDir: dir },
    );
    expect(res.models.map((m) => m.id)).toEqual(["llama3:8b"]);
  });

  it("openrouter: reads local snapshot, never calls fetch", async () => {
    const spy = mockFetch({});
    const res = await fetchModelList(
      { key: "or", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.models.length).toBeGreaterThan(0);
  });

  it("returns cached payload when fresh (no fetch)", async () => {
    mockFetch({ data: [{ id: "gpt-4o" }] });
    await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    const spy = mockFetch({ data: [{ id: "WRONG" }] });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(res.models[0].id).toBe("gpt-4o");
  });

  it("refresh: true bypasses cache", async () => {
    mockFetch({ data: [{ id: "gpt-4o" }] });
    await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    mockFetch({ data: [{ id: "gpt-5" }] });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir, refresh: true },
    );
    expect(res.models[0].id).toBe("gpt-5");
  });

  it("network error with no cache returns empty list + error info", async () => {
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("HTTP 401 surfaces an auth error", async () => {
    mockFetch({ error: "unauthorized" }, 401);
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "bad" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toMatch(/401/);
  });
});
