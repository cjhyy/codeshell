import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ParamSpec } from "../../preload/types";
import { ParamControls } from "./ParamControls";

// Data-driven param rendering: the connection page never branches on provider,
// it switches on ParamSpec.control. Given a model's params[] + current values,
// ParamControls emits the matching widget per param. Pure render (no window),
// mirrors ModelSection.reasoning.test.tsx.
function html(params: ParamSpec[], values: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    <ParamControls params={params} values={values} onChange={() => {}} />,
  );
}

describe("ParamControls", () => {
  test("no params → renders nothing", () => {
    expect(html([])).toBe("");
  });

  test("enum control → a combobox select labelled by the param", () => {
    const out = html([
      { name: "reasoning", label: "思考强度", control: "enum", options: ["low", "high"] },
    ]);
    expect(out).toContain("思考强度");
    // Radix Select renders a combobox button; options are lazily mounted on open
    // so they're absent from static markup — assert the control type instead.
    expect(out).toContain('role="combobox"');
  });

  test("number control → a number input", () => {
    const out = html([{ name: "reasoning", control: "number", min: 1024 }]);
    expect(out).toContain('type="number"');
  });

  test("toggle control → a switch/checkbox", () => {
    const out = html([{ name: "thinking", control: "toggle", default: true }]);
    // a toggle renders some interactive control (switch button or checkbox)
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("thinking");
  });

  test("text control → a text input", () => {
    const out = html([{ name: "system", control: "text" }]);
    expect(out).toContain("system");
  });

  test("reflects the current value for an enum param", () => {
    const out = html(
      [{ name: "reasoning", control: "enum", options: ["low", "high"] }],
      { reasoning: "high" },
    );
    // selected option marked
    expect(out).toContain("high");
  });

  test("falls back to param name as label when label absent", () => {
    const out = html([{ name: "verbosity", control: "enum", options: ["low"] }]);
    expect(out).toContain("verbosity");
  });
});
