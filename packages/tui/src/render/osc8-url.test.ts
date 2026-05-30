import { describe, test, expect } from "bun:test";
import { sanitizeOsc8Url } from "./osc8-url.js";

// Regression: wrapWithOsc8Link interpolated a hyperlink URL raw into the OSC 8
// escape sequence (review-2026-05-30, security). A URL containing BEL (\x07,
// the OSC terminator) or ESC (\x1b) could terminate the sequence early and
// inject arbitrary terminal control sequences. sanitizeOsc8Url strips C0
// control chars + DEL.

describe("sanitizeOsc8Url", () => {
  test("passes a normal url unchanged", () => {
    expect(sanitizeOsc8Url("https://example.com/a?b=1#c")).toBe("https://example.com/a?b=1#c");
  });

  test("strips BEL (the OSC terminator)", () => {
    expect(sanitizeOsc8Url("https://x\x07evil")).toBe("https://xevil");
  });

  test("strips ESC", () => {
    expect(sanitizeOsc8Url("https://x\x1b[31mevil")).toBe("https://x[31mevil");
  });

  test("strips other C0 control chars and DEL", () => {
    expect(sanitizeOsc8Url("a\x00b\x09c\x7fd")).toBe("abcd");
  });
});
