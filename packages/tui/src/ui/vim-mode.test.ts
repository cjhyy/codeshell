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

  // Regression (review-2026-06-17): word motions w/e reused the same
  // Math.min(i, length-1) that yielded -1 on empty text — the helper fix was
  // missed when l/x were patched. They must clamp to 0 like l.
  test("'w' on empty text keeps cursor at 0, not -1", () => {
    const r = processVimKey("w", "w", "", st({ cursor: 0 }));
    expect(r.state.cursor).toBe(0);
  });

  test("'e' on empty text keeps cursor at 0, not -1", () => {
    const r = processVimKey("e", "e", "", st({ cursor: 0 }));
    expect(r.state.cursor).toBe(0);
  });

  test("'w' in visual mode on empty text keeps cursor at 0", () => {
    const r = processVimKey("w", "w", "", st({ mode: "visual", cursor: 0 }));
    expect(r.state.cursor).toBe(0);
  });
});

// Regression (review-2026-06-17): 'o' left the cursor at the old position
// instead of moving onto the newly opened line; 'p' didn't advance the cursor
// past the pasted text. Both broke subsequent edit positions.
describe("vim-mode o/p cursor semantics", () => {
  test("'o' moves cursor onto the new line", () => {
    const r = processVimKey("o", "o", "ab", st({ cursor: 0 }));
    expect(r.text).toBe("ab\n");
    expect(r.state.mode).toBe("insert");
    expect(r.state.cursor).toBe(r.text.length); // on the opened line
  });

  test("'p' advances cursor to the last pasted char", () => {
    const r = processVimKey("p", "p", "abc", st({ cursor: 0, register: "XY" }));
    // paste after cursor 0 → "aXYbc"; cursor lands on 'Y' (the last pasted char)
    expect(r.text).toBe("aXYbc");
    expect(r.state.cursor).toBe(2); // index of 'Y' in "aXYbc"
  });

  test("'p' with empty register doesn't move the cursor", () => {
    const r = processVimKey("p", "p", "abc", st({ cursor: 1, register: "" }));
    expect(r.text).toBe("abc");
    expect(r.state.cursor).toBe(1);
  });
});
