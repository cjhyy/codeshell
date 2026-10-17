import { describe, expect, test } from "bun:test";
import { parsePositiveInt, positiveIntOption } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/cli/parse-int-option.ts";

// Actual leaf and Commander dependency resolution, no CLI or dependency mock.
describe("round20 positive integer leaf controls", () => {
  test("trims ordinary argument whitespace before decimal conversion", () => {
    expect(parsePositiveInt(" \t42\r\n", "--limit")).toBe(42);
    expect(parsePositiveInt("\u00a042\u00a0", "--limit")).toBe(42);
  });
  test("leading zeros stay decimal and all-zero input stays invalid", () => {
    expect(parsePositiveInt("00042", "--limit")).toBe(42);
    expect(parsePositiveInt("000010", "--limit")).toBe(10);
    expect(() => parsePositiveInt("000", "--limit")).toThrow();
  });
  test("rejects empty and whitespace-only values", () => {
    for (const raw of ["", " ", "\t\r\n", "\u00a0"]) {
      expect(() => parsePositiveInt(raw, "--limit")).toThrow();
    }
  });
  test("rejects alternate numeric syntaxes and embedded separators", () => {
    for (const raw of ["+5", "1.0", "1e3", "0x10", "0b10", "1_000", "1,000", "1 0", "1\n0"]) {
      expect(() => parsePositiveInt(raw, "--limit")).toThrow();
    }
  });
  test("base-ten ASCII grammar does not silently accept non-ASCII numeral shapes", () => {
    expect(() => parsePositiveInt("４２", "--limit")).toThrow();
    expect(() => parsePositiveInt("٤٢", "--limit")).toThrow();
  });
  test("error keeps the option label and original input escaping", () => {
    let caught: unknown;
    try { parsePositiveInt(" \tbad\n", "--background-wait-ms"); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).constructor.name).toBe("InvalidArgumentError");
    expect((caught as Error).message).toContain("--background-wait-ms");
    expect((caught as Error).message).toContain(JSON.stringify(" \tbad\n"));
  });
  test("arg-parser wrappers preserve independent option labels", () => {
    const limit = positiveIntOption("--limit");
    const turns = positiveIntOption("--max-turns");
    expect(limit(" 15 ")).toBe(15);
    expect(turns("20")).toBe(20);
    expect(() => limit("bad")).toThrow(/--limit/);
    expect(() => turns("bad")).toThrow(/--max-turns/);
  });
  test("owned exact large decimal value is returned without invoking a consumer", () => {
    expect(parsePositiveInt("9007199254740991", "--limit")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parsePositiveInt("0002147483648", "--limit")).toBe(2147483648);
  });
});
