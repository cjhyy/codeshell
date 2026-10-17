import { describe, test, expect } from "bun:test";
import sliceAnsi from "../../../../packages/core/src/utils/sliceAnsi.ts";

// Characterization of frozen implementation, not proposed fixes. No renderer,
// terminal, Core barrel, fake dependencies, network, or native operation imported.
describe("sliceAnsi display-column contract", () => {
  test("ASCII controls match column ranges with and without ordinary SGR", () => {
    expect(sliceAnsi("abXYZ", 2, 5)).toBe("XYZ");
    expect(sliceAnsi("\x1b[31mabXYZ\x1b[39m", 2, 5)).toBe("\x1b[31mXYZ");
    expect(Bun.stringWidth("abXYZ")).toBe(5);
  });
  test("two CJK glyphs occupy four columns but helper drops two suffix letters", () => {
    const input = "中文XYZ";
    expect(Bun.stringWidth("中文")).toBe(4);
    expect(Bun.stringWidth(input)).toBe(7);
    const actual = sliceAnsi(input, 4, 7);
    expect(actual).toBe("Z");
    expect(actual).not.toBe("XYZ");
    expect(Bun.stringWidth(actual)).toBe(1);
    console.log("CJK_COLUMN_RANGE", JSON.stringify({input, start: 4, end: 7, expected: "XYZ", actual}));
  });
  test("ordinary SGR does not change the wrong CJK suffix indexing", () => {
    const actual = sliceAnsi("\x1b[31m中文XYZ\x1b[39m", 4, 7);
    expect(actual).toBe("\x1b[31mZ\x1b[39m");
    expect(Bun.stringWidth(actual)).toBe(1);
  });
  test("prefix end uses code units and exceeds the promised column width", () => {
    const actual = sliceAnsi("中文XYZ", 0, 4);
    expect(actual).toBe("中文XY");
    expect(Bun.stringWidth(actual)).toBe(6);
  });
  test("an ASCII prefix after a zero-width combining mark is likewise shifted", () => {
    const input = "e\u0301XYZ";
    expect(Bun.stringWidth("e\u0301")).toBe(1);
    expect(sliceAnsi(input, 1, 4)).toBe("\u0301XY");
  });
  test("complete SGR range ending at last visible char drops the closing reset", () => {
    const input = "\x1b[31mXYZ\x1b[39m";
    const actual = sliceAnsi(input, 0);
    expect(actual).toBe("\x1b[31mXYZ");
    expect(actual.endsWith("\x1b[39m")).toBe(false);
    console.log("SGR_TAIL", JSON.stringify({input, actual}));
  });
  test("reset before a selected final visible character is preserved", () => {
    expect(sliceAnsi("\x1b[31mX\x1b[39mY", 0)).toBe("\x1b[31mX\x1b[39mY");
    expect(sliceAnsi("", 0, 1)).toBe("");
  });
});
