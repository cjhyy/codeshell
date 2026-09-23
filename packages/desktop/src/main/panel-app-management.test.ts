import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsManager,
  installReviewedLocalPanelApp,
  previewLocalPanelApp,
  listProjectPanelApps,
} from "@cjhyy/code-shell-core";
import { createPanelManagement } from "@cjhyy/code-shell-server/panels";
import { createDesktopPanelManagement } from "./panel-app-management.js";

const originalHome = process.env.HOME;
let root: string;
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (root) rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  root = realpathSync(mkdtempSync(join(tmpdir(), "desktop-panel-management-")));
  process.env.HOME = join(root, "home");
  const cwd = join(root, "project");
  mkdirSync(cwd);
  async function install(id: string, version = "1.0.0", overwrite = false) {
    const source = join(root, id);
    mkdirSync(join(source, ".codeshell-panel"), { recursive: true });
    mkdirSync(join(source, "app"), { recursive: true });
    writeFileSync(join(source, "app/index.html"), `${id}:${version}`);
    writeFileSync(
      join(source, ".codeshell-panel/panel.json"),
      JSON.stringify({
        schemaVersion: 1,
        id,
        version,
        title: { default: id },
        entry: "app/index.html",
        placement: "right-dock",
        icon: "panel",
        singleton: true,
        permissions: ["storage"],
      }),
    );
    const input = { kind: "dir" as const, path: source };
    const preview = await previewLocalPanelApp(input);
    return installReviewedLocalPanelApp(input, preview.reviewToken, new Date().toISOString(), {
      overwrite,
    });
  }
  return { cwd, install };
}
const context = { ownerId: "desktop", authorize: () => true };

test("Desktop binds exact project bytes, preserves another device's unrelated changes, and rejects a stale toggle", async () => {
  const { cwd, install } = await fixture();
  const first = await install("first-panel");
  await install("second-panel");
  const settings = new SettingsManager(cwd, "full");
  settings.mutateSettingsForScope("project", cwd, (value) => {
    value.panelAppOverrides = { "first-panel": "off", "second-panel": "on" };
  });
  let changes = 0;
  const desktop = createDesktopPanelManagement(cwd, {
    onChanged: () => {
      changes++;
    },
  });
  const phone = createPanelManagement({ cwd, projectPackages: true });
  const displayed = (await desktop.snapshot()).find((app) => app.appId === first.id)!;
  const phoneSecond = (await phone.snapshot()).panels.find((app) => app.id === "second-panel")!;
  await phone.binding(context, "second-panel", true, phoneSecond.revision);
  const next = await desktop.binding(context, first.id, true, displayed.revision);
  expect(changes).toBe(1);
  let project = settings.getRawForScope("project", cwd, { strict: true });
  expect(project.panelAppBindings).toEqual(["first-panel", "second-panel"]);
  expect(project.panelAppOverrides).toEqual({});
  expect(project.panelAppPins).toMatchObject({
    [first.id]: { version: "1.0.0", packageDigest: first.packageDigest },
  });
  const bound = next.find((app) => app.appId === first.id)!;
  await phone.binding(context, first.id, false, bound.revision);
  await expect(desktop.binding(context, first.id, true, bound.revision)).rejects.toThrow(
    "配置已改变",
  );
  expect(changes).toBe(1);
  project = settings.getRawForScope("project", cwd, { strict: true });
  expect(project.panelAppBindings).toEqual(["second-panel"]);
  expect((project.panelAppPins as Record<string, unknown>)[first.id]).toBeUndefined();
});

test("Desktop rebind keeps the project's older pin after a catalog upgrade; new projects select new bytes", async () => {
  const { cwd, install } = await fixture();
  const old = await install("test-panel");
  const desktop = createDesktopPanelManagement(cwd);
  const initial = (await desktop.snapshot())[0]!;
  await desktop.binding(context, old.id, true, initial.revision);
  const pinned = (await desktop.snapshot())[0]!;
  const latest = await install(old.id, "2.0.0", true);
  expect((await desktop.snapshot())[0]!.revision).toBe(pinned.revision);
  await desktop.binding(context, old.id, true, pinned.revision);
  expect((await listProjectPanelApps(cwd))[0]!.packageDigest).toBe(old.packageDigest);
  const otherCwd = join(root, "other");
  mkdirSync(otherCwd);
  const other = createDesktopPanelManagement(otherCwd);
  const available = (await other.snapshot())[0]!;
  await other.binding(context, old.id, true, available.revision);
  expect((await listProjectPanelApps(otherCwd))[0]!.packageDigest).toBe(latest.packageDigest);
});

test("Desktop mutations recheck authorization after awaiting the host gate and reject malformed requests", async () => {
  const { cwd, install } = await fixture();
  await install("test-panel");
  let authorized = true;
  const desktop = createDesktopPanelManagement(cwd, {
    withMutation: async (write) => {
      authorized = false;
      return write();
    },
  });
  const app = (await desktop.snapshot())[0]!;
  await expect(
    desktop.binding(
      { ownerId: "window", authorize: () => authorized },
      app.appId,
      true,
      app.revision,
    ),
  ).rejects.toThrow("登录已失效");
  expect((await desktop.snapshot())[0]!.bound).toBe(false);
  await expect(desktop.binding(context, app.appId, "true", app.revision)).rejects.toThrow(
    "参数无效",
  );
  await expect(desktop.binding(context, app.appId, true, "stale")).rejects.toThrow("参数无效");
});

test("a snapshot interrupted by another device never returns an old bound flag with a current revision", async () => {
  const { cwd, install } = await fixture();
  await install("test-panel");
  let changed = false;
  const api = createPanelManagement({
    cwd,
    projectPackages: true,
    compatibility: () => {
      if (!changed) {
        changed = true;
        new SettingsManager(cwd, "full").mutateSettingsForScope("project", cwd, (value) => {
          value.panelAppBindings = ["test-panel"];
        });
      }
      return { supported: true, reasons: [] };
    },
  });
  await expect(api.snapshot()).rejects.toThrow("配置已改变");
  expect((await api.snapshot()).panels[0]!.bound).toBe(true);
});
