/**
 * The user's own `settings.permissions.rules` must bind an external Agent
 * Runtime exactly as they bind the Native Engine.
 *
 * This started as a real divergence: `SessionToolHost` accepted a finished rule
 * array from its caller, and the easy mistake — assembling preset rules but not
 * reading settings — meant a user who wrote "deny Panel" saw the Native Engine
 * honor it while the external runtime happily ran the tool. Composition now
 * happens inside the host via the same `composePermissionRules()` the Engine
 * uses, so the two paths cannot drift.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionToolHost } from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";
import { composePermissionRules } from "../engine/permission-controller.js";
import { PermissionClassifier } from "./permission.js";
import type { BuiltinTool } from "./builtin/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A project whose settings deny one tool outright. */
function projectDenying(tool: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cs-settings-parity-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".code-shell"), { recursive: true });
  writeFileSync(
    join(dir, ".code-shell", "settings.json"),
    JSON.stringify({ permissions: { rules: [{ tool, decision: "deny" }] } }),
  );
  return dir;
}

function catalog(record: string[]): BuiltinTool[] {
  return [
    {
      definition: {
        name: "Watched",
        description: "A tool the user may choose to deny.",
        inputSchema: { type: "object", properties: {} },
        source: "builtin",
        permissionDefault: "allow",
        isReadOnly: true,
        isConcurrencySafe: true,
      },
      execute: async () => {
        record.push("Watched");
        return "ran";
      },
      exposure: {
        presetTags: ["general"],
        defaultPermissionRules: [{ tool: "Watched", decision: "allow" }],
      },
    },
  ] as unknown as BuiltinTool[];
}

const PRESET_RULES = [{ tool: "Watched", decision: "allow" as const }];

describe("settings parity between Native Engine and SessionToolHost", () => {
  test("a user deny rule blocks the external runtime too", async () => {
    const cwd = projectDenying("Watched");
    const record: string[] = [];
    const host = createSessionToolHost({
      businessSessionId: "sess-settings",
      cwd,
      registry: new ToolRegistry({ toolCatalog: catalog(record) }),
      permissionMode: "default",
      presetRules: PRESET_RULES,
      planMode: false,
      exposure: { mode: "allowlist", toolNames: new Set(["Watched"]) },
      visibility: { cwd, hasGoal: false, host: "desktop", isSubAgent: false },
      // Would approve if asked — the point is that the deny rule means it is
      // never asked.
      approvalBackend: { requestApproval: async () => ({ approved: true }) },
    });

    const result = await host.execute({ id: "s1", name: "Watched", input: {} });
    expect(result.isError).toBe(true);
    expect(record).toEqual([]);
  });

  test("the host and the Native Engine compose the same rules", () => {
    const cwd = projectDenying("Watched");
    // What the Native Engine's PermissionController.build() would produce...
    const native = composePermissionRules({
      mode: "default",
      cwd,
      presetRules: PRESET_RULES,
    });
    // ...decides the same way as a classifier built from it.
    expect(new PermissionClassifier(native, "default").classify("Watched", {})).toBe("deny");

    // And the user rule outranks the preset allow — order matters, not just
    // presence.
    expect(native[0]).toMatchObject({ tool: "Watched", decision: "deny" });
  });

  test("without a user rule the preset allow still applies", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-settings-parity-none-"));
    dirs.push(cwd);
    const record: string[] = [];
    const host = createSessionToolHost({
      businessSessionId: "sess-nosettings",
      cwd,
      registry: new ToolRegistry({ toolCatalog: catalog(record) }),
      permissionMode: "default",
      presetRules: PRESET_RULES,
      planMode: false,
      exposure: { mode: "allowlist", toolNames: new Set(["Watched"]) },
      visibility: { cwd, hasGoal: false, host: "desktop", isSubAgent: false },
      approvalBackend: {
        requestApproval: async () => ({ approved: false, reason: "must not be consulted" }),
      },
    });

    const result = await host.execute({ id: "s2", name: "Watched", input: {} });
    expect(result.isError).toBeFalsy();
    expect(record).toEqual(["Watched"]);
  });

  test("mode-derived rules are composed too, not just presets", () => {
    // acceptEdits pushes Write/Edit allows. A caller-supplied array would have
    // silently omitted these.
    const cwd = mkdtempSync(join(tmpdir(), "cs-settings-parity-mode-"));
    dirs.push(cwd);
    const rules = composePermissionRules({ mode: "acceptEdits", cwd, presetRules: [] });
    expect(rules).toContainEqual({ tool: "Write", decision: "allow" });
    expect(rules).toContainEqual({ tool: "Edit", decision: "allow" });
    // …and the standing memory carve-outs.
    expect(rules.some((r) => r.tool === "MemorySave" && r.decision === "allow")).toBe(true);
  });
});
