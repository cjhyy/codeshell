import { describe, expect, test } from "bun:test";
import { planWorkspaceProfileSwitch } from "./switch-plan.js";
import { WorkspaceProfileSchema } from "./types.js";
import { workspaceProfileActivationSubtree } from "./activation.js";

const profile = (name: string, fields = {}) =>
  WorkspaceProfileSchema.parse({ name, label: name, basePreset: "legacy", ...fields });

describe("Profile switch configuration plan", () => {
  test("reuses activation semantics and direct overrides beat both profiles", () => {
    const old = profile("old", { skills: ["old-skill"] });
    const next = profile("next", { skills: ["next-skill"], exclusiveCapabilities: true });
    const plan = planWorkspaceProfileSwitch({
      current: workspaceProfileActivationSubtree(old),
      currentProfile: old,
      nextProfile: next,
      installed: { skills: ["old-skill", "next-skill"], plugins: ["other"] },
      exclusiveInventory: { skills: ["old-skill", "next-skill"] },
      directOverrides: { skills: { "old-skill": "on", "next-skill": "off" } },
      capabilities: [
        { kind: "skill", name: "old-skill", enabled: false },
        { kind: "skill", name: "next-skill", enabled: true },
        { kind: "plugin", name: "other", enabled: true },
      ],
    });
    expect(plan.subtree).toEqual(
      workspaceProfileActivationSubtree(next, { skills: ["old-skill", "next-skill"] }),
    );
    expect(plan.subtree?.preset).toBe("general");
    expect(plan.subtree?.overrides?.plugins).toBeUndefined();
    expect(plan.impact.capabilities).toEqual([]);
  });

  test("deactivation falls back to baseline plus direct settings and only removes the Profile memory mount", () => {
    const old = profile("old", {
      skills: ["a"],
      portableMemory: true,
      mainInstruction: "private-role",
    });
    const plan = planWorkspaceProfileSwitch({
      current: workspaceProfileActivationSubtree(old),
      currentProfile: old,
      installed: { skills: ["a"] },
      capabilities: [{ kind: "skill", name: "a", enabled: false }],
    });
    expect(plan.subtree).toBeUndefined();
    expect(plan.impact.after).toBeNull();
    expect(plan.impact.memory).toEqual({ before: "old", after: null });
    expect(plan.impact.instruction).toEqual({ changed: true, beforeLength: 12, afterLength: 0 });
    expect(plan.impact.capabilities).toEqual([
      { kind: "skill", name: "a", before: true, after: false },
    ]);
    expect(JSON.stringify(plan.impact)).not.toContain("private-role");
  });

  test("missing declarations are distinct from existing capability configuration differences", () => {
    const plan = planWorkspaceProfileSwitch({
      nextProfile: profile("next", { skills: ["present", "absent"], mcp: ["not-configured"] }),
      installed: { skills: ["present"] },
      capabilities: [{ kind: "skill", name: "present", enabled: false }],
    });
    expect(plan.impact.capabilities).toEqual([
      { kind: "skill", name: "present", before: false, after: true },
    ]);
    expect(plan.impact.missingDeclarations).toEqual([
      { kind: "skill", name: "absent" },
      { kind: "mcp", name: "not-configured" },
    ]);
  });
});
