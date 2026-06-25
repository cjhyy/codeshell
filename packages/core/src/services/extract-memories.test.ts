import { describe, test, expect } from "bun:test";
import {
  parseExtractionResponse,
  buildExtractionPrompt,
  MAX_MEMORIES_PER_EXTRACTION,
} from "./extract-memories.js";

// TODO §8.1 — settings.memories.maxCount must be able to override the
// built-in per-extraction cap; absent/invalid → the default.

function memJson(n: number): string {
  const arr = Array.from({ length: n }, (_, i) => ({
    type: "project",
    name: `m${i}`,
    content: `content ${i}`,
  }));
  return JSON.stringify(arr);
}

describe("parseExtractionResponse maxCount", () => {
  test("defaults to MAX_MEMORIES_PER_EXTRACTION when maxCount omitted", () => {
    const out = parseExtractionResponse(memJson(10));
    expect(out).toHaveLength(MAX_MEMORIES_PER_EXTRACTION);
  });

  test("a larger maxCount accepts more memories", () => {
    const out = parseExtractionResponse(memJson(10), 5);
    expect(out).toHaveLength(5);
  });

  test("maxCount caps below the number returned", () => {
    const out = parseExtractionResponse(memJson(10), 1);
    expect(out).toHaveLength(1);
  });

  test("non-positive / invalid maxCount falls back to the default", () => {
    expect(parseExtractionResponse(memJson(10), 0)).toHaveLength(MAX_MEMORIES_PER_EXTRACTION);
    expect(parseExtractionResponse(memJson(10), -3)).toHaveLength(MAX_MEMORIES_PER_EXTRACTION);
  });

  test("fractional maxCount is floored", () => {
    expect(parseExtractionResponse(memJson(10), 3.9)).toHaveLength(3);
  });

  test("invalid entries are filtered before the cap applies", () => {
    const mixed = JSON.stringify([
      { type: "project", name: "ok", content: "c" },
      { type: "bogus_type", name: "x", content: "c" }, // invalid type
      { name: "missing-type", content: "c" }, // missing type
    ]);
    const out = parseExtractionResponse(mixed, 5);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("ok");
  });
});

describe("parseExtractionResponse global cap (审批门 克制)", () => {
  test("at most 1 global survives; extra globals demoted to project", () => {
    const json = JSON.stringify([
      { type: "feedback", scope: "global", name: "g1", description: "d", content: "c" },
      { type: "user", scope: "global", name: "g2", description: "d", content: "c" },
      { type: "feedback", scope: "global", name: "g3", description: "d", content: "c" },
    ]);
    const out = parseExtractionResponse(json, 10);
    const globals = out.filter((m) => m.scope === "global");
    expect(globals).toHaveLength(1);
    expect(globals[0].name).toBe("g1"); // first one kept
    expect(out.filter((m) => m.scope === "project").map((m) => m.name).sort()).toEqual(["g2", "g3"]);
  });

  test("missing/invalid scope defaults to project (never accidental global)", () => {
    const json = JSON.stringify([
      { type: "project", name: "a", description: "d", content: "c" },
      { type: "project", scope: "weird", name: "b", description: "d", content: "c" },
    ]);
    const out = parseExtractionResponse(json, 10);
    expect(out.every((m) => m.scope === "project")).toBe(true);
  });
});

describe("buildExtractionPrompt conservative global wording", () => {
  test("prompt enforces at-most-1-global and conservative bar", () => {
    const p = buildExtractionPrompt([{ role: "user", content: "hi" }], []);
    expect(p).toContain("AT MOST 1");
    expect(p.toLowerCase()).toContain("conservative");
  });
});
