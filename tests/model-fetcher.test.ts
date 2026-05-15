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
  it("openai-compat: normalizes /models payload (live values win over static table)", async () => {
    // openai has a static catalog (src/data/openai-models.json). The live
    // response should still appear first with its own values, and any
    // static-only ids get appended after.
    mockFetch({
      data: [
        { id: "gpt-4o", context_window: 64000, max_completion_tokens: 4096 },
        { id: "text-embedding-3-small" },
      ],
    });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    const ids = res.models.map((m) => m.id);
    expect(ids[0]).toBe("gpt-4o");
    expect(ids).not.toContain("text-embedding-3-small");
    // Live response wins — not the static catalog's 128000/16384.
    expect(res.models[0].contextLength).toBe(64000);
    expect(res.models[0].maxOutputTokens).toBe(4096);
  });

  it("deepseek: live ids enriched + static-only ids appended", async () => {
    // deepseek-v4-flash comes back without ctx/output in the live payload —
    // the merge step should fill those in from the static catalog. The
    // other static ids (e.g. deepseek-v4-pro) are appended at the end.
    mockFetch({ data: [{ id: "deepseek-v4-flash" }, { id: "deepseek-embed-v1" }] });
    const res = await fetchModelList(
      { key: "ds", kind: "deepseek", baseUrl: "https://api.deepseek.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    const ids = res.models.map((m) => m.id);
    expect(ids[0]).toBe("deepseek-v4-flash");
    expect(ids).toContain("deepseek-v4-pro");
    expect(ids).not.toContain("deepseek-embed-v1");
    const flash = res.models.find((m) => m.id === "deepseek-v4-flash");
    expect(flash?.contextLength).toBe(1000000);
    expect(flash?.maxOutputTokens).toBe(384000);
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

  it("sorts newer model versions first (decimal, dash-decimal, integer)", async () => {
    // Mixed naming styles in a single response — verifies sortByRecency
    // handles decimal (gpt-5.5), dash-decimal (claude-sonnet-4-6,
    // claude-3-5-haiku), and bare-integer (gpt-4) all in one pass.
    // xai has no static catalog so no extra ids get appended.
    mockFetch({
      data: [
        { id: "gpt-4" },
        { id: "claude-3-5-haiku" },
        { id: "gpt-5.5" },
        { id: "claude-sonnet-4-6" },
        { id: "claude-sonnet-4-5" },
      ],
    });
    const res = await fetchModelList(
      { key: "xai", kind: "xai", baseUrl: "https://api.x.ai/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    // Numeric order: 5.5 > 4.6 > 4.5 > 4 > 3.5. We compare *only* the
    // extracted version number, not the family — so `gpt-4` (4.0)
    // legitimately sorts ahead of `claude-3-5-haiku` (3.5). Cross-family
    // ordering only matters within a single provider's catalog anyway.
    expect(res.models.map((m) => m.id)).toEqual([
      "gpt-5.5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5",
      "gpt-4",
      "claude-3-5-haiku",
    ]);
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

  it("network error with no cache + no static catalog returns empty list + error info", async () => {
    // xai has no static catalog, so a network error with no cache yields
    // an empty model list with an error message — the original contract.
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await fetchModelList(
      { key: "xai", kind: "xai", baseUrl: "https://api.x.ai/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toContain("ECONNREFUSED");
  });

  it("network error falls back to static catalog when available", async () => {
    // openai has a static catalog — fetch failure should surface the
    // error but populate models from the static table so the user can
    // still pick something.
    spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("ECONNREFUSED");
    });
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.error).toContain("ECONNREFUSED");
    expect(res.models.length).toBeGreaterThan(0);
    expect(res.models.map((m) => m.id)).toContain("gpt-5");
  });

  it("HTTP 401 + no static catalog surfaces an empty list with auth error", async () => {
    mockFetch({ error: "unauthorized" }, 401);
    const res = await fetchModelList(
      { key: "xai", kind: "xai", baseUrl: "https://api.x.ai/v1", apiKey: "bad" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toMatch(/401/);
  });

  it("HTTP 401 + provider has static catalog — still returns empty (auth error, not network)", async () => {
    // openai has a static catalog. A 401 means the key is wrong; showing
    // models the user can't actually call would defer the error to the
    // first chat turn. Surface the auth failure now.
    mockFetch({ error: "unauthorized" }, 401);
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "bad" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toMatch(/401/);
  });

  it("HTTP 403 + provider has static catalog — same: empty list, no fallback", async () => {
    mockFetch({ error: "forbidden" }, 403);
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "bad" },
      { cacheDir: dir },
    );
    expect(res.models).toEqual([]);
    expect(res.error).toMatch(/403/);
  });

  it("HTTP 500 + provider has static catalog — falls back (server issue, not auth)", async () => {
    // Non-auth HTTP errors still fall back to the static catalog so the
    // user has something to pick from while the upstream recovers.
    mockFetch({ error: "internal" }, 500);
    const res = await fetchModelList(
      { key: "openai", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "k" },
      { cacheDir: dir },
    );
    expect(res.error).toMatch(/500/);
    expect(res.models.length).toBeGreaterThan(0);
  });
});
