import { describe, it, expect } from "bun:test";
import { resolveChildToolScope } from "../packages/core/src/engine/engine.ts";

describe("resolveChildToolScope", () => {
  const NESTED = ["Agent", "AgentStatus", "AgentCancel"];

  it("with no allowlist, inherits parent enabled/disabled minus nested tools", () => {
    const scope = resolveChildToolScope(undefined, ["Bash"], undefined);
    expect(scope.enabled).toBeUndefined();
    expect(scope.disabled).toEqual(expect.arrayContaining([...NESTED, "Bash"]));
  });

  it("with an allowlist, child enabled = allowlist minus nested tools", () => {
    const scope = resolveChildToolScope(["Read", "Grep", "Agent"], undefined, undefined);
    expect(scope.enabled).toEqual(["Read", "Grep"]);
    expect(scope.disabled).toEqual(expect.arrayContaining(NESTED));
  });

  it("role allowlist is independent of the parent's force-enabled additions", () => {
    const scope = resolveChildToolScope(["Read"], undefined, ["Bash", "Edit"]);
    expect(scope.enabled).toEqual(["Read"]);
  });

  it("role allowlist cannot restore a parent-disabled tool", () => {
    const scope = resolveChildToolScope(["Read", "Write"], ["Write"], []);
    expect(scope.enabled).toEqual(["Read"]);
    expect(scope.disabled).toContain("Write");
  });
});
