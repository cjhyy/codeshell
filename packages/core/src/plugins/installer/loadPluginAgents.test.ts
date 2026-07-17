import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pluginAgentDirs } from "./loadPluginAgents.js";
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";

describe("pluginAgentDirs", () => {
  let home: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-pa-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  test("returns agents dir for each registered plugin, skips disabled", () => {
    const p = join(home, ".code-shell", "plugins", "p1");
    mkdirSync(join(p, "agents"), { recursive: true });
    appendInstallEntry(pluginInstallKey("p1", "local"), {
      scope: "user",
      installPath: p,
      version: "1",
      installedAt: "t",
      lastUpdated: "t",
    });
    // pluginName is carried so a plugin agent's bare skill allowlist can be
    // namespaced (`director-skill` → `p1:director-skill`) at spawn time.
    expect(pluginAgentDirs([])).toEqual([
      { dir: join(p, "agents"), source: "plugin", pluginName: "p1" },
    ]);
    expect(pluginAgentDirs(["p1"])).toEqual([]);
  });

  test("omits plugins without an agents dir", () => {
    const p = join(home, ".code-shell", "plugins", "p2");
    mkdirSync(p, { recursive: true });
    appendInstallEntry(pluginInstallKey("p2", "local"), {
      scope: "user",
      installPath: p,
      version: "1",
      installedAt: "t",
      lastUpdated: "t",
    });
    expect(pluginAgentDirs([])).toEqual([]);
  });

  test("omits an agents directory symlink that escapes the plugin root", () => {
    if (process.platform === "win32") return;
    const p = join(home, ".code-shell", "plugins", "p3");
    const outside = mkdtempSync(join(tmpdir(), "cs-pa-outside-"));
    mkdirSync(p, { recursive: true });
    symlinkSync(outside, join(p, "agents"));
    appendInstallEntry(pluginInstallKey("p3", "local"), {
      scope: "user",
      installPath: p,
      version: "1",
      installedAt: "t",
      lastUpdated: "t",
    });
    try {
      expect(pluginAgentDirs([])).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
