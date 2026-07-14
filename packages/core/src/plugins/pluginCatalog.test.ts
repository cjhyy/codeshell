import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledPluginsV2, PluginInstallEntry } from "./types.js";
import { loadPluginCatalog, loadPluginPanelContributions } from "./pluginCatalog.js";

function installEntry(installPath: string, version = "1.0.0"): PluginInstallEntry {
  return {
    scope: "user",
    installPath,
    version,
    installedAt: "2026-07-14T00:00:00.000Z",
    lastUpdated: "2026-07-14T00:00:00.000Z",
  };
}

describe("loadPluginCatalog", () => {
  test("core loads canonical panels and rejects installed paths outside its plugin root", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-plugin-catalog-"));
    const outside = mkdtempSync(join(tmpdir(), "cs-plugin-outside-"));
    try {
      const insights = join(root, "insights");
      const legacy = join(root, "legacy");
      mkdirSync(insights, { recursive: true });
      mkdirSync(legacy, { recursive: true });
      writeFileSync(
        join(insights, ".cs-plugin-manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: "build-insights",
          version: "1.0.0",
          panels: {
            version: 1,
            entries: [
              {
                id: "dashboard",
                title: { default: "Build dashboard" },
                entry: "panels/dashboard/index.html",
              },
            ],
          },
        }),
      );

      const installed: InstalledPluginsV2 = {
        version: 2,
        plugins: {
          "build-insights@local": [installEntry(insights)],
          "legacy@local": [installEntry(legacy, "legacy")],
          "escape@local": [installEntry(outside)],
        },
      };

      const catalog = loadPluginCatalog({ root, installed });
      expect(catalog.map((plugin) => plugin.installKey)).toEqual([
        "build-insights@local",
        "legacy@local",
      ]);
      expect(catalog[0]).toMatchObject({
        name: "build-insights",
        marketplace: "local",
        installPath: realpathSync(insights),
      });
      expect(catalog[0].panels).toEqual([
        expect.objectContaining({
          id: "dashboard",
          entry: "panels/dashboard/index.html",
          permissions: [],
        }),
      ]);
      expect(catalog[1].manifest).toBeNull();
      expect(catalog[1].panels).toEqual([]);

      expect(loadPluginPanelContributions({ root, installed })).toEqual([
        expect.objectContaining({
          kind: "panel",
          installKey: "build-insights@local",
          pluginName: "build-insights",
          panel: expect.objectContaining({ id: "dashboard" }),
        }),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("skips an unsafe scope row and loads the next safe row for the same key", () => {
    const root = mkdtempSync(join(tmpdir(), "cs-plugin-catalog-scope-"));
    const outside = mkdtempSync(join(tmpdir(), "cs-plugin-outside-scope-"));
    try {
      const safe = join(root, "safe");
      mkdirSync(safe, { recursive: true });
      const catalog = loadPluginCatalog({
        root,
        installed: {
          version: 2,
          plugins: { "safe@local": [installEntry(outside), installEntry(safe)] },
        },
      });
      expect(catalog).toHaveLength(1);
      expect(catalog[0].installPath).toBe(realpathSync(safe));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
