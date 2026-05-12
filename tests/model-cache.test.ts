import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCache, writeCache, isStale, type CachedModel } from "../src/llm/model-cache.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SAMPLE: CachedModel[] = [
  { id: "gpt-4o", contextLength: 128_000, maxOutputTokens: 16_384 },
];

describe("model-cache", () => {
  it("returns undefined when file missing", () => {
    expect(readCache(dir, "openai")).toBeUndefined();
  });

  it("writeCache writes and readCache reads back", () => {
    writeCache(dir, "openai", SAMPLE);
    const got = readCache(dir, "openai");
    expect(got?.providerKey).toBe("openai");
    expect(got?.models).toEqual(SAMPLE);
    expect(got?.fetchedAt).toBeTruthy();
  });

  it("isStale flips at the 7-day boundary", () => {
    const now = Date.now();
    expect(isStale({ fetchedAt: new Date(now).toISOString() } as never)).toBe(false);
    const old = new Date(now - 8 * 24 * 3600 * 1000).toISOString();
    expect(isStale({ fetchedAt: old } as never)).toBe(true);
  });

  it("writeCache creates the directory if missing", () => {
    const nested = join(dir, "deep", "nested");
    writeCache(nested, "x", SAMPLE);
    expect(existsSync(join(nested, "x.json"))).toBe(true);
  });

  it("readCache returns undefined on malformed JSON", () => {
    writeCache(dir, "broken", SAMPLE);
    const path = join(dir, "broken.json");
    require("node:fs").writeFileSync(path, "{not json", "utf-8");
    expect(readCache(dir, "broken")).toBeUndefined();
  });
});
