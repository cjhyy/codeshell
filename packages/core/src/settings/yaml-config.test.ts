import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SettingsManager } from "./manager.js";

/**
 * YAML config-file support. The settings loader historically only read
 * settings.json; these tests fix the behaviour for hand-written YAML
 * (settings.yaml / settings.yml) as an alternative read format. Write-back
 * stays JSON — only reading gains YAML.
 *
 * HOME isolation mirrors manager.test.ts: point process.env.HOME at a temp
 * dir (userHome() reads env.HOME first) so we never touch the real
 * ~/.code-shell. mcpServers is a record merged key-by-key, so each layer that
 * was actually read leaves its own key in the merged result.
 */
describe("SettingsManager YAML config", () => {
  let home: string;
  let cwd: string;
  let prevHome: string | undefined;

  function serverFor(tag: string) {
    return { [tag]: { name: tag, command: "echo", transport: "stdio" as const } };
  }
  function writeFile(dir: string, file: string, content: string) {
    mkdirSync(join(dir, ".code-shell"), { recursive: true });
    writeFileSync(join(dir, ".code-shell", file), content, "utf-8");
  }
  function layersIn(sm: SettingsManager): string[] {
    return Object.keys(sm.get().mcpServers ?? {}).sort();
  }

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-yaml-home-"));
    cwd = mkdtempSync(join(tmpdir(), "cs-yaml-cwd-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("reads a pure settings.yaml (user layer)", () => {
    writeFile(
      home,
      "settings.yaml",
      "mcpServers:\n  USERYAML:\n    name: USERYAML\n    command: echo\n    transport: stdio\n",
    );
    const sm = new SettingsManager(cwd, "full");
    expect(layersIn(sm)).toEqual(["USERYAML"]);
  });

  test("reads settings.yml (.yml extension) too", () => {
    writeFile(
      home,
      "settings.yml",
      "mcpServers:\n  USERYML:\n    name: USERYML\n    command: echo\n    transport: stdio\n",
    );
    const sm = new SettingsManager(cwd, "full");
    expect(layersIn(sm)).toEqual(["USERYML"]);
  });

  test("JSON wins when settings.json and settings.yaml both exist", () => {
    writeFile(home, "settings.json", JSON.stringify({ mcpServers: serverFor("JSONWINS") }));
    writeFile(
      home,
      "settings.yaml",
      "mcpServers:\n  YAMLLOSES:\n    name: YAMLLOSES\n    command: echo\n    transport: stdio\n",
    );
    const sm = new SettingsManager(cwd, "full");
    expect(layersIn(sm)).toEqual(["JSONWINS"]);
  });

  test("corrupt YAML does not crash — layer is skipped", () => {
    writeFile(home, "settings.yaml", "mcpServers: : : [unbalanced\n  - nope\n:::");
    const sm = new SettingsManager(cwd, "full");
    // No crash, and the corrupt layer contributes nothing.
    expect(layersIn(sm)).toEqual([]);
  });

  test("YAML and JSON layers deep-merge across scopes", () => {
    // User layer in YAML, project layer in JSON — both should survive merge.
    writeFile(
      home,
      "settings.yaml",
      "mcpServers:\n  USERYAML:\n    name: USERYAML\n    command: echo\n    transport: stdio\n",
    );
    writeFile(cwd, "settings.json", JSON.stringify({ mcpServers: serverFor("PROJECTJSON") }));
    const sm = new SettingsManager(cwd, "full");
    expect(layersIn(sm)).toEqual(["PROJECTJSON", "USERYAML"]);
  });

  test("project + local YAML both read", () => {
    writeFile(
      cwd,
      "settings.yaml",
      "mcpServers:\n  PROJYAML:\n    name: PROJYAML\n    command: echo\n    transport: stdio\n",
    );
    writeFile(
      cwd,
      "settings.local.yaml",
      "mcpServers:\n  LOCALYAML:\n    name: LOCALYAML\n    command: echo\n    transport: stdio\n",
    );
    const sm = new SettingsManager(cwd, "project");
    expect(layersIn(sm)).toEqual(["LOCALYAML", "PROJYAML"]);
  });

  test("deleteProjectSetting removes a key from a YAML-only project (regression)", () => {
    // Bug: deleteProjectSetting guarded existsSync on the .json path only, so a
    // project with only settings.yaml silently no-op'd — the override survived
    // read/merge while the UI showed "inherited". Delete must be YAML-aware.
    writeFile(
      cwd,
      "settings.yaml",
      "mcpServers:\n  PROJYAML:\n    name: PROJYAML\n    command: echo\n    transport: stdio\n",
    );
    const before = new SettingsManager(cwd, "project");
    expect(layersIn(before)).toEqual(["PROJYAML"]);

    // Remove the key, then re-load from disk to confirm it's actually gone.
    before.deleteProjectSetting("mcpServers.PROJYAML", cwd);
    const after = new SettingsManager(cwd, "project");
    expect(layersIn(after)).toEqual([]);
  });
});
