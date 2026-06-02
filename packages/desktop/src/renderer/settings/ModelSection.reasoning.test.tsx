import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReasoningControl, ReasoningSetting } from "@cjhyy/code-shell-core";
import { renderReasoningControl } from "./ModelSection";

// The descriptor fetch (reasoningControlFor via preload) runs in a useEffect
// that renderToStaticMarkup never fires, so we test the pure renderer directly:
// given a ReasoningControl + saved value, it must emit the widget the control's
// kind describes. Mirrors capabilitiesOverview.test.ts (pure logic, no window).
function html(
  control: ReasoningControl,
  value?: ReasoningSetting,
): string {
  return renderToStaticMarkup(
    <>{renderReasoningControl(control, value, false, () => {})}</>,
  );
}

describe("renderReasoningControl", () => {
  test("none → renders nothing", () => {
    expect(html({ kind: "none" })).toBe("");
  });

  test("adaptive → read-only label, no input", () => {
    const out = html({ kind: "adaptive" });
    expect(out).toContain("自动思考(不可调)");
    expect(out).not.toContain("<input");
  });

  test("toggle → a checkbox, default-driven checked state", () => {
    const out = html({ kind: "toggle", default: true });
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("checked");
    expect(out).toContain("思考");
  });

  test("toggle → saved {mode:off} wins over default true (unchecked)", () => {
    const out = html({ kind: "toggle", default: true }, { mode: "off" });
    expect(out).not.toContain("checked");
  });

  test("effort → renders a Select combobox (not a checkbox/number input)", () => {
    // The radix Select trigger is a combobox button; the chosen label lives in
    // a portal that static markup omits, so we assert the widget kind here.
    const out = html({
      kind: "effort",
      options: ["low", "medium", "high", "xhigh"],
      default: "medium",
    });
    expect(out).toContain('role="combobox"');
    expect(out).not.toContain('type="checkbox"');
    expect(out).not.toContain('type="number"');
  });

  test("budget → a number input honoring min, default value", () => {
    const out = html({ kind: "budget", min: 1024, default: 4096 });
    expect(out).toContain('type="number"');
    expect(out).toContain('min="1024"');
    expect(out).toContain('value="4096"');
  });

  test("budget → saved budgetTokens overrides default", () => {
    const out = html(
      { kind: "budget", min: 1024, default: 4096 },
      { mode: "budget", budgetTokens: 8000 },
    );
    expect(out).toContain('value="8000"');
  });
});
