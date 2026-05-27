import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
