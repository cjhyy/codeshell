import { describe, test, expect } from "bun:test";
import { embedTextInBorder } from "./render-border.js";
import { stringWidth } from "./stringWidth.js";

// Regression: when the title was too wide it was cut with
// `text.substring(0, borderLength)` — a string-INDEX cut, which on ANSI-styled
// text counts escape bytes toward the limit (yielding too few visible cells)
// and can sever an escape sequence (review-2026-05-30). sliceAnsi cuts by
// visible width and keeps codes intact.
//
// Use raw ANSI literals — chalk is disabled (level 0) under the test runner,
// so chalk.red(...) would emit no codes and not exercise this path.
const RED = "\x1b[31m";
const RESET = "\x1b[39m";

describe("embedTextInBorder ANSI-safe truncation", () => {
  test("truncates styled text by visible width, not string index", () => {
    const styled = `${RED}${"X".repeat(50)}${RESET}`; // 50 visible cells + ANSI
    const border = "-".repeat(10); // forces the truncation branch
    const [, mid] = embedTextInBorder(border, styled, "center", 0, "-");
    // sliceAnsi keeps a full borderLength of VISIBLE cells; substring(0,10)
    // would spend 5 of those 10 chars on the "\x1b[31m" prefix → only 5 cells.
    expect(stringWidth(mid)).toBe(border.length);
  });

  test("plain text still truncates to the border width", () => {
    const [, mid] = embedTextInBorder("-".repeat(8), "X".repeat(40), "center", 0, "-");
    expect(stringWidth(mid)).toBeLessThanOrEqual(8);
  });
});
