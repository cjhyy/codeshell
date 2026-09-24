import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  readFileSync,
  cpSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SettingsManager,
  installReviewedLocalPanelApp,
  previewLocalPanelApp,
  listProjectPanelApps,
  panelAppPackageDir,
} from "@cjhyy/code-shell-core";
import { createPanelManagement } from "@cjhyy/code-shell-server/panels";
import { createProjectPanelAppUpdateService } from "./panel-app-update-service.js";
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

function changeSource(source: string, version: string) {
  const manifestPath = join(source, ".codeshell-panel/panel.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  manifest.permissions = ["storage", "context.workspace", "workspace.write"];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeFileSync(join(source, "app/index.html"), version);
}

test("a reviewed Desktop update uses the project's original source and only advances that project", async () => {
  const { cwd, install } = await fixture();
  const old = await install("test-panel");
  const first = createDesktopPanelManagement(cwd);
  await first.binding(context, old.id, true, (await first.snapshot())[0]!.revision);
  const secondCwd = join(root, "second");
  mkdirSync(secondCwd);
  const second = createDesktopPanelManagement(secondCwd);
  // Another project installs a different source and fixes version 3.0.0.
  const otherSource = join(root, "other-source");
  cpSync(join(root, old.id), otherSource, { recursive: true });
  changeSource(otherSource, "3.0.0");
  const otherInput = { kind: "dir" as const, path: otherSource };
  const otherReview = await second.previewSource(context, otherInput);
  await second.install(context, otherReview.reviewToken, { overwrite: true });
  changeSource(join(root, old.id), "2.0.0");
  const displayed = (await first.snapshot())[0]!;
  const check = await createProjectPanelAppUpdateService(cwd).check(old.id);
  expect(check).toMatchObject({
    currentVersion: "1.0.0",
    latestVersion: "2.0.0",
    status: "update-available",
  });
  const review = await first.previewUpdate(context, old.id, displayed.revision);
  expect(review).toMatchObject({
    installedVersion: "1.0.0",
    preview: { version: "2.0.0", permissions: ["storage", "context.workspace", "workspace.write"] },
  });
  await expect(second.install(context, review.reviewToken, { overwrite: true })).rejects.toThrow(
    "预览已失效",
  );
  await expect(
    first.install({ ...context, ownerId: "another-window" }, review.reviewToken, {
      overwrite: true,
    }),
  ).rejects.toThrow("当前设备重新预览");
  await expect(first.install(context, review.reviewToken, { overwrite: false })).rejects.toThrow(
    "确认项目更新",
  );
  await first.install(context, review.reviewToken, { overwrite: true, expectedId: old.id });
  expect((await first.snapshot())[0]!.version).toBe("2.0.0");
  expect((await second.snapshot())[0]!.version).toBe("3.0.0");
  expect((await listProjectPanelApps(cwd))[0]!.source).toBe(join(root, old.id));
  await expect(first.install(context, review.reviewToken, { overwrite: true })).rejects.toThrow(
    "预览已失效",
  );
});

test("native review rejects phone changes and changed package bytes, and closing its owner revokes it", async () => {
  const { cwd, install } = await fixture();
  const app = await install("test-panel");
  const desktop = createDesktopPanelManagement(cwd);
  await desktop.binding(context, app.id, true, (await desktop.snapshot())[0]!.revision);
  changeSource(join(root, app.id), "2.0.0");
  const selected = (await desktop.snapshot())[0]!;
  const review = await desktop.previewUpdate(context, app.id, selected.revision);
  const phone = createPanelManagement({ cwd, projectPackages: true });
  await phone.binding(context, app.id, false, selected.revision);
  await expect(desktop.install(context, review.reviewToken, { overwrite: true })).rejects.toThrow(
    "面板已改变",
  );
  expect((await desktop.snapshot())[0]!.version).toBe("1.0.0");
  const fresh = await desktop.previewSource(context, { kind: "dir", path: join(root, app.id) });
  changeSource(join(root, app.id), "2.1.0");
  await expect(desktop.install(context, fresh.reviewToken, { overwrite: true })).rejects.toThrow();
  expect((await desktop.snapshot())[0]!.version).toBe("1.0.0");
  const last = await desktop.previewSource(context, { kind: "dir", path: join(root, app.id) });
  desktop.cancelOwner(context.ownerId);
  await expect(desktop.install(context, last.reviewToken, { overwrite: true })).rejects.toThrow(
    "预览已失效",
  );
});

test("a new native project installation commits its exact reviewed pin and cannot enable local sources on Web", async () => {
  const { cwd, install } = await fixture();
  const app = await install("seed-panel");
  const source = join(root, "new-source");
  cpSync(join(root, app.id), source, { recursive: true });
  const manifestPath = join(source, ".codeshell-panel/panel.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.id = "new-panel";
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const input = { kind: "dir" as const, path: source };
  const web = createPanelManagement({ cwd, projectPackages: true });
  await expect(web.previewProjectSource(context, input)).rejects.toThrow("不支持本地项目安装");
  const desktop = createDesktopPanelManagement(cwd);
  const review = await desktop.previewSource(context, input);
  const result = await desktop.install(context, review.reviewToken, { overwrite: false });
  const settings = new SettingsManager(cwd, "full").getRawForScope("project", cwd, {
    strict: true,
  });
  expect(settings.panelAppBindings).toEqual(["new-panel"]);
  expect(settings.panelAppPins).toEqual({
    "new-panel": { version: "1.0.0", packageDigest: result.packageDigest },
  });
});

test("Desktop diagnoses a broken package separately and repairs its binding through reviewed history", async () => {
  const { cwd, install } = await fixture();
  const first = await install("broken-panel");
  const healthy = await install("healthy-panel");
  const desktop = createDesktopPanelManagement(cwd);
  for (const state of await desktop.snapshot())
    await desktop.binding(context, state.appId, true, state.revision);
  const replacement = await install(first.id, "2.0.0", true);
  rmSync(panelAppPackageDir(first.id, first.packageDigest!), { recursive: true });
  const states = await desktop.snapshot();
  const issue = states.find((item) => item.appId === first.id)!;
  expect(issue).toMatchObject({ unavailable: true, version: "1.0.0", bound: true });
  expect(states.find((item) => item.appId === healthy.id)?.unavailable).toBeUndefined();
  const history = await desktop.packageHistory(context, issue.appId, issue.revision);
  expect(history.current.unavailable).toBe(true);
  const review = await desktop.previewRestore(
    context,
    issue.appId,
    replacement.packageDigest,
    issue.revision,
  );
  expect(review.addedPermissions).toEqual(review.permissions);
  await desktop.restore(context, review.reviewToken);
  expect((await desktop.snapshot()).find((item) => item.appId === first.id)).toMatchObject({
    version: "2.0.0",
  });
  desktop.close();
});
