import { describe, it, expect } from "bun:test";
import { resolveChildToolScope } from "./engine.js";

// A child sub-agent must never be able to spawn OR continue another sub-agent
// (flat hierarchy). resolveChildToolScope enforces this by forcing the
// nested-agent tools — Agent, AgentStatus, AgentCancel, AND AgentSendInput —
// into the child's disabled set and out of any allowlist.
describe("resolveChildToolScope — no nested agent tools (incl. AgentSendInput)", () => {
  it("forces all nested-agent tools into disabled when inheriting parent scope", () => {
    const { disabled } = resolveChildToolScope(undefined, [], undefined);
    expect(disabled).toContain("Agent");
    expect(disabled).toContain("AgentStatus");
    expect(disabled).toContain("AgentCancel");
    expect(disabled).toContain("AgentSendInput");
  });

  it("strips nested-agent tools from an explicit allowlist", () => {
    const { enabled, disabled } = resolveChildToolScope(
      ["Read", "Agent", "AgentSendInput", "Grep"],
      undefined,
      undefined,
    );
    expect(enabled).toEqual(["Read", "Grep"]);
    expect(enabled).not.toContain("AgentSendInput");
    expect(disabled).toContain("AgentSendInput");
  });
});
