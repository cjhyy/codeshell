import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uninstallPluginByName } from "./uninstall.js";
import { installPluginFromPath } from "./install.js";
import { uninstallPlugin } from "../pluginInstaller.js";
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";

function settingsPath(home: string): string {
  return join(home, ".code-shell", "settings.json");
}

function writeSettings(home: string, obj: unknown): void {
  const p = settingsPath(home);
  mkdirSync(join(home, ".code-shell"), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2));
}

function readSettings(home: string): {
  disabledSkills?: string[];
  disabledPlugins?: string[];
} {
  return JSON.parse(readFileSync(settingsPath(home), "utf-8"));
}

describe("uninstall prunes orphaned settings entries", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-prune-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-prune-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(
      join(src, "skills", "s", "SKILL.md"),
      "---\nname: s\ndescription: d\n---\nb",
    );
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("uninstallPluginByName (local) removes the plugin's disable entries", async () => {
    await installPluginFromPath(src, "myplug", "t");
    writeSettings(home, {
      disabledSkills: ["myplug:s", "keep:other"],
      disabledPlugins: ["myplug", "keep"],
    });

    uninstallPluginByName("myplug");

    const s = readSettings(home);
    expect(s.disabledSkills).toEqual(["keep:other"]);
    expect(s.disabledPlugins).toEqual(["keep"]);
  });

  test("uninstallPlugin (marketplace) removes the plugin's disable entries", () => {
    const installPath = join(home, "fake-install");
    mkdirSync(installPath, { recursive: true });
    appendInstallEntry(pluginInstallKey("mktplug", "shop"), {
      scope: "user",
      installPath,
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    });
    writeSettings(home, {
      disabledSkills: ["mktplug:director", "keep:s"],
      disabledPlugins: ["mktplug", "keep"],
    });

    uninstallPlugin("mktplug", "shop");

    const s = readSettings(home);
    expect(s.disabledSkills).toEqual(["keep:s"]);
    expect(s.disabledPlugins).toEqual(["keep"]);
  });
});
