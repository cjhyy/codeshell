/**
 * Single first-run audit characterization of one source-extracted pure predicate.
 * The actual bidi.ts export, reorderBidi, bidi-js, needsBidi, process platform/env
 * gate, Output, Core, Ink, and terminal rendering are NEVER imported or executed.
 * Only the exact frozen-source function has its two TS signature annotations
 * removed, then is compiled. The regex/body are unchanged.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sourcePath = "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/bidi.ts";
const raw = readFileSync(sourcePath);
const expectedSourceSha = "561670cc97aaba05770800bd15e13021c817f550a3438f8800a57073faf988aa";
if (createHash("sha256").update(raw).digest("hex") !== expectedSourceSha) {
  throw new Error("Frozen bidi.ts source bytes changed; do not execute stale extraction.");
}
const source = raw.toString("utf8");
const originalHeader = "function hasRTLCharacters(text: string): boolean {";
const original = source.slice(source.indexOf(originalHeader)).trim();
const compiled = original.replace(originalHeader, "function hasRTLCharacters(text) {");
const predicate = new Function(`${compiled}\nreturn hasRTLCharacters;`)() as (text: string) => boolean;

describe("frozen-source predicate only; no platform gate or actual module", () => {
  test("pins exact function body and confirms Unicode escapes are single slashes", () => {
    expect(createHash("sha256").update(original).digest("hex")).toBe("93fbb4adb16d88450a66eb66065f36df95fb8253e511303c82453337558c85ae");
    const regexLine = source.split("\n")[136]!;
    const start = regexLine.indexOf("\\");
    expect([...Buffer.from(regexLine.slice(start, start + 6))]).toEqual([92, 117, 48, 53, 57, 48]);
    expect(regexLine.includes("\\\\u")).toBe(false);
  });

  test("ordinary Hebrew and Arabic strings are detected", () => {
    expect(predicate("שלום")).toBe(true);
    expect(predicate("مرحبا")).toBe(true);
    expect(predicate("שָׁלוֹם")).toBe(true);
    expect(predicate("مَرْحَبًا")).toBe(true);
  });

  test("listed Syriac and Thaana characters are detected", () => {
    expect(predicate("\u0710\u0712")).toBe(true);
    expect(predicate("\u0780\u0781")).toBe(true);
  });

  test("ASCII uppercase, digits, slash and literal escape text do not falsely trigger", () => {
    expect(predicate("ABC 123")).toBe(false);
    expect(predicate("hello")).toBe(false);
    expect(predicate("\\u0590")).toBe(false);
    expect(predicate("(hello) / \\")).toBe(false);
  });

  test("empty, Chinese and supplementary emoji are unchanged negative controls", () => {
    expect(predicate("")).toBe(false);
    expect(predicate("你好")).toBe(false);
    expect(predicate("👩‍💻")).toBe(false);
  });

  test("mixed ordinary Hebrew/Arabic and Latin still trigger", () => {
    expect(predicate("hello שלום")).toBe(true);
    expect(predicate("مرحبا world")).toBe(true);
  });

  test("candidate boundary: Adlam strong RTL letters miss the hard-coded ranges", () => {
    const adlam = "\u{1E900}\u{1E901}";
    expect([...adlam].map((c) => c.codePointAt(0))).toEqual([0x1e900, 0x1e901]);
    expect(predicate(adlam)).toBe(false);
    expect(predicate(`${adlam} שלום`)).toBe(true);
  });
});
