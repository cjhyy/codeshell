import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
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
