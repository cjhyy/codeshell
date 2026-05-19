import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  knownMarketplacesPath,
  readKnownMarketplaces,
  writeKnownMarketplaces,
  upsertKnownMarketplace,
  removeKnownMarketplace,
} from "../src/plugins/knownMarketplaces.js";
import {
  installedPluginsPath,
  readInstalledPlugins,
  writeInstalledPlugins,
  appendInstallEntry,
  removeInstallEntries,
  pluginInstallKey,
} from "../src/plugins/installedPlugins.js";

describe("plugin persistence", () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "plugins-persist-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  describe("knownMarketplaces", () => {
    it("returns {} when file missing", () => {
      expect(readKnownMarketplaces()).toEqual({});
    });

    it("round-trip write then read", () => {
      writeKnownMarketplaces({
        skills: {
          source: { source: "github", repo: "anthropics/skills" },
          installLocation: "/abs/path",
          lastUpdated: "2026-05-19T00:00:00.000Z",
        },
      });
      const back = readKnownMarketplaces();
      expect(back.skills?.source).toEqual({ source: "github", repo: "anthropics/skills" });
    });

    it("upsert adds and replaces", () => {
      upsertKnownMarketplace("m1", {
        source: { source: "git", url: "https://x.git" },
        installLocation: "/a",
        lastUpdated: "t1",
      });
      upsertKnownMarketplace("m1", {
        source: { source: "git", url: "https://x.git" },
        installLocation: "/a",
        lastUpdated: "t2",
      });
      const back = readKnownMarketplaces();
      expect(back.m1?.lastUpdated).toBe("t2");
    });

    it("remove returns true only when present", () => {
      upsertKnownMarketplace("m1", {
        source: { source: "git", url: "https://x.git" },
        installLocation: "/a",
        lastUpdated: "t",
      });
      expect(removeKnownMarketplace("m1")).toBe(true);
      expect(removeKnownMarketplace("nope")).toBe(false);
    });

    it("corrupt JSON falls back to {}", () => {
      const p = knownMarketplacesPath();
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "{ not json");
      expect(readKnownMarketplaces()).toEqual({});
    });

    it("writes with trailing newline", () => {
      writeKnownMarketplaces({});
      const raw = readFileSync(knownMarketplacesPath(), "utf-8");
      expect(raw.endsWith("\n")).toBe(true);
    });
  });

  describe("installedPlugins", () => {
    it("returns empty v2 when file missing", () => {
      expect(readInstalledPlugins()).toEqual({ version: 2, plugins: {} });
    });

    it("round-trip write then read", () => {
      writeInstalledPlugins({
        version: 2,
        plugins: {
          "p1@m1": [
            {
              scope: "user",
              installPath: "/abs/p1",
              version: "abc123",
              installedAt: "t",
              lastUpdated: "t",
            },
          ],
        },
      });
      const back = readInstalledPlugins();
      expect(back.plugins["p1@m1"]).toHaveLength(1);
      expect(back.plugins["p1@m1"]![0]!.installPath).toBe("/abs/p1");
    });

    it("appendInstallEntry creates list and adds", () => {
      appendInstallEntry("p@m", {
        scope: "user",
        installPath: "/a",
        version: "v1",
        installedAt: "t",
        lastUpdated: "t",
      });
      appendInstallEntry("p@m", {
        scope: "user",
        installPath: "/a",
        version: "v2",
        installedAt: "t",
        lastUpdated: "t",
      });
      const back = readInstalledPlugins();
      expect(back.plugins["p@m"]).toHaveLength(2);
      expect(back.plugins["p@m"]!.map((e) => e.version)).toEqual(["v1", "v2"]);
    });

    it("removeInstallEntries returns false if key absent", () => {
      expect(removeInstallEntries("nope@nope")).toBe(false);
    });

    it("removeInstallEntries clears the key when present", () => {
      appendInstallEntry("p@m", {
        scope: "user",
        installPath: "/a",
        version: "v1",
        installedAt: "t",
        lastUpdated: "t",
      });
      expect(removeInstallEntries("p@m")).toBe(true);
      expect(readInstalledPlugins().plugins["p@m"]).toBeUndefined();
    });

    it("corrupt JSON falls back to empty v2", () => {
      const p = installedPluginsPath();
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, "{ not json");
      expect(readInstalledPlugins()).toEqual({ version: 2, plugins: {} });
    });

    it("rejects v1 file shape (returns empty)", () => {
      const p = installedPluginsPath();
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, JSON.stringify({ version: 1, plugins: [] }));
      expect(readInstalledPlugins()).toEqual({ version: 2, plugins: {} });
    });

    it("pluginInstallKey formats <plugin>@<marketplace>", () => {
      expect(pluginInstallKey("docs", "anthropic")).toBe("docs@anthropic");
    });
  });
});
