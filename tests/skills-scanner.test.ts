import { describe, it, expect } from "bun:test";
import {
  parseFrontmatter,
  quoteProblematicValues,
  coerceDescription,
} from "../src/skills/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses standard name + description", () => {
    const raw = "---\nname: foo\ndescription: does things\n---\nbody here";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("foo");
    expect(frontmatter.description).toBe("does things");
    expect(body).toBe("body here");
  });

  it("returns empty frontmatter and full body when no delimiters", () => {
    const raw = "just markdown here";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe("just markdown here");
  });

  it("handles multi-line description via yaml literal block (>)", () => {
    const raw = "---\ndescription: >\n  line one\n  line two\n---\nbody";
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.description).toMatch(/line one line two/);
  });

  it("recovers via quoteProblematicValues when description contains glob specials", () => {
    const raw = "---\nname: gl\ndescription: Use for **/*.{ts,tsx} patterns\n---\nbody";
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("gl");
    expect(frontmatter.description).toContain("**/*.{ts,tsx}");
  });

  it("returns empty frontmatter (no throw) when yaml is completely broken", () => {
    const raw = "---\n: : : invalid : : :\n  bad indent\n---\nbody";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe("body");
  });

  it("strips the closing --- delimiter and any whitespace it eats (CC parity)", () => {
    // CC's regex `/^---\s*\n([\s\S]*?)---\s*\n?/` is greedy on the trailing
    // `\s*`, so blank lines between `---` and the body are consumed. Verified
    // against utils/frontmatterParser.ts:123 in claude-code-sourcemap. We
    // deliberately preserve this behavior rather than the test name
    // originally suggested.
    const raw = "---\nname: foo\n---\n\nbody starts here";
    const { body } = parseFrontmatter(raw);
    expect(body).toBe("body starts here");
  });
});

describe("quoteProblematicValues", () => {
  it("quotes unquoted value with glob specials", () => {
    const input = "key: foo/*.{ts,tsx}";
    const output = quoteProblematicValues(input);
    expect(output).toBe('key: "foo/*.{ts,tsx}"');
  });

  it("leaves already-quoted values alone", () => {
    const input = 'key: "already quoted"';
    expect(quoteProblematicValues(input)).toBe(input);
  });

  it("leaves plain values alone", () => {
    const input = "key: plain value";
    expect(quoteProblematicValues(input)).toBe(input);
  });

  it("escapes embedded double quotes when wrapping", () => {
    const input = 'key: has "quotes" and *';
    const output = quoteProblematicValues(input);
    expect(output).toBe('key: "has \\"quotes\\" and *"');
  });
});

describe("coerceDescription", () => {
  it("trims string descriptions", () => {
    expect(coerceDescription("  hello  ")).toBe("hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(coerceDescription(null)).toBe("");
    expect(coerceDescription(undefined)).toBe("");
  });

  it("stringifies numbers and booleans", () => {
    expect(coerceDescription(42)).toBe("42");
    expect(coerceDescription(true)).toBe("true");
  });

  it("returns empty string for arrays and objects", () => {
    expect(coerceDescription(["a", "b"])).toBe("");
    expect(coerceDescription({ a: 1 })).toBe("");
  });
});
