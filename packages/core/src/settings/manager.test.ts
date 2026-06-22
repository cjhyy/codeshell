import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "./manager.js";

/**
 * Scope isolation tests. We point HOME at a temp dir (userHome() reads
 * process.env.HOME first) and use a separate temp cwd, then seed each of the
 * four disk layers with a uniquely-named mcpServers entry. mcpServers is a
 * record merged key-by-key, so every layer that was actually read leaves its
 * own key in the merged result — letting us detect which layers were read
 * (unlike arrays, which deep-merge replaces wholesale).
 */
describe("SettingsManager scope", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  function serverFor(tag: string) {
    return { [tag]: { name: tag, command: "echo", transport: "stdio" as const } };
  }
  function writeSettings(dir: string, file: string, tag: string) {
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(
      join(dir, ".code-shell", file),
      JSON.stringify({ mcpServers: serverFor(tag) }),
      "utf-8",
    );
  }
  function layersIn(sm: SettingsManager): string[] {
    return Object.keys(sm.get().mcpServers ?? {}).sort();
  }

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    process.env.HOME = home;
    writeSettings(home, "settings.managed.json", "MANAGED");
    writeSettings(home, "settings.json", "USER");
    writeSettings(cwd, "settings.json", "PROJECT");
    writeSettings(cwd, "settings.local.json", "LOCAL");
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("full reads all four disk layers", () => {
    expect(layersIn(new SettingsManager(cwd, "full"))).toEqual([
      "LOCAL",
      "MANAGED",
      "PROJECT",
      "USER",
    ]);
  });

  test("project (default) reads project+local, never user/managed", () => {
    expect(layersIn(new SettingsManager(cwd, "project"))).toEqual(["LOCAL", "PROJECT"]);
  });

  test("default scope is project", () => {
    expect(layersIn(new SettingsManager(cwd))).toEqual(["LOCAL", "PROJECT"]);
  });

  test("isolated reads no disk layers", () => {
    expect(layersIn(new SettingsManager(cwd, "isolated"))).toEqual([]);
  });

  test("flag overrides apply even under isolated", () => {
    const sm = new SettingsManager(cwd, "isolated");
    sm.load({ mcpServers: serverFor("FLAG") });
    expect(layersIn(sm)).toEqual(["FLAG"]);
  });

  test("non-full scope never triggers user-file model migration write-back", () => {
    // Legacy models[] in the user file would normally be migrated (and the
    // file rewritten with a .bak). Under project/isolated we must not touch
    // the user file at all.
    writeFileSync(
      join(home, ".code-shell", "settings.json"),
      JSON.stringify({ models: [{ id: "legacy", provider: "x" }] }),
      "utf-8",
    );
    new SettingsManager(cwd, "project").get();
    expect(existsSync(join(home, ".code-shell", "settings.json.bak"))).toBe(false);
  });
});

describe("SettingsManager project writes", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-cwd-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function projectJson(): any {
    return JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
  }

  test("saveProjectSetting writes dotted path to project settings.json", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.skills.helper", "on", cwd);
    expect(projectJson().capabilityOverrides.skills.helper).toBe("on");
  });

  test("saveProjectSetting creates .code-shell dir if absent", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.mcp.playwright", "off", cwd);
    expect(existsSync(join(cwd, ".code-shell", "settings.json"))).toBe(true);
  });

  test("saveProjectSetting writes the file owner-only (0o600) — no plaintext key world-readable", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("providers", [{ key: "p", kind: "openai", baseUrl: "x", apiKey: "sk-secret" }], cwd);
    const mode = statSync(join(cwd, ".code-shell", "settings.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("saveProjectSetting tightens a pre-existing world-readable file to 0o600", () => {
    // Seed a loose file first (simulates a settings.json written before the fix).
    mkdirSync(join(cwd, ".code-shell"), { recursive: true });
    const f = join(cwd, ".code-shell", "settings.json");
    writeFileSync(f, "{}", { mode: 0o644 });
    chmodSync(f, 0o644);
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.skills.helper", "on", cwd);
    expect((statSync(f).mode & 0o777)).toBe(0o600);
  });

  test("saveUserSetting writes the user settings.json owner-only (0o600)", () => {
    const sm = new SettingsManager(cwd, "full");
    sm.saveUserSetting("providers", [{ key: "p", kind: "openai", baseUrl: "x", apiKey: "sk-secret" }]);
    const mode = statSync(join(home, ".code-shell", "settings.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("deleteProjectSetting removes the leaf key (inherit)", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.skills.a", "off", cwd);
    sm.saveProjectSetting("capabilityOverrides.skills.b", "on", cwd);
    sm.deleteProjectSetting("capabilityOverrides.skills.a", cwd);
    const j = projectJson();
    expect(j.capabilityOverrides.skills.a).toBeUndefined();
    expect(j.capabilityOverrides.skills.b).toBe("on");
  });

  test("empty cwd throws (boundary guard)", () => {
    const sm = new SettingsManager(cwd, "project");
    expect(() => sm.saveProjectSetting("x.y", "on", "")).toThrow();
  });

  test("write invalidates cache so next get() reflects it", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.get(); // prime cache
    sm.saveProjectSetting("capabilityOverrides.skills.z", "on", cwd);
    expect((sm.get() as any).capabilityOverrides.skills.z).toBe("on");
  });

  test("getForScope('project') returns only the project file, unmerged", () => {
    const sm = new SettingsManager(cwd, "project");
    sm.saveProjectSetting("capabilityOverrides.skills.a", "off", cwd);
    const proj = sm.getForScope("project", cwd);
    expect(proj.capabilityOverrides?.skills?.a).toBe("off");
    // user-only fields are not present in the project-scope view
    expect((proj as any).disabledSkills).toBeUndefined();
  });

  test("getForScope('project') returns {} when no project file", () => {
    const sm = new SettingsManager(cwd, "project");
    expect(sm.getForScope("project", cwd)).toEqual({});
  });
});

/**
 * Config-migration wiring (migrate-config.ts MIGRATIONS applied on load).
 * Uses the real v0→v1 step: legacy imageGen/videoGen providers without a
 * catalogId get one backfilled, persisted to the file they came from (with a
 * .bak), and the in-memory merge sees the migrated shape immediately.
 */
describe("SettingsManager config migration wiring", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-mig-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-mig-cwd-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function seed(dir: string, data: unknown) {
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(join(dir, ".code-shell", "settings.json"), JSON.stringify(data), "utf-8");
  }

  test("legacy user-file gen provider gets catalogId backfilled + .bak + merged view", () => {
    seed(home, {
      imageGen: { defaultProvider: "openai", providers: [{ id: "openai", kind: "openai", apiKey: "sk", baseUrl: "https://api.openai.com/v1" }] },
    });
    const merged = new SettingsManager(cwd, "full").load() as any;
    expect(merged.imageGen.providers[0].catalogId).toBe("openai-images");

    const path = join(home, ".code-shell", "settings.json");
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    expect(onDisk.imageGen.providers[0].catalogId).toBe("openai-images");
    expect(onDisk.configVersion).toBe(2);
    expect(existsSync(`${path}.bak`)).toBe(true);
  });

  test("legacy project-file gen provider migrates too (project scope)", () => {
    seed(cwd, { videoGen: { providers: [{ id: "fal", kind: "fal", apiKey: "f", baseUrl: "https://fal.run" }] } });
    const merged = new SettingsManager(cwd, "project").load() as any;
    expect(merged.videoGen.providers[0].catalogId).toBe("fal-video");
    const onDisk = JSON.parse(readFileSync(join(cwd, ".code-shell", "settings.json"), "utf-8"));
    expect(onDisk.videoGen.providers[0].catalogId).toBe("fal-video");
  });

  test("file with nothing to migrate is left byte-identical (no stamp-only rewrite)", () => {
    seed(home, { disabledSkills: ["x"] });
    const path = join(home, ".code-shell", "settings.json");
    const before = readFileSync(path, "utf-8");
    new SettingsManager(cwd, "full").load();
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(existsSync(`${path}.bak`)).toBe(false);
  });

  test("already-migrated file is not rewritten again", () => {
    seed(home, {
      configVersion: 1,
      imageGen: { providers: [{ id: "openai", kind: "openai", apiKey: "sk", baseUrl: "https://api.openai.com/v1", catalogId: "openai-images" }] },
    });
    const path = join(home, ".code-shell", "settings.json");
    const before = readFileSync(path, "utf-8");
    new SettingsManager(cwd, "full").load();
    expect(readFileSync(path, "utf-8")).toBe(before);
  });
});

/**
 * hooks is the ONE top-level array that CONCATENATES across layers (user
 * first, project after) instead of being replaced wholesale — a global hook
 * and a project hook must BOTH run (feedback #16, mirrors Claude Code).
 * `"hooks": null` in a layer still resets everything below it.
 */
describe("SettingsManager hooks cross-layer concat", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-hooks-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-hooks-cwd-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  function seedFile(dir: string, file: string, data: unknown) {
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(join(dir, ".code-shell", file), JSON.stringify(data), "utf-8");
  }

  test("user + project hooks concatenate (user first, project after)", () => {
    seedFile(home, "settings.json", {
      hooks: [{ event: "notification", command: "echo global" }],
    });
    seedFile(cwd, "settings.json", {
      hooks: [{ event: "pre_tool_use", command: "echo project" }],
    });
    const merged = new SettingsManager(cwd, "full").load();
    expect((merged.hooks ?? []).map((h) => h.command)).toEqual([
      "echo global",
      "echo project",
    ]);
  });

  test("project-only hooks are unchanged (no user layer)", () => {
    seedFile(cwd, "settings.json", {
      hooks: [{ event: "pre_tool_use", command: "echo project" }],
    });
    const merged = new SettingsManager(cwd, "full").load();
    expect((merged.hooks ?? []).map((h) => h.command)).toEqual(["echo project"]);
  });

  test('explicit "hooks": null in the project layer resets user hooks', () => {
    seedFile(home, "settings.json", {
      hooks: [{ event: "notification", command: "echo global" }],
    });
    seedFile(cwd, "settings.json", { hooks: null });
    const merged = new SettingsManager(cwd, "full").load();
    expect(merged.hooks ?? []).toEqual([]);
  });

  test("local layer hooks append after project hooks", () => {
    seedFile(cwd, "settings.json", {
      hooks: [{ event: "pre_tool_use", command: "echo project" }],
    });
    seedFile(cwd, "settings.local.json", {
      hooks: [{ event: "notification", command: "echo local" }],
    });
    const merged = new SettingsManager(cwd, "full").load();
    expect((merged.hooks ?? []).map((h) => h.command)).toEqual([
      "echo project",
      "echo local",
    ]);
  });

  test("disabled flag survives validation (schema keeps it)", () => {
    seedFile(home, "settings.json", {
      hooks: [{ event: "notification", command: "echo off", disabled: true }],
    });
    const merged = new SettingsManager(cwd, "full").load();
    expect(merged.hooks?.[0]?.disabled).toBe(true);
  });
});
