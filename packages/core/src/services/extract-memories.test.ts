import { describe, test, expect } from "bun:test";
import {
  parseExtractionResponse,
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
