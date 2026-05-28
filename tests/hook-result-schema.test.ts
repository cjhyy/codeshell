import { describe, expect, test } from "bun:test";
import { shaMatches } from "../packages/core/src/plugins/pluginInstaller.js";
import { validateHookResult } from "../packages/core/src/hooks/shell-runner.js";

/**
 * Task 7 — supply-chain check: a marketplace entry that pins `sha` must
 * fail install if the cloned HEAD doesn't match. The classifier behaviour
 * is unit-tested here; the install-path call sites are exercised by the
 * existing plugin tests under tests/plugins-*.
 */

describe("shaMatches", () => {
  const FULL = "abcdef1234567890abcdef1234567890abcdef12";

  test("full SHA matches itself", () => {
    expect(shaMatches(FULL, FULL)).toBe(true);
  });

  test("12-char prefix (the conventional short form) matches the full SHA", () => {
    expect(shaMatches(FULL.slice(0, 12), FULL)).toBe(true);
  });

  test("7-char prefix is the minimum accepted length", () => {
    expect(shaMatches(FULL.slice(0, 7), FULL)).toBe(true);
  });

  test("6-char prefix is refused (too collision-prone)", () => {
    expect(shaMatches(FULL.slice(0, 6), FULL)).toBe(false);
  });

  test("declared > 40 chars is refused (not a valid SHA)", () => {
    expect(shaMatches(FULL + "00", FULL)).toBe(false);
  });

  test("mismatching prefix → false", () => {
    expect(shaMatches("deadbeef", FULL)).toBe(false);
  });

  test("case-insensitive", () => {
    expect(shaMatches(FULL.toUpperCase(), FULL.toLowerCase())).toBe(true);
  });

  test("trims whitespace on either side", () => {
    expect(shaMatches(`  ${FULL.slice(0, 12)}  `, `  ${FULL}\n`)).toBe(true);
  });

  test("non-string inputs are refused", () => {
    expect(shaMatches(undefined as unknown as string, FULL)).toBe(false);
    expect(shaMatches(FULL, null as unknown as string)).toBe(false);
  });
});

describe("validateHookResult", () => {
  test("accepts empty object", () => {
    expect(validateHookResult({})).toEqual({});
  });

  test("accepts a typical permission decision", () => {
    const r = validateHookResult({ decision: "deny", messages: ["why"] });
    expect(r).toEqual({ decision: "deny", messages: ["why"] });
  });

  test("accepts all valid decision values", () => {
    expect(validateHookResult({ decision: "allow" })).not.toBeNull();
    expect(validateHookResult({ decision: "deny" })).not.toBeNull();
    expect(validateHookResult({ decision: "ask" })).not.toBeNull();
  });

  test("rejects bogus decision value", () => {
    expect(validateHookResult({ decision: "maybe" })).toBeNull();
  });

  test("rejects unknown top-level key (typo / hostile payload)", () => {
    // 'messsages' (sic) — protects against handlers that drift from the
    // contract and silently no-op.
    expect(validateHookResult({ messsages: ["typo"] })).toBeNull();
  });

  test("rejects non-array messages", () => {
    expect(validateHookResult({ messages: "single string" })).toBeNull();
  });

  test("rejects non-string element in messages array", () => {
    expect(validateHookResult({ messages: ["ok", 42] })).toBeNull();
  });

  test("rejects array as the top-level result", () => {
    expect(validateHookResult([])).toBeNull();
  });

  test("rejects primitive top-level result", () => {
    expect(validateHookResult(true)).toBeNull();
    expect(validateHookResult("ok")).toBeNull();
    expect(validateHookResult(null)).toBeNull();
  });

  test("accepts updatedInput / updatedPrompt / additionalContext / stop / data", () => {
    const r = validateHookResult({
      stop: false,
      data: { foo: "bar" },
      updatedInput: { x: 1 },
      additionalContext: "hi",
      updatedPrompt: "go",
    });
    expect(r).not.toBeNull();
  });

  test("rejects updatedInput as array (must be object)", () => {
    expect(validateHookResult({ updatedInput: ["arr"] })).toBeNull();
  });

  test("rejects non-boolean stop", () => {
    expect(validateHookResult({ stop: "yes" })).toBeNull();
  });
});
