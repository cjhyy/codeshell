import { describe, test, expect } from "bun:test";
import { PICKER_SCRIPT } from "./pickerScript";

// The picker runs inside the <webview> guest, so there's no DOM here to
// execute it against (bun test has no document). These assertions pin the
// three selector-strategy properties that fixed「圈刚选完就报元素未能重新
// 定位」on Tailwind pages — if someone simplifies them away, this fails.
describe("PICKER_SCRIPT selector strategy", () => {
  test("escapes class names (Tailwind `hover:x` / `p-1.5` would break querySelector)", () => {
    expect(PICKER_SCRIPT).toContain("CSS.escape");
    expect(PICKER_SCRIPT).toContain("map(cssEsc)");
  });

  test("verifies the candidate selector round-trips at pick time", () => {
    expect(PICKER_SCRIPT).toContain("document.querySelector(sel) === el");
  });

  test("falls back to an exact positional nth-child chain", () => {
    expect(PICKER_SCRIPT).toContain("nth-child");
    expect(PICKER_SCRIPT).toContain("positionalPath");
  });

  test("returns a readable labelHint separate from the stored selector", () => {
    expect(PICKER_SCRIPT).toContain("labelHint");
  });

  test("is a single expression resolving a Promise (executeJavaScript contract)", () => {
    expect(PICKER_SCRIPT.trim().startsWith("(() => new Promise")).toBe(true);
    expect(PICKER_SCRIPT.trim().endsWith("}))()")).toBe(true);
  });
});
