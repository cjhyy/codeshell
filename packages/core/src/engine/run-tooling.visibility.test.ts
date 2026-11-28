/**
 * `toolVisibility` is what the ToolExecutor's availability guards read, and it
 * gates BOTH what the model is shown and what the executor will run: a guarded
 * builtin whose guard fails is rejected before its handler, not merely hidden
 * (executor.ts's visibility gate).
 *
 * Building it used to be an inline block inside assembleRunToolDefs — one of 21
 * parameters' worth of Engine-run state. Any second caller that assembles a tool
 * surface without an Engine run (a session-scoped tool host exposing tools to an
 * external Agent Runtime) would either duplicate the block and drift, or leave
 * the field undefined. Undefined is the dangerous outcome: the executor's guard
 * check is skipped when `toolCtx.toolVisibility` is absent, so a host-gated tool
 * like Panel would become callable in a context its guard was written to exclude.
 *
 * These tests pin the builder as an independently-callable unit.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleRunToolDefs,
  buildToolVisibility,
  initializeRunToolSurface,
} from "./run-tooling.js";
import { ToolRegistry } from "../tool-system/registry.js";
import type { ToolContext } from "../tool-system/context.js";
import { SettingsManager } from "../settings/manager.js";
import { effectiveProjectOverrides } from "../capability-control/overlay.js";
import { localCredentialAccess } from "../credentials/access.js";
import { CredentialStore } from "../credentials/store.js";

describe("buildToolVisibility", () => {
  test("carries the fields availability guards actually branch on", () => {
    const visibility = buildToolVisibility({
      cwd: "/repo",
      hasGoal: true,
      settingsScope: "project",
      host: "desktop",
      isSubAgent: false,
      behaviorProfile: "coding",
    });

    // Panel's guard is `ctx.host === "desktop" && ctx.isSubAgent !== true`.
    expect(visibility.host).toBe("desktop");
    expect(visibility.isSubAgent).toBe(false);
    expect(visibility.cwd).toBe("/repo");
    expect(visibility.hasGoal).toBe(true);
    expect(visibility.settingsScope).toBe("project");
    expect(visibility.behaviorProfile).toBe("coding");
  });

  test("omits optional keys rather than setting them undefined", () => {
    const visibility = buildToolVisibility({ cwd: "/repo", hasGoal: false });

    // Guards use `!== true` / `?? []` style checks, and snapshots of this object
    // reach persistence; absent keys must stay absent rather than serialize null.
    expect("sessionId" in visibility).toBe(false);
    expect("profileMeta" in visibility).toBe(false);
    expect("sessionMessageTargets" in visibility).toBe(false);
    expect(visibility).toEqual({ cwd: "/repo", hasGoal: false });
  });

  test("includes sessionId and profileMeta only when supplied", () => {
    const visibility = buildToolVisibility({
      cwd: "/repo",
      hasGoal: false,
      sessionId: "sess-1",
      profileMeta: { reviewMode: "strict" },
    });

    expect(visibility.sessionId).toBe("sess-1");
    expect(visibility.profileMeta).toEqual({ reviewMode: "strict" });
  });

  test("drops an empty session-message target list", () => {
    // SendMessageToSession's guard is `(targets?.length ?? 0) > 0`; an empty
    // array must not be carried as if the host had authorized targets.
    const empty = buildToolVisibility({ cwd: "/repo", hasGoal: false, sessionMessageTargets: [] });
    expect("sessionMessageTargets" in empty).toBe(false);

    const populated = buildToolVisibility({
      cwd: "/repo",
      hasGoal: false,
      sessionMessageTargets: [{ sessionId: "peer", title: "Peer" } as never],
    });
    expect(populated.sessionMessageTargets).toHaveLength(1);
  });
});

/**
 * The executor refreshes eligibility before every tool call so a capability
 * revoked mid-run (settings override, removed credential) takes effect on the
 * next call. Unchanged inputs must not be re-read and re-validated each time.
 */
describe("per-call eligibility refresh", () => {
  const dirs: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Files written within the racy window are always re-read; age them so the
  // cache is observable. Distinct ages keep each rewrite's stamp distinct.
  const age = (path: string, seconds: number) => {
    const at = Date.now() / 1000 - seconds;
    utimesSync(path, at, at);
  };

  test("reuses unchanged settings and credentials, and sees changes on the next call", () => {
    const cwd = mkdtempSync(join(tmpdir(), "cs-refresh-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, ".code-shell"));
    const settingsPath = join(cwd, ".code-shell", "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ capabilityOverrides: { builtin: {} } }));
    age(settingsPath, 120);

    const settings = new SettingsManager(cwd, "project");
    const registry = new ToolRegistry({ builtinTools: ["Read", "Bash", "UseCredential"] });
    const ctx = { cwd, toolRegistry: registry } as ToolContext;
    const settingsReads = spyOn(settings, "getRawForScope");
    const credentialReads = spyOn(localCredentialAccess, "listMasked");
    spies.push(settingsReads, credentialReads);
    // Mirrors Engine.run's assembler: every input is re-read per assembly.
    initializeRunToolSurface(ctx, undefined, () =>
      assembleRunToolDefs({
        toolRegistry: registry,
        toolCtx: ctx,
        guardCwd: cwd,
        hasRunnableGoal: false,
        settingsScope: "project",
        builtinToolHost: undefined,
        isSubAgent: false,
        behaviorProfileId: undefined,
        profileMeta: undefined,
        builtinOverride: effectiveProjectOverrides(settings, cwd)?.builtin,
        mcpServers: {},
        mcpDisabled: true,
        featureFlags: undefined,
        profileAllowedToolNames: undefined,
        runPlanMode: false,
      }),
    );
    const names = () => ctx.searchableToolDefinitions!.map((tool) => tool.name);
    expect(names()).toContain("Read");
    expect(names()).not.toContain("UseCredential");
    expect(settingsReads.mock.calls.length).toBeGreaterThan(0);
    expect(credentialReads.mock.calls.length).toBeGreaterThan(0);

    settingsReads.mockClear();
    credentialReads.mockClear();
    for (let call = 0; call < 5; call++) ctx.refreshRunToolEligibility!();
    expect(settingsReads).not.toHaveBeenCalled();
    expect(credentialReads).not.toHaveBeenCalled();

    // Between two tool calls: revoke Read and add a credential.
    writeFileSync(
      settingsPath,
      JSON.stringify({ capabilityOverrides: { builtin: { Read: "off" } } }),
    );
    age(settingsPath, 60);
    new CredentialStore(cwd).save("project", {
      id: "gh",
      type: "token",
      label: "GitHub",
      secret: "fixture-token",
    });
    age(join(cwd, ".code-shell", "credentials.json"), 60);
    ctx.refreshRunToolEligibility!();
    expect(ctx.disabledBuiltins?.has("Read")).toBe(true);
    expect(names()).not.toContain("Read");
    expect(names()).toContain("UseCredential");
    expect(settingsReads).toHaveBeenCalled();
    expect(credentialReads).toHaveBeenCalled();

    // A change inside the racy window is never served from the cache.
    writeFileSync(settingsPath, JSON.stringify({ capabilityOverrides: { builtin: {} } }));
    ctx.refreshRunToolEligibility!();
    expect(names()).toContain("Read");
  });
});
