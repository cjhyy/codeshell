import { describe, it, expect } from "bun:test";
import { applyBuiltinOverrideVisibility } from "../engine.js";
import type { CapabilityOverride } from "../../settings/schema.js";

/**
 * #7: a project builtin override of `off` must HIDE that builtin from the
 * turn's tool list (applied per-turn, since the registry's builtin SET is
 * ctor-frozen). `on` / `inherit` / absent keep the tool. This mirrors how
 * skills/plugins/agents `off` overrides apply mid-session.
 */
type Tool = { name: string };

describe("applyBuiltinOverrideVisibility (#7)", () => {
  const tools: Tool[] = [{ name: "Bash" }, { name: "Read" }, { name: "WebSearch" }];

  it("hides a builtin whose project override is `off` (hot toggle)", () => {
    const override: Record<string, CapabilityOverride> = { Bash: "off" };
    const out = applyBuiltinOverrideVisibility(tools, override);
    expect(out.map((t) => t.name)).toEqual(["Read", "WebSearch"]);
  });

  it("keeps tools marked `on` or `inherit`", () => {
    const override: Record<string, CapabilityOverride> = { Bash: "on", Read: "inherit" };
    const out = applyBuiltinOverrideVisibility(tools, override);
    expect(out.map((t) => t.name)).toEqual(["Bash", "Read", "WebSearch"]);
  });

  it("no override → list unchanged (zero regression)", () => {
    expect(applyBuiltinOverrideVisibility(tools, undefined)).toEqual(tools);
  });

  it("hides multiple `off` builtins at once", () => {
    const override: Record<string, CapabilityOverride> = { Bash: "off", WebSearch: "off" };
    const out = applyBuiltinOverrideVisibility(tools, override);
    expect(out.map((t) => t.name)).toEqual(["Read"]);
  });
});
