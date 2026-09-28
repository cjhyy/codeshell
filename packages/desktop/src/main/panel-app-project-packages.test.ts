import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsManager,
  installReviewedLocalPanelApp,
  previewLocalPanelApp,
  uninstallPanelApp,
  type InstalledPanelApp,
} from "@cjhyy/code-shell-core";
import {
  projectPanelAppInspectionCache,
  isPanelAppDescriptorSelected,
} from "./panel-app-project-packages.js";
import type { PanelAppDescriptor } from "../shared/panel-apps.js";

let root: string | undefined;
const home = process.env.HOME;
afterEach(() => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  if (root) rmSync(root, { recursive: true, force: true });
});

test("Desktop caches follow each project's pin even when both immutable versions remain unchanged", async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "desktop-project-packages-")));
  process.env.HOME = join(root, "home");
  const source = join(root, "source"),
    first = join(root, "one"),
    second = join(root, "two");
  for (const path of [first, second, join(source, "app"), join(source, ".codeshell-panel")])
    mkdirSync(path, { recursive: true });
  async function install(version: string, overwrite = false) {
    writeFileSync(
      join(source, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "test-panel",
        title: { default: "Test" },
        version,
        entry: "app/index.html",
        placement: "right-dock",
        icon: "panel",
        singleton: true,
        permissions: ["storage"],
      }),
    );
    writeFileSync(join(source, "app/index.html"), version);
    const input = { kind: "dir" as const, path: source };
    const preview = await previewLocalPanelApp(input);
    return installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString(), {
      overwrite,
    });
  }
  function pin(project: string, app: InstalledPanelApp, version = app.version) {
    new SettingsManager(project, "full").mutateSettingsForScope("project", project, (settings) => {
      settings.panelAppBindings = [app.id];
      settings.panelAppPins = { [app.id]: { version, packageDigest: app.packageDigest } };
    });
  }
  const old = await install("1.0.0");
  pin(first, old);
  pin(second, old);
  const a = projectPanelAppInspectionCache(first),
    b = projectPanelAppInspectionCache(second);
  expect((await a.get(old.id))?.version).toBe("1.0.0");
  expect((await b.get(old.id))?.version).toBe("1.0.0");
  const next = await install("2.0.0", true);
  pin(first, next);
  const selected = (await a.get(old.id))!;
  expect(selected.version).toBe("2.0.0");
  expect(selected.installPath).toContain("/.versions/");
  expect((await b.get(old.id))?.version).toBe("1.0.0");
  const descriptor = {
    appId: old.id,
    version: next.version,
    packageDigest: next.packageDigest,
    packagePinned: true,
  } as PanelAppDescriptor;
  expect(isPanelAppDescriptorSelected(descriptor, first)).toBe(true);
  expect(isPanelAppDescriptorSelected(descriptor, second)).toBe(false);
  // Same digest/path with a mismatched manifest version must invalidate a warm cache.
  pin(first, next, "9.0.0");
  expect(await a.get(old.id)).toBeUndefined();
  expect(isPanelAppDescriptorSelected(descriptor, first)).toBe(false);
  pin(first, old);
  expect((await a.get(old.id))?.version).toBe("1.0.0");
  writeFileSync(join(first, ".code-shell/settings.json"), '{"panelAppPins":null}');
  expect(await a.get(old.id)).toBeUndefined();
  expect(isPanelAppDescriptorSelected(descriptor, first)).toBe(false);
  expect((await b.get(old.id))?.version).toBe("1.0.0");
  await uninstallPanelApp(old.id);
  expect(await b.get(old.id)).toBeUndefined();
});
