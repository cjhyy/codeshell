import { describe, expect, test } from "bun:test";
import { buildPresetSystemPrompt, BUILTIN_AGENT_PRESETS } from "./index.js";

const preset = BUILTIN_AGENT_PRESETS["terminal-coding"];
const MARK = "## Browser automation";

describe("browser prompt section is one on/off unit with the browser tools", () => {
  test("included when a browser tool is active", () => {
    const out = buildPresetSystemPrompt(preset, ["browser_observe", "browser_act", "browser_navigate", "Read"]);
    expect(out).toContain(MARK);
  });

  test("dropped when NO browser tool is active (capability off)", () => {
    const out = buildPresetSystemPrompt(preset, ["Read", "Bash", "Edit"]);
    expect(out).not.toContain(MARK);
    // other sections still present
    expect(out).toContain("Coding tools");
  });

  test("included if even one browser tool survives", () => {
    const out = buildPresetSystemPrompt(preset, ["browser_navigate"]);
    expect(out).toContain(MARK);
  });

  test("no activeToolNames → all sections (generic/preview prompt)", () => {
    const out = buildPresetSystemPrompt(preset);
    expect(out).toContain(MARK);
  });
});
