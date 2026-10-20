import { expect, mock, test } from "bun:test";
import { getGraphemeSegmenter } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/utils/intl.ts";

// Only the actual Intl helper is exposed through this import boundary. The Core
// internal barrel, DOM, Yoga, screen writer and native terminal are not loaded.
mock.module("@cjhyy/code-shell-core/internal", () => ({ getGraphemeSegmenter }));
const { expandTabs } = await import("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/tabstops.ts");
const { stringWidth } = await import("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/render/stringWidth.ts");

const red = "\x1b[31m";
const reset = "\x1b[0m";

test("strings without tabs retain exact bytes including ANSI and newlines", () => {
  for (const input of ["", "ASCII", "中 e\u0301 👩‍💻", "a\nb", `${red}red${reset}`]) {
    expect(expandTabs(input)).toBe(input);
  }
});
test("default tab stops cover leading, consecutive and exact-boundary cases", () => {
  expect(expandTabs("\tZ")).toBe("        Z");
  expect(expandTabs("a\tZ")).toBe("a       Z");
  expect(expandTabs("\t\tZ")).toBe("                Z");
  expect(expandTabs("abcdefgh\tZ")).toBe("abcdefgh        Z");
});
test("newlines reset the tab column on each line", () => {
  expect(expandTabs("abc\tZ\nx\tY")).toBe("abc     Z\nx       Y");
  expect(expandTabs("\t\n\t")).toBe("        \n        ");
});
test("explicit positive tab interval is distinct from the production default", () => {
  expect(expandTabs("a\tZ", 4)).toBe("a   Z");
  expect(expandTabs("abcd\tZ", 4)).toBe("abcd    Z");
  expect(expandTabs("a\tZ")).toBe("a       Z");
});
test("complete SGR sequences survive while ASCII columns determine tabs", () => {
  expect(expandTabs(`${red}ab${reset}\tZ`)).toBe(`${red}ab${reset}      Z`);
  expect(expandTabs(`a${red}b${reset}\tZ`)).toBe(`a${red}b${reset}      Z`);
});
test("CJK and decomposed Latin controls use display columns", () => {
  expect(expandTabs("中\tZ")).toBe("中      Z");
  expect(expandTabs("e\u0301\tZ")).toBe("e\u0301       Z");
  expect(stringWidth("中")).toBe(2);
  expect(stringWidth("e\u0301")).toBe(1);
});
test("complete OSC 8 hyperlink sequences preserve bytes and add zero columns", () => {
  const open = "\x1b]8;;https://example.invalid/owned\x1b\\";
  const close = "\x1b]8;;\x1b\\";
  expect(expandTabs(`${open}ab${close}\tZ`)).toBe(`${open}ab${close}      Z`);
});
test("candidate: relative measurement is smaller than static screen-origin arithmetic", () => {
  const text = "aaaaaaa\tX";
  const measured = stringWidth(expandTabs(text));
  const staticScreenOrigin = 5;
  const prefixWidth = 7;
  // Arithmetic from output.ts:682-683 only; the real writer is not invoked.
  const spacesAtAbsoluteOrigin = 8 - ((staticScreenOrigin + prefixWidth) % 8);
  const relativeWidthAtAbsoluteOrigin = prefixWidth + spacesAtAbsoluteOrigin + 1;
  expect(measured).toBe(9);
  expect(relativeWidthAtAbsoluteOrigin).toBe(12);
  expect(relativeWidthAtAbsoluteOrigin).toBeGreaterThan(measured);
  console.log("TAB_ORIGIN_OBSERVATION", JSON.stringify({ text, measured, staticScreenOrigin, spacesAtAbsoluteOrigin, relativeWidthAtAbsoluteOrigin, screenWriterExecuted: false }));
});
test("candidate: a hand-built SGR boundary inside a ZWJ cluster changes tab padding", () => {
  const plain = "👩‍💻\tZ";
  const styled = `👩${red}‍💻${reset}\tZ`;
  const plainResult = expandTabs(plain);
  const styledResult = expandTabs(styled);
  expect(plainResult).toBe("👩‍💻      Z");
  expect(styledResult).toBe(`👩${red}‍💻${reset}    Z`);
  expect(styledResult.replaceAll(red, "").replaceAll(reset, "")).not.toBe(plainResult);
  console.log("TAB_GRAPHEME_OBSERVATION", JSON.stringify({ plainResult, styledResult, plainPrefixWidth: stringWidth("👩‍💻"), styledPrefixWidth: stringWidth(`👩${red}‍💻${reset}`), firstTokenWidth: stringWidth("👩"), secondTokenWidth: stringWidth("‍💻"), actualStyledResultWidth: stringWidth(styledResult), ordinaryProducerExecuted: false }));
});
