import React, { act } from "react";
import { afterEach, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { createRoot } from "../../../../packages/desktop/node_modules/react-dom/client.js";
import { ensureMiniDom, flushMicrotasks } from "../../../../packages/web/src/test-utils/renderHook.tsx";

// Install guards BEFORE Core-facing imports. Git subprocesses can only use local files.
const deny = (..._args: unknown[]): never => { throw new Error("NETWORK_FORBIDDEN"); };
globalThis.fetch = deny as typeof fetch;
http.request = deny as typeof http.request; http.get = deny as typeof http.get;
https.request = deny as typeof https.request; https.get = deny as typeof https.get;
net.connect = deny as typeof net.connect; net.createConnection = deny as typeof net.createConnection;
tls.connect = deny as typeof tls.connect;
process.env.GIT_ALLOW_PROTOCOL = "file";
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";
if (!process.env.CODE_SHELL_TEST_HOME || !process.env.HOME?.includes("codeshell-bun-completion-")) throw new Error("guarded runner with isolated HOME required");

const alerts: any[] = [], confirms: any[] = [];
mock.module("../../../../packages/desktop/src/renderer/ui/DialogProvider.tsx", () => ({
  useConfirm: () => async (value: unknown) => { confirms.push(value); return true; },
  useAlert: () => async (value: unknown) => { alerts.push(value); },
}));
const marketService = await import("../../../../packages/desktop/src/main/marketplace-service.ts");
const pluginService = await import("../../../../packages/desktop/src/main/plugins-service.ts");
const coreInternal = await import("../../../../packages/core/dist/index.internal.js");
const { readInstalledPlugins } = await import("../../../../packages/core/src/plugins/installedPlugins.ts");
const { MarketDetail } = await import("../../../../packages/desktop/src/renderer/extensions/MarketDetail.tsx");
const { PluginsTab } = await import("../../../../packages/desktop/src/renderer/extensions/PluginsTab.tsx");
const cleanup: Array<() => void | Promise<void>> = [];
const configurationTarget = { noRepo: true } as const;
function property(target: object, key: string, value: unknown) { const old = Object.getOwnPropertyDescriptor(target, key); Object.defineProperty(target, key, { configurable: true, writable: true, value }); cleanup.push(() => { if (old) Object.defineProperty(target, key, old); else Reflect.deleteProperty(target, key); }); }
function elements(node: any): any[] { if (Array.isArray(node)) return node.flatMap(elements); if (!React.isValidElement(node)) return []; return [node, ...elements((node.props as any).children)]; }
function textOf(node: any): string { if (Array.isArray(node)) return node.map(textOf).join(""); if (React.isValidElement(node)) return textOf((node.props as any).children); return typeof node === "string" || typeof node === "number" ? String(node) : ""; }
async function settle() { await act(async () => { await flushMicrotasks(); await new Promise(resolve => setTimeout(resolve, 5)); await flushMicrotasks(); }); }
async function until(predicate: () => boolean, label: string) { const start = Date.now(); while (!predicate()) { if (Date.now() - start > 5000) throw new Error(`fixture timeout: ${label}`); await settle(); } }
function git(cwd: string, ...args: string[]) { return execFileSync("/usr/bin/git", args, { cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
let serial = 0;
async function marketplaceFixture() {
  const base = mkdtempSync(join(tmpdir(), "codeshell-plugin-local-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const market = `fixture-market-${++serial}`, plugin = `fixture-plugin-${serial}`;
  const repo = join(base, `${market}.git`), payload = join(repo, "payload");
  mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
  mkdirSync(join(payload, ".codex-plugin"), { recursive: true });
  mkdirSync(join(payload, "skills", "hello"), { recursive: true });
  writeFileSync(join(payload, "skills", "hello", "SKILL.md"), "---\nname: hello\ndescription: inert fixture\n---\nNo executable behavior.\n");
  writeFileSync(join(payload, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "1.0.0" }));
  writeFileSync(join(repo, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: market, owner: { name: "Local Fixture" }, plugins: [{ name: plugin, source: "./payload", version: "1.0.0" }] }));
  git(repo, "init", "--initial-branch=main"); git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "user.name", "Fixture"); git(repo, "add", "."); git(repo, "commit", "-m", "inert local plugin v1");
  const added = await marketService.addMarketplaceFromInput(repo); expect(added).toMatchObject({ ok: true, name: market });
  const key = `${plugin}@${market}`;
  const catalog = () => pluginService.listPlugins("").find(p => p.installKey === key);
  const rewrite = (value: string) => { writeFileSync(join(payload, ".codex-plugin", "plugin.json"), value); git(repo, "add", "."); git(repo, "commit", "-m", "fixture source changed"); };
  return { market, plugin, repo, payload, key, catalog, rewrite };
}
function bridge(extra: Record<string, any> = {}) {
  ensureMiniDom();
  property(window, "codeshell", {
    loadMarketplace: async (name: string) => marketService.loadMarketplaceForUi(name),
    listPlugins: async () => pluginService.listPlugins(""),
    listPluginInstallJobs: async () => marketService.listPluginInstallJobsForUi(),
    onPluginInstallJobsChanged: marketService.onPluginInstallJobsChanged,
    installPlugin: marketService.installPluginForUi,
    retryPluginInstallJob: marketService.retryPluginInstallJobForUi,
    checkPluginUpdate: pluginService.checkPluginUpdateEntry,
    updatePlugin: pluginService.updatePluginEntry,
    uninstallPlugin: async (name: string, market: string) => pluginService.uninstallPluginEntry(name, market),
    uninstallLocalPlugin: async (name: string) => pluginService.uninstallLocalPluginEntry(name),
    ...extra,
  });
}
async function mountView(render: () => React.ReactNode) {
  ensureMiniDom(); const root = createRoot(document.createElement("div")); let tree: React.ReactNode;
  function Harness() { tree = render(); return null; }
  await act(async () => { root.render(<Harness />); await flushMicrotasks(); });
  let alive = true;
  const unmount = async () => { if (!alive) return; alive = false; await act(async () => { root.unmount(); await flushMicrotasks(); }); };
  cleanup.push(unmount);
  const find = (predicate: (element: any) => boolean) => { const value = elements(tree).find(predicate); if (!value) throw new Error(`element missing in ${textOf(tree)}`); return value; };
  return { tree: () => tree, find, unmount };
}
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); alerts.length = 0; confirms.length = 0; });

test("confirmed: install then uninstall leaves an installed job that disables real MarketDetail reinstall and bypasses service reinstallation", async () => {
  const f = await marketplaceFixture(); bridge();
  const onInstalled = () => undefined;
  const view = await mountView(() => MarketDetail({ configurationTarget, marketName: f.market, onBack() {}, onInstalled }));
  await until(() => textOf(view.tree()).includes("安装"), "market load");
  const install = view.find(e => typeof e.props.onClick === "function" && textOf(e.props.children) === "安装");
  expect(install.props.disabled).toBe(false);
  await act(async () => { install.props.onClick(); await flushMicrotasks(); });
  await until(() => !!f.catalog() && marketService.listPluginInstallJobsForUi().find(j => j.id === `${f.market}::${f.plugin}`)?.status === "installed", "installation");
  const installedPath = f.catalog()!.installPath;
  expect(existsSync(join(installedPath, "skills", "hello", "SKILL.md"))).toBe(true);
  await view.unmount();
  const management = await mountView(() => PluginsTab({ cwd: "/tmp/fixture", configurationTarget, query: f.plugin, isEnabled: () => true, onToggle() {}, onChanged() {} }));
  await until(() => textOf(management.tree()).includes(f.plugin), "installed plugins list");
  const uninstall = management.find(e => typeof e.props.onSelect === "function" && textOf(e.props.children) === "卸载");
  await act(async () => { uninstall.props.onSelect(); await flushMicrotasks(); });
  await until(() => !f.catalog(), "renderer uninstall");
  expect(confirms).toHaveLength(1); expect(confirms[0].destructive).toBe(true);
  await management.unmount();
  expect(f.catalog()).toBeUndefined(); expect(existsSync(installedPath)).toBe(false);
  expect(readInstalledPlugins().plugins[f.key]).toBeUndefined();
  const reopened = await mountView(() => MarketDetail({ configurationTarget, marketName: f.market, onBack() {}, onInstalled }));
  await until(() => textOf(reopened.tree()).includes("已安装"), "reopened market");
  const stale = reopened.find(e => typeof e.props.onClick === "function" && textOf(e.props.children) === "已安装");
  expect(stale.props.disabled).toBe(true);
  const retry = await marketService.installPluginForUi(f.plugin, f.market);
  expect(retry).toMatchObject({ ok: true, job: { status: "installed" } });
  await settle(); expect(f.catalog()).toBeUndefined(); expect(existsSync(installedPath)).toBe(false);
  console.log("PLUGIN_UNINSTALL_REINSTALL_BLOCKED", JSON.stringify({ registryPresent: !!readInstalledPlugins().plugins[f.key], diskPresent: existsSync(installedPath), jobStatus: retry.job?.status, reinstallButtonDisabled: stale.props.disabled }));
  await reopened.unmount();
  // A new service module models the empty in-memory queue in a new Main process.
  const freshService = await import("../../../../packages/desktop/src/main/marketplace-service.ts?fresh-main-instance");
  expect((await freshService.installPluginForUi(f.plugin, f.market)).ok).toBe(true);
  await until(() => freshService.listPluginInstallJobsForUi().find(j => j.id === `${f.market}::${f.plugin}`)?.status === "installed", "fresh service reinstall");
  expect(f.catalog()).toBeDefined(); expect(existsSync(installedPath)).toBe(true);
});

test("confirmed: actual PluginsTab update action loses previous marketplace path-source install when new plugin manifest is invalid", async () => {
  const f = await marketplaceFixture(); const installed = await coreInternal.installPlugin(f.plugin, f.market);
  if (!installed.ok) throw new Error(installed.error);
  const oldPath = installed.entry.installPath;
  const oldManifest = readFileSync(join(oldPath, ".codex-plugin", "plugin.json"), "utf8");
  expect(f.catalog()).toBeDefined(); expect(oldManifest).toContain("1.0.0");
  f.rewrite("{ invalid new plugin manifest");
  bridge(); let changed = 0;
  const view = await mountView(() => PluginsTab({ cwd: "/tmp/fixture", configurationTarget, query: f.plugin, isEnabled: () => true, onToggle() {}, onChanged: () => changed++ }));
  await until(() => textOf(view.tree()).includes(f.plugin), "plugins list");
  const update = view.find(e => typeof e.props.onSelect === "function" && textOf(e.props.children) === "更新");
  await act(async () => { update.props.onSelect(); await flushMicrotasks(); });
  await until(() => alerts.length > 0, "update failure alert");
  expect(String(alerts[0].message)).toContain("invalid plugin manifest");
  expect(changed).toBe(0);
  expect(existsSync(oldPath)).toBe(false);
  expect(f.catalog()).toBeUndefined();
  expect(readInstalledPlugins().plugins[f.key]?.[0]?.installPath).toBe(oldPath);
  expect(textOf(view.tree())).toContain(f.plugin);
  await expect(pluginService.updatePluginEntry(f.key)).rejects.toThrow("no installed plugin");
  console.log("MARKET_UPDATE_OLD_PLUGIN_LOST", JSON.stringify({ oldDiskPresent: existsSync(oldPath), runtimeCatalogPresent: !!f.catalog(), registryEntryPresent: !!readInstalledPlugins().plugins[f.key], failedAlert: true, unchangedListStillHasRow: textOf(view.tree()).includes(f.plugin) }));
  // Once the marketplace author fixes the manifest, reinstall repairs the stale registry.
  await view.unmount();
  f.rewrite(JSON.stringify({ name: f.plugin, version: "2.0.0" }));
  expect((await marketService.refreshMarketplaceForUi(f.market)).ok).toBe(true);
  expect((await marketService.installPluginForUi(f.plugin, f.market)).ok).toBe(true);
  await until(() => !!f.catalog() && marketService.listPluginInstallJobsForUi().find(j => j.id === `${f.market}::${f.plugin}`)?.status === "installed", "repair marketplace install");
  expect(existsSync(oldPath)).toBe(true);
  expect(readInstalledPlugins().plugins[f.key]).toHaveLength(1);
  expect(readFileSync(join(oldPath, ".codex-plugin", "plugin.json"), "utf8")).toContain("2.0.0");
});

test("normal: a marketplace install job that failed before installation can retry successfully after source correction", async () => {
  const f = await marketplaceFixture();
  f.rewrite("{ invalid plugin");
  const refreshed = await marketService.refreshMarketplaceForUi(f.market); expect(refreshed.ok).toBe(true);
  const queued = await marketService.installPluginForUi(f.plugin, f.market); expect(queued.ok).toBe(true);
  await until(() => marketService.listPluginInstallJobsForUi().find(j => j.id === `${f.market}::${f.plugin}`)?.status === "failed", "failed install");
  expect(f.catalog()).toBeUndefined();
  f.rewrite(JSON.stringify({ name: f.plugin, version: "2.0.0" }));
  expect((await marketService.refreshMarketplaceForUi(f.market)).ok).toBe(true);
  const retried = await marketService.retryPluginInstallJobForUi(`${f.market}::${f.plugin}`); expect(retried.ok).toBe(true);
  await until(() => marketService.listPluginInstallJobsForUi().find(j => j.id === `${f.market}::${f.plugin}`)?.status === "installed", "retry install");
  expect(f.catalog()).toBeDefined();
  expect(readFileSync(join(f.catalog()!.installPath, ".codex-plugin", "plugin.json"), "utf8")).toContain("2.0.0");
});

test("normal: valid marketplace update changes installed content and stays in runtime catalog", async () => {
  const f = await marketplaceFixture();
  const installed = await coreInternal.installPlugin(f.plugin, f.market); if (!installed.ok) throw new Error(installed.error);
  f.rewrite(JSON.stringify({ name: f.plugin, version: "2.0.0" }));
  expect(await pluginService.updatePluginEntry(f.key)).toMatchObject({ updated: true });
  expect(f.catalog()).toBeDefined();
  expect(readFileSync(join(f.catalog()!.installPath, ".codex-plugin", "plugin.json"), "utf8")).toContain("2.0.0");
});

test("confirmed: Desktop reviewed local install records a deleted snapshot as source and cannot update from still-present original directory", async () => {
  const base = mkdtempSync(join(tmpdir(), "codeshell-plugin-local-atomic-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const plugin = `fixture-local-atomic-${++serial}`;
  mkdirSync(join(base, ".codex-plugin"), { recursive: true }); writeFileSync(join(base, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "1.0.0" }));
  bridge({
    pickPluginSource: async () => ({ kind: "dir", path: base, name: plugin }),
    previewLocalPlugin: marketService.previewLocalPluginForUi,
    installLocalPlugin: marketService.installLocalPluginForUi,
  });
  const view = await mountView(() => PluginsTab({ cwd: "/tmp/fixture", configurationTarget, query: plugin, isEnabled: () => true, onToggle() {}, onChanged() {} }));
  await until(() => elements(view.tree()).some(e => typeof e.props.onClick === "function" && textOf(e.props.children) === "从文件夹"), "local directory install action");
  const chooseDirectory = view.find(e => typeof e.props.onClick === "function" && textOf(e.props.children) === "从文件夹");
  await act(async () => { chooseDirectory.props.onClick(); await flushMicrotasks(); });
  await until(() => elements(view.tree()).some(e => typeof e.props.onInstall === "function"), "review dialog");
  const review = view.find(e => typeof e.props.onInstall === "function");
  expect(review.props.preview.name).toBe(plugin);
  expect(review.props.preview.source.kind).toBe("dir");
  await act(async () => { review.props.onInstall(); await flushMicrotasks(); });
  await until(() => pluginService.listPlugins("").some(p => p.installKey === `${plugin}@local`), "reviewed GUI installation");
  const old = pluginService.listPlugins("").find(p => p.installKey === `${plugin}@local`)!;
  const before = readFileSync(join(old.installPath, ".cs-meta.json"), "utf8");
  const meta = JSON.parse(before);
  expect(meta.source).toContain("cs-plugin-reviewed-"); expect(existsSync(meta.source)).toBe(false);
  expect(existsSync(base)).toBe(true);
  writeFileSync(join(base, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "2.0.0" }));
  await until(() => textOf(view.tree()).includes(plugin), "reviewed local plugin list");
  const update = view.find(e => typeof e.props.onSelect === "function" && textOf(e.props.children) === "更新");
  await act(async () => { update.props.onSelect(); await flushMicrotasks(); });
  await until(() => alerts.length > 0, "reviewed local update failure");
  expect(String(alerts[0].message)).toContain("source no longer exists");
  expect(readFileSync(join(old.installPath, ".cs-meta.json"), "utf8")).toBe(before);
  expect(pluginService.listPlugins("").some(p => p.installKey === `${plugin}@local`)).toBe(true);
  expect(readInstalledPlugins().plugins[`${plugin}@local`]).toHaveLength(1);
  console.log("LOCAL_REVIEW_TEMP_SOURCE_UPDATE_BROKEN", JSON.stringify({ originalSourcePresent: existsSync(base), storedSourceIsPrivateSnapshot: meta.source.includes("cs-plugin-reviewed-"), storedSourcePresent: existsSync(meta.source), installedVersion: meta.version, requestedSourceVersion: "2.0.0" }));
});

test("normal: directly installed local plugin update uses durable source and atomically restores old files/registration on invalid source", async () => {
  const base = mkdtempSync(join(tmpdir(), "codeshell-plugin-direct-atomic-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const plugin = `fixture-direct-atomic-${++serial}`;
  mkdirSync(join(base, ".codex-plugin"), { recursive: true }); writeFileSync(join(base, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "1.0.0" }));
  await coreInternal.installPluginFromPath(base, plugin, "2026-10-12T00:00:00.000Z");
  const old = pluginService.listPlugins("").find(p => p.installKey === `${plugin}@local`)!;
  expect(JSON.parse(readFileSync(join(old.installPath, ".cs-meta.json"), "utf8")).source).toBe(base);
  writeFileSync(join(base, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "2.0.0" }));
  expect(await pluginService.updatePluginEntry(`${plugin}@local`)).toMatchObject({ updated: true });
  const before = readFileSync(join(old.installPath, ".cs-meta.json"), "utf8");
  expect(JSON.parse(before).source).toBe(base);
  expect(JSON.parse(before).version).toBe("2.0.0");
  writeFileSync(join(base, ".codex-plugin", "plugin.json"), "{ invalid new source");
  await expect(pluginService.updatePluginEntry(`${plugin}@local`)).rejects.toThrow("old version");
  expect(readFileSync(join(old.installPath, ".cs-meta.json"), "utf8")).toBe(before);
  expect(pluginService.listPlugins("").some(p => p.installKey === `${plugin}@local`)).toBe(true);
  expect(readInstalledPlugins().plugins[`${plugin}@local`]).toHaveLength(1);
});

test("normal: source changed after local preview is rejected before installation", async () => {
  const base = mkdtempSync(join(tmpdir(), "codeshell-plugin-review-change-")); cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const plugin = `fixture-review-change-${++serial}`;
  mkdirSync(join(base, ".codex-plugin"), { recursive: true }); writeFileSync(join(base, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "1.0.0" }));
  const preview = await marketService.previewLocalPluginForUi({ kind: "dir", path: base }); if (!preview.ok) throw new Error(preview.error);
  writeFileSync(join(base, ".codex-plugin", "plugin.json"), JSON.stringify({ name: plugin, version: "2.0.0" }));
  expect(await marketService.installLocalPluginForUi({ kind: "dir", path: base, reviewToken: preview.preview.reviewToken })).toMatchObject({ ok: false, previewChanged: true });
  expect(pluginService.listPlugins("").some(p => p.installKey === `${plugin}@local`)).toBe(false);
});
