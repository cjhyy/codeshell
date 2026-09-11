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
    description: `description ${i}`,
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
      { type: "project", name: "ok", description: "d", content: "c" },
      { type: "bogus_type", name: "x", content: "c" }, // invalid type
      { name: "missing-type", content: "c" }, // missing type
    ]);
    const out = parseExtractionResponse(mixed, 5);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("ok");
  });
});

describe("parseExtractionResponse description boundary", () => {
  const invalidDescriptions = [
    ["missing", undefined],
    ["null", null],
    ["number", 42],
    ["boolean", false],
    ["object", {}],
    ["array", []],
  ] as const;
  for (const [kind, description] of invalidDescriptions) {
    test(`filters a ${kind} description before applying the cap`, () => {
      const valid = {
        type: "project",
        name: "valid-memory",
        description: "A useful summary",
        content: "Keep this durable information.",
      };
      const response = JSON.stringify([{ ...valid, name: "malformed-memory", description }, valid]);

      expect(parseExtractionResponse(response, 1)).toEqual([{ ...valid, scope: "project" }]);
    });
  }

  test("preserves an empty string description without inventing a summary", () => {
    const response = JSON.stringify([
      { type: "project", name: "valid-memory", description: "", content: "Durable information" },
    ]);

    expect(parseExtractionResponse(response)[0]?.description).toBe("");
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
    expect(
      out
        .filter((m) => m.scope === "project")
        .map((m) => m.name)
        .sort(),
    ).toEqual(["g2", "g3"]);
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

describe("parseExtractionResponse exact batch duplicates", () => {
  const candidate = {
    type: "project",
    scope: "project",
    name: "runtime-choice",
    description: "Project runtime choice",
    content: "Use bun not npm.",
  };

  test("normalized exact duplicates do not consume the acceptance cap", () => {
    const distinct = {
      ...candidate,
      name: "another-fact",
      content: "Keep release artifacts separate.",
    };
    // Field order and ignored metadata differ, while an invalid scope already
    // normalizes to project under the existing parser contract.
    const duplicate = {
      content: candidate.content,
      description: candidate.description,
      name: candidate.name,
      scope: "invalid",
      type: candidate.type,
      ignoredMetadata: true,
    };
    expect(parseExtractionResponse(JSON.stringify([candidate, duplicate, distinct]))).toEqual([
      candidate,
      distinct,
    ]);
  });

  test("repeated global facts are removed before global demotion and the cap", () => {
    const first = { ...candidate, scope: "global" };
    const second = { ...first, name: "another-global-fact", content: "Prefer short replies." };
    expect(parseExtractionResponse(JSON.stringify([first, { ...first }, second]))).toEqual([
      first,
      { ...second, scope: "project" },
    ]);
  });

  test("preserves every field difference, including case, whitespace, negation and order", () => {
    const variants = [
      { ...candidate, type: "reference" },
      { ...candidate, scope: "global" },
      { ...candidate, name: "Runtime-choice" },
      { ...candidate, description: `${candidate.description} ` },
      { ...candidate, content: "Use Bun not npm." },
      { ...candidate, content: `${candidate.content}\n` },
      { ...candidate, content: "Use bun and npm." },
      { ...candidate, content: "Use npm not bun." },
    ];
    for (const variant of variants) {
      expect(parseExtractionResponse(JSON.stringify([candidate, variant]))).toEqual([
        candidate,
        variant,
      ]);
    }
  });
});

describe("buildExtractionPrompt conservative global wording", () => {
  test("prompt enforces at-most-1-global and conservative bar", () => {
    const p = buildExtractionPrompt([{ role: "user", content: "hi" }], []);
    expect(p).toContain("AT MOST 1");
    expect(p.toLowerCase()).toContain("conservative");
  });
});
