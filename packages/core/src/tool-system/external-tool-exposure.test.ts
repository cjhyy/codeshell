/**
 * The phase-one allowlist is a security decision, so it gets assertions rather
 * than only a review. These tests pin the decisions themselves — adding a tool
 * to the exposed set should require deliberately editing a test that spells out
 * why it was excluded.
 */
import { describe, expect, test } from "bun:test";
import { FIRST_PHASE_EXPOSURE, FIRST_PHASE_EXPOSURE_RATIONALE } from "./external-tool-exposure.js";
import { createSessionToolHost } from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";
import { BUILTIN_AGENT_PRESETS } from "../preset/index.js";

describe("first-phase external tool exposure", () => {
  test("exposes exactly the reviewed set", () => {
    // Pinned as an exact list, not a size or a subset check: both of those let a
    // tool be swapped in silently. Changing this list should be a visible diff
    // next to the rationale entry that justifies it.
    expect([...FIRST_PHASE_EXPOSURE.toolNames].sort()).toEqual(
      [
        "Bash",
        "Browser",
        "Edit",
        "Glob",
        "Grep",
        "InjectCredential",
        "MemoryDelete",
        "MemoryList",
        "MemoryRead",
        "MemorySave",
        "Panel",
        "Read",
        "Skill",
        "SwitchSessionWorkspace",
        "TodoWrite",
        "WebFetch",
        "WebSearch",
        "Write",
      ].sort(),
    );
  });

  test("keeps the structurally-excluded tools out", () => {
    // These four are NOT held back out of caution — widening the allowlist would
    // not make them work (recursion with no owner to charge; plan state the
    // external path does not have). Adding one means designing that first, so
    // this test should be confronted, not edited away.
    for (const name of ["Agent", "DriveAgent", "EnterPlanMode", "ExitPlanMode"]) {
      expect(FIRST_PHASE_EXPOSURE.toolNames.has(name)).toBe(false);
    }
  });

  test("InjectCredential is exposed only while its in-tool approval is mandatory", () => {
    // The allowlist is NOT what makes this tool safe — its own approval is. That
    // makes the two facts a pair, and this test is the place the pairing is
    // recorded: if the tool ever stops requiring approval, the rationale here is
    // void and the entry must go back to excluded.
    const entry = FIRST_PHASE_EXPOSURE_RATIONALE.find((e) => e.tool === "InjectCredential");
    expect(entry?.status).toBe("exposed");
    expect(entry?.reason).toMatch(/approval/i);
    expect(entry?.reason).toMatch(/excluded/i);
  });

  test("every rationale entry is non-empty and consistently classified", () => {
    for (const entry of FIRST_PHASE_EXPOSURE_RATIONALE) {
      expect(entry.reason.length).toBeGreaterThan(30);
      expect(["exposed", "deferred", "excluded"]).toContain(entry.status);
      expect(["self-contained", "host-loopback"]).toContain(entry.kind);
    }
    // The exposed set must be derived from the rationale, never drift from it.
    const exposed = FIRST_PHASE_EXPOSURE_RATIONALE.filter((e) => e.status === "exposed").map(
      (e) => e.tool,
    );
    expect([...FIRST_PHASE_EXPOSURE.toolNames].sort()).toEqual(exposed.sort());
  });

  test("Panel is narrowed to read-only actions, and invoke cannot slip through", async () => {
    const registry = new ToolRegistry({ builtinTools: ["Panel"] });
    const panelCalls: string[] = [];
    const host = createSessionToolHost({
      businessSessionId: "sess-policy",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
      projectTrusted: true,
      planMode: false,
      exposure: FIRST_PHASE_EXPOSURE,
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
      contextOverrides: {
        panels: {
          list: async () => {
            panelCalls.push("list");
            return { items: [{ id: "quickChat", title: "Quick chat", source: "builtin" }] };
          },
          open: async (panelId: string) => {
            panelCalls.push(`open:${panelId}`);
            return { ok: true, panelId };
          },
          tools: async () => {
            panelCalls.push("tools");
            return { items: [] };
          },
          invoke: async (panelId: string, toolName: string) => {
            panelCalls.push(`invoke:${panelId}:${toolName}`);
            return { ok: true, panelId, toolName, result: null };
          },
        },
      } as never,
    });

    const listed = await host.execute({ id: "p1", name: "Panel", input: { action: "list" } });
    expect(listed.isError).toBeFalsy();
    expect(panelCalls).toContain("list");

    // The one that matters: invoke is blocked by the exposure policy, so the
    // Panel bridge is never even reached.
    const invoked = await host.execute({
      id: "p2",
      name: "Panel",
      input: { action: "invoke", panel_id: "quickChat", tool_name: "danger" },
    });
    expect(invoked.isError).toBe(true);
    expect(panelCalls.some((c) => c.startsWith("invoke"))).toBe(false);
  });

  test("the policy singleton cannot be widened at runtime", async () => {
    // `ReadonlySet`/`ReadonlyMap` are compile-time only. This object is a
    // process-wide singleton that execute() reads live, so a mutation anywhere
    // would retroactively widen every running host — including re-enabling
    // Panel.invoke, the one capability deliberately held back.
    const names = FIRST_PHASE_EXPOSURE.toolNames as Set<string>;
    const patterns = FIRST_PHASE_EXPOSURE.argsPatterns as Map<string, unknown>;

    // The obvious spellings.
    expect(() => names.add("DriveAgent")).toThrow(/frozen/i);
    expect(() => names.delete("Panel")).toThrow(/frozen/i);
    expect(() => patterns.delete("Panel")).toThrow(/frozen/i);
    expect(() => patterns.set("Panel", {})).toThrow(/frozen/i);

    // …and the ways round them. Shadowing `add` on a real Set is not enough:
    // the prototype method stays reachable and `delete s.add` un-shadows it.
    // These must fail because the object is not a Set at all.
    expect(() => Set.prototype.add.call(names, "DriveAgent")).toThrow();
    expect(() => Map.prototype.set.call(patterns, "Panel", { action: ".*" })).toThrow();
    expect(() => {
      // @ts-expect-error deliberately probing the un-shadowing route
      delete names.add;
      names.add("DriveAgent");
    }).toThrow();

    // forEach hands the callback the collection as its third argument. Passing
    // the real backing Set/Map there would leak a live mutable handle through
    // the public frozen API — one line, no prototype tricks:
    //   policy.forEach((_a, _b, s) => s.add("DriveAgent"))
    expect(() =>
      (FIRST_PHASE_EXPOSURE.toolNames as Set<string>).forEach((_a, _b, s) =>
        (s as Set<string>).add("DriveAgent"),
      ),
    ).toThrow(/frozen/i);
    expect(() =>
      (FIRST_PHASE_EXPOSURE.argsPatterns as Map<string, unknown>).forEach((_v, _k, m) =>
        (m as Map<string, unknown>).delete("Panel"),
      ),
    ).toThrow(/frozen/i);

    // The nested pattern object is frozen too, so the action regex itself can't
    // be swapped for a permissive one.
    expect(Object.isFrozen(FIRST_PHASE_EXPOSURE.argsPatterns?.get("Panel"))).toBe(true);

    // …and the policy still behaves after all those rejected attempts.
    expect(FIRST_PHASE_EXPOSURE.toolNames.has("Panel")).toBe(true);
    expect(FIRST_PHASE_EXPOSURE.toolNames.has("DriveAgent")).toBe(false);
  });

  test("an action that merely contains an allowed word is still rejected", async () => {
    // Guards against an unanchored pattern: "invoke_list" must not pass because
    // it contains "list".
    const registry = new ToolRegistry({ builtinTools: ["Panel"] });
    const host = createSessionToolHost({
      businessSessionId: "sess-anchor",
      cwd: process.cwd(),
      registry,
      permissionMode: "default",
      presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
      projectTrusted: true,
      planMode: false,
      exposure: FIRST_PHASE_EXPOSURE,
      visibility: { cwd: process.cwd(), hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
    });
    for (const action of ["invoke_list", "listx", "xopen"]) {
      const result = await host.execute({ id: "p3", name: "Panel", input: { action } });
      expect(result.isError).toBe(true);
    }
  });
});
