import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as childProcess from "node:child_process";

// Deny every origin/process before Core and host entry imports; this suite has no live fixtures.
const fetchGuard = spyOn(globalThis, "fetch").mockImplementation(async () => {
  throw new Error("Profile switch tests forbid network requests");
});
const spawnGuard = spyOn(childProcess, "spawnSync").mockImplementation(() => {
  throw new Error("Profile switch preview must not probe or install binaries");
});
const { SettingsManager, setDefaultCredentialAccess } = await import("@cjhyy/code-shell-core");
const { saveWorkspaceProfile, saveSourceDefinition, bindSource } =
  await import("@cjhyy/code-shell-core/internal");
const { previewProfileSwitch, adoptProfileSwitch } = await import("./profile-switch-service.js");
const { registerProfileSwitchIpc } = await import("./profile-switch-ipc.js");
const { resolveRendererConfigurationTarget } =
  await import("./renderer-configuration-authority.js");
const { WebConfigurationGate } = await import("./web-configuration-gate.js");

let root: string;
let oldHome: string | undefined;
let oldUserHome: string | undefined;
let target: { kind: "project"; projectId: string; mainRootId: string; cwd: string };
const definition = (name: string, fields: Record<string, unknown> = {}) => ({
  name,
  label: name,
  basePreset: "general",
  ...fields,
});
function tree(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) Object.assign(out, tree(child));
    else out[child] = readFileSync(child).toString("base64");
  }
  return out;
}
function seedSkill(name: string) {
  const path = join(target.cwd, ".agents", "skills", name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "SKILL.md"),
    `---\nname: ${name}\ndescription: local fixture\n---\nFixture only.`,
  );
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cs-profile-switch-"));
  oldHome = process.env.CODE_SHELL_HOME;
  oldUserHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  process.env.CODE_SHELL_HOME = join(root, "state");
  target = {
    kind: "project",
    projectId: "project-a",
    mainRootId: "primary",
    cwd: join(root, "project"),
  };
  mkdirSync(target.cwd, { recursive: true });
  saveWorkspaceProfile(
    definition("old", {
      mainInstruction: "private-old",
      portableMemory: true,
      skills: ["old-skill"],
    }),
  );
  saveWorkspaceProfile(
    definition("next", {
      mainInstruction: "private-next",
      skills: ["next-skill", "missing"],
      requires: { tools: [{ bin: "DO_NOT_EXECUTE" }] },
    }),
  );
  new SettingsManager(target.cwd, "full").saveProjectSetting(
    "profile",
    { active: "old", preset: "general", overrides: { skills: { "old-skill": "on" } } },
    target.cwd,
  );
  seedSkill("old-skill");
  seedSkill("next-skill");
});
afterEach(() => {
  setDefaultCredentialAccess(null);
  process.env.CODE_SHELL_HOME = oldHome;
  process.env.HOME = oldUserHome;
  rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  fetchGuard.mockRestore();
  spawnGuard.mockRestore();
});

describe("reviewed Desktop Profile switch", () => {
  test("preview is read-only, metadata-only and requirements never execute", () => {
    const before = tree(root);
    const review = previewProfileSwitch(target, "next");
    expect(tree(root)).toEqual(before);
    expect(review.before?.name).toBe("old");
    expect(review.after?.name).toBe("next");
    expect(review.memory).toEqual({ before: "old", after: null });
    const serialized = JSON.stringify(review);
    for (const secret of [
      "private-old",
      "private-next",
      "DO_NOT_EXECUTE",
      "credentialRef",
      "mainInstruction",
      target.cwd,
    ])
      expect(serialized).not.toContain(secret);
    expect(review.missingDeclarations).toContainEqual({ kind: "skill", name: "missing" });
    expect(fetchGuard).not.toHaveBeenCalled();
    expect(spawnGuard).not.toHaveBeenCalled();
  });

  test("legacy migration inputs are computed in memory while preview and cancellation create no backup or settings file", () => {
    const legacy = {
      sandbox: { mode: "auto", network: "allow", writableRoots: [], deniedReads: [] },
      models: [
        {
          key: "fixture",
          provider: "openai",
          model: "fixture",
          baseUrl: "https://denied.invalid",
          apiKey: "fixture-never-use",
        },
      ],
    };
    const userDir = join(process.env.HOME!, ".code-shell");
    mkdirSync(userDir, { recursive: true });
    writeFileSync(join(userDir, "settings.json"), JSON.stringify(legacy));
    const projectPath = join(target.cwd, ".code-shell", "settings.json");
    writeFileSync(
      projectPath,
      JSON.stringify({ ...JSON.parse(readFileSync(projectPath, "utf8")), sandbox: legacy.sandbox }),
    );
    const before = tree(root);
    const readOnly = new SettingsManager(target.cwd, "full").load(undefined, {
      persistMigrations: false,
    });
    expect(readOnly.models[0]?.providerKey).toBe("custom");
    expect(readOnly.sandbox?.mode).not.toBe("auto");
    const review = previewProfileSwitch(target, "next");
    expect(review.after?.name).toBe("next");
    // Closing a review is renderer-only: no adoption IPC is sent.
    expect(tree(root)).toEqual(before);
    expect(JSON.stringify(review)).not.toContain("fixture-never-use");
  });

  test("adoption preserves unrelated settings and explicit Session bindings; deactivation previews the actual baseline fallback", () => {
    const sm = new SettingsManager(target.cwd, "full");
    const review = previewProfileSwitch(target, "next");
    sm.saveProjectSetting("responseLanguage", "en", target.cwd);
    const sessionDir = join(process.env.CODE_SHELL_HOME!, "sessions", "pinned");
    mkdirSync(sessionDir, { recursive: true });
    const statePath = join(sessionDir, "state.json");
    writeFileSync(statePath, JSON.stringify({ workspaceProfile: "old" }));
    const pinned = readFileSync(statePath, "utf8");
    expect(adoptProfileSwitch(target, "next", review.revision)).toEqual({ status: "adopted" });
    expect(sm.getForScope("project", target.cwd).responseLanguage).toBe("en");
    expect(readFileSync(statePath, "utf8")).toBe(pinned);
    const clear = previewProfileSwitch(target, null);
    expect(clear.after).toBeNull();
    expect(adoptProfileSwitch(target, null, clear.revision)).toEqual({ status: "adopted" });
    expect(sm.getForScope("project", target.cwd).profile).toBeUndefined();
    expect(sm.getForScope("project", target.cwd).responseLanguage).toBe("en");
  });

  test.each(["definition", "default", "inventory", "direct", "local", "root"])(
    "%s changes stale the review without a settings write",
    (change) => {
      const review = previewProfileSwitch(target, "next");
      const sm = new SettingsManager(target.cwd, "full");
      if (change === "definition")
        saveWorkspaceProfile(definition("next", { mainInstruction: "edited" }));
      if (change === "default") sm.saveProjectSetting("profile.active", "next", target.cwd);
      if (change === "inventory") seedSkill("new-install");
      if (change === "direct")
        sm.saveProjectSetting("capabilityOverrides.skills.next-skill", "off", target.cwd);
      if (change === "local")
        sm.saveLocalSetting("capabilityOverrides.skills.next-skill", "off", target.cwd);
      const path = join(target.cwd, ".code-shell", "settings.json");
      const before = readFileSync(path, "utf8");
      expect(
        adoptProfileSwitch(
          change === "root" ? { ...target, mainRootId: "changed" } : target,
          "next",
          review.revision,
        ),
      ).toEqual({ status: "stale" });
      expect(readFileSync(path, "utf8")).toBe(before);
    },
  );

  test("source access preview uses the existing binding intersection without leaking definitions or credentials", () => {
    let metadataReads = 0;
    const forbid = () => {
      throw new Error("Preview must not resolve credentials or expose environment");
    };
    setDefaultCredentialAccess({
      listMasked: forbid,
      envExposures: forbid,
      resolveValue: async () => forbid(),
      resolveOAuthAccess: async () => forbid(),
      resolveMeta: () => {
        metadataReads++;
        return { id: "private-reference", type: "token", label: "Private", hasSecret: true };
      },
    });
    saveSourceDefinition({
      id: "reports",
      label: "Reports",
      kind: "mock",
      enabled: true,
      adapterConfig: { secretSentinel: "never-expose" },
      credentialRef: "private-reference",
    });
    bindSource(new SettingsManager(target.cwd, "full"), target.cwd, {
      sourceId: "reports",
      scopes: ["a", "b"],
      readPolicy: "ask",
    });
    saveWorkspaceProfile(
      definition("next", {
        sourceAccess: [{ sourceId: "reports", scopes: ["b", "unbound"], readPolicy: "deny" }],
      }),
    );
    const review = previewProfileSwitch(target, "next");
    expect(review.sources.after).toEqual([
      { sourceId: "reports", label: "Reports", scopes: ["b"], readPolicy: "deny", status: "ok" },
    ]);
    expect(JSON.stringify(review)).not.toContain("never-expose");
    expect(JSON.stringify(review)).not.toContain("definition");
    expect(JSON.stringify(review)).not.toContain("private-reference");
    expect(metadataReads).toBeGreaterThan(0);
  });

  test.each([
    ["missing", null],
    ["missing", "next"],
    ["corrupt", null],
    ["corrupt", "next"],
  ] as const)("%s old definition permits reviewed replacement with %s", (damage, name) => {
    const path = join(process.env.CODE_SHELL_HOME!, "profiles", "old", "profile.json");
    if (damage === "missing") rmSync(path);
    else writeFileSync(path, "{ corrupt-secret-body");
    saveSourceDefinition({ id: "bound", label: "Bound", kind: "mock", enabled: true });
    bindSource(new SettingsManager(target.cwd, "full"), target.cwd, {
      sourceId: "bound",
      scopes: ["read"],
      readPolicy: "ask",
    });
    const before = tree(root);
    const review = previewProfileSwitch(target, name);
    expect(review.before).toEqual({ name: "old", label: "old", available: false });
    expect(review.instruction.beforeLength).toBeNull();
    expect(review.instruction.changed).toBeNull();
    expect(review.sources.before).toEqual([]);
    expect(JSON.stringify(review)).not.toContain("corrupt-secret-body");
    expect(tree(root)).toEqual(before);
    expect(adoptProfileSwitch(target, name, review.revision)).toEqual({ status: "adopted" });
  });

  test("repairing an unavailable old definition stales the review; a corrupt candidate stays strict", () => {
    const oldPath = join(process.env.CODE_SHELL_HOME!, "profiles", "old", "profile.json");
    writeFileSync(oldPath, "{ damaged");
    const review = previewProfileSwitch(target, null);
    saveWorkspaceProfile(definition("old", { mainInstruction: "repaired", portableMemory: true }));
    const before = tree(root);
    expect(adoptProfileSwitch(target, null, review.revision)).toEqual({ status: "stale" });
    expect(tree(root)).toEqual(before);
    writeFileSync(
      join(process.env.CODE_SHELL_HOME!, "profiles", "next", "profile.json"),
      "{ invalid-candidate",
    );
    expect(() => previewProfileSwitch(target, "next")).toThrow();
  });

  test("actual IPC resolves stable identities, rejects no-repo/forged paths, and gates busy/stale before write or reload", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const gate = new WebConfigurationGate();
    let reloads = 0;
    const deps = {
      resolveProjectPrimary: async (id: unknown) => {
        if (id !== target.projectId) throw new Error("unknown project");
        return { project: { id }, rootId: target.mainRootId, path: target.cwd } as any;
      },
      resolveSessionAuthority: async () =>
        ({
          rootStatus: "ok",
          mainRoot: target.cwd,
          projectId: target.projectId,
          mainRootId: "session-root",
        }) as any,
      requireUsableSessionAuthority: () => {},
      resolveNoRepoCwd: () => {
        throw new Error("no-repo must reject before resolution");
      },
    };
    registerProfileSwitchIpc({
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      resolveTarget: (value) => resolveRendererConfigurationTarget(value, deps),
      withMutation: (cwd, write) => {
        expect(cwd).toBe(target.cwd);
        return gate.mutate(write, async () => {
          reloads++;
        });
      },
    });
    const preview = (value: unknown) => handlers.get("profiles:previewSwitch")!({}, value, "next");
    for (const value of [
      { noRepo: true },
      { projectId: target.projectId, cwd: "/forged" },
      "/forged",
    ])
      await expect(preview(value)).rejects.toThrow();
    const review = await preview({ projectId: target.projectId });
    expect((await preview({ sessionId: "pinned" })).target).toEqual({
      kind: "session",
      projectId: target.projectId,
      sessionId: "pinned",
    });
    const before = tree(root);
    gate.beginRun("active", "pinned");
    await expect(
      handlers.get("profiles:adoptSwitch")!(
        {},
        { projectId: target.projectId },
        "next",
        review.revision,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(tree(root)).toEqual(before);
    gate.settleRun("active");
    saveWorkspaceProfile(definition("next", { skills: ["changed"] }));
    expect(
      await handlers.get("profiles:adoptSwitch")!(
        {},
        { projectId: target.projectId },
        "next",
        review.revision,
      ),
    ).toEqual({ status: "stale" });
    expect(reloads).toBe(0);
    const fresh = await preview({ projectId: target.projectId });
    expect(
      await handlers.get("profiles:adoptSwitch")!(
        {},
        { projectId: target.projectId },
        "next",
        fresh.revision,
      ),
    ).toEqual({ status: "adopted" });
    expect(reloads).toBe(1);
  });

  test.each(["project", "session"] as const)(
    "%s authority changed while waiting for the mutation gate is stale with no write or reload",
    async (kind) => {
      const handlers = new Map<string, (...args: any[]) => any>();
      const gate = new WebConfigurationGate();
      let reloads = 0;
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const admission = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalCwd = target.cwd;
      const original = { ...target };
      registerProfileSwitchIpc({
        ipcMain: {
          handle: (channel, listener) => {
            handlers.set(channel, listener);
          },
        },
        resolveTarget: async () =>
          kind === "project" ? { ...target } : { ...target, kind: "session", sessionId: "pinned" },
        withMutation: async (cwd, write) => {
          expect(cwd).toBe(originalCwd);
          enter();
          await admission;
          return gate.mutate(write, async () => {
            reloads++;
          });
        },
      });
      const requested =
        kind === "project" ? { projectId: target.projectId } : { sessionId: "pinned" };
      const review = await handlers.get("profiles:previewSwitch")!({}, requested, "next");
      const adoption = handlers.get("profiles:adoptSwitch")!(
        {},
        requested,
        "next",
        review.revision,
      );
      await entered;
      target = { ...target, mainRootId: "replacement", cwd: join(root, "replacement") };
      mkdirSync(target.cwd);
      const before = tree(root);
      release();
      expect(await adoption).toEqual({ status: "stale" });
      expect(tree(root)).toEqual(before);
      expect(reloads).toBe(0);
      expect(previewProfileSwitch(original, "next").before?.name).toBe("old");
    },
  );
});
