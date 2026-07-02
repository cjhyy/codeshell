import { describe, test, expect } from "bun:test";
import { utf8SafeCutLength } from "./utf8-cut.js";

/**
 * BashOutput paginates a large burst by cutting the raw buffer at a byte cap.
 * A hard cut can split a multibyte UTF-8 character, producing `�` in the text
 * fed to the model AND (since consumedBytes advances by the cut length) it
 * matters that the cut lands on a char boundary so the next read resumes
 * cleanly. utf8SafeCutLength backs the cut off to the last complete character.
 */
describe("utf8SafeCutLength", () => {
  test("returns maxBytes unchanged when the cut lands on a boundary (ASCII)", () => {
    const buf = Buffer.from("abcdefgh", "utf8");
    expect(utf8SafeCutLength(buf, 4)).toBe(4);
  });

  test("backs off when the cut would split a 3-byte char (CJK)", () => {
    // "中" is 3 bytes (E4 B8 AD). Cap at 2 lands mid-char → back off to 0.
    const buf = Buffer.from("中文", "utf8"); // 6 bytes
    expect(utf8SafeCutLength(buf, 2)).toBe(0);
    // Cap at 4 lands one byte into the 2nd char → back off to 3 (end of "中").
    expect(utf8SafeCutLength(buf, 4)).toBe(3);
    // Cap exactly on the boundary stays.
    expect(utf8SafeCutLength(buf, 3)).toBe(3);
    expect(utf8SafeCutLength(buf, 6)).toBe(6);
  });

  test("backs off for a 4-byte char (emoji)", () => {
    // "😀" is 4 bytes (F0 9F 98 80).
    const buf = Buffer.from("😀x", "utf8"); // 5 bytes
    expect(utf8SafeCutLength(buf, 1)).toBe(0);
    expect(utf8SafeCutLength(buf, 2)).toBe(0);
    expect(utf8SafeCutLength(buf, 3)).toBe(0);
    expect(utf8SafeCutLength(buf, 4)).toBe(4);
    expect(utf8SafeCutLength(buf, 5)).toBe(5);
  });

  test("maxBytes >= length returns length", () => {
    const buf = Buffer.from("中", "utf8");
    expect(utf8SafeCutLength(buf, 10)).toBe(3);
  });

  test("decoding the safely-cut prefix never yields a replacement char", () => {
    const buf = Buffer.from("aaa中文字节界😀限", "utf8");
    for (let cap = 0; cap <= buf.length; cap++) {
      const n = utf8SafeCutLength(buf, cap);
      const decoded = buf.subarray(0, n).toString("utf8");
      expect(decoded).not.toContain("�");
    }
  });
});
