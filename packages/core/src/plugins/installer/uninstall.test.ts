import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uninstallPluginByName } from "./uninstall.js";
import { installPluginFromPath } from "./install.js";
import { readInstalledPlugins } from "../installedPlugins.js";

describe("uninstallPluginByName", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-un-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-un-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("removes the dir and the registry entry", () => {
    const dir = installPluginFromPath(src, "gone", "t");
    expect(existsSync(dir)).toBe(true);
    uninstallPluginByName("gone");
    expect(existsSync(dir)).toBe(false);
    expect(readInstalledPlugins().plugins["gone@local"]).toBeUndefined();
  });

  test("throws on unknown plugin", () => {
    expect(() => uninstallPluginByName("nope")).toThrow(/no plugin/);
  });

  test("rejects unsafe names", () => {
    expect(() => uninstallPluginByName("../evil")).toThrow();
  });
});
