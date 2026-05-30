import { describe, test, expect } from "bun:test";
import { processVimKey, createVimState, type VimState } from "./vim-mode.js";

// Regression (review-2026-05-30): on empty text, `l` set cursor to
// Math.min(text.length-1, …) = -1 (normal & visual mode). And `x` could leave
// the cursor one past the new end after deleting the last char. Cursor must
// stay in [0, max(0, length-1)] in normal/visual mode.

function st(over: Partial<VimState> = {}): VimState {
  return { ...createVimState(), mode: "normal", cursor: 0, ...over };
}

describe("vim-mode cursor bounds", () => {
  test("'l' on empty text keeps cursor at 0, not -1", () => {
    const r = processVimKey("l", "l", "", st({ cursor: 0 }));
    expect(r.state.cursor).toBe(0);
  });

  test("'l' in visual mode on empty text keeps cursor at 0", () => {
    const r = processVimKey("l", "l", "", st({ mode: "visual", cursor: 0 }));
    expect(r.state.cursor).toBe(0);
  });

  test("'l' does not move past the last char", () => {
    const r = processVimKey("l", "l", "abc", st({ cursor: 2 }));
    expect(r.state.cursor).toBe(2); // length-1
  });

  test("'x' deleting the last char re-clamps the cursor into range", () => {
    const r = processVimKey("x", "x", "ab", st({ cursor: 1 }));
    expect(r.text).toBe("a");
    expect(r.state.cursor).toBeLessThanOrEqual(Math.max(0, r.text.length - 1));
  });

  test("'x' on the only char leaves empty text with cursor 0", () => {
    const r = processVimKey("x", "x", "a", st({ cursor: 0 }));
    expect(r.text).toBe("");
    expect(r.state.cursor).toBe(0);
  });
});
