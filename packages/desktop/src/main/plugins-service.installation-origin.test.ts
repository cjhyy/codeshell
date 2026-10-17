import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import children from "node:child_process";
import ts from "typescript";
import type { InstalledPluginsV2 } from "../../../core/src/plugins/types.js";

// No installer, updater, uninstaller, Engine, provider or native UI is run.
// The only real IO is an inventory of fixture-owned plugin directories/registry.
const attempts: string[] = [];
const restore: Array<() => void> = [];
function deny(kind: string): never {
  attempts.push(kind);
  throw new Error(`Owned plugin origin fixture denied ${kind}`);
}
function replace(object: any, key: string, value: unknown): void {
  const previous = object[key];
  object[key] = value;
  restore.push(() => (object[key] = previous));
}
replace(globalThis, "fetch", () => deny("fetch"));
for (const [object, keys, kind] of [
  [http, ["get", "request"], "http"],
  [https, ["get", "request"], "https"],
  [net, ["connect", "createConnection"], "socket"],
  [tls, ["connect"], "tls"],
  [
    children,
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    "process",
  ],
  [Bun, ["spawn", "spawnSync"], "bun-process"],
  [process, ["kill"], "signal"],
] as const)
  for (const key of keys) replace(object, key, () => deny(kind));
syncBuiltinESMExports();
for (const probe of [
  () => fetch("https://example.invalid/denied"),
  () => http.request("http://127.0.0.1:9/denied"),
  () => https.get("https://example.invalid/denied"),
  () => net.connect(9, "127.0.0.1"),
  () => tls.connect(443, "example.invalid"),
  () => children.spawn("owned-denied-executable", []),
  () => Bun.spawn(["owned-denied-executable"]),
  () => process.kill(0, 0),
])
  expect(probe).toThrow("Owned plugin origin fixture denied ");
const guardProbes = attempts.length;
attempts.length = 0;
const { loadPluginCatalog } = await import("../../../core/src/plugins/pluginCatalog.js");
const { pluginCacheDir } = await import("../../../core/src/plugins/pluginInstaller.js");
const { pluginInstallDir, pluginsRoot } =
  await import("../../../core/src/plugins/installer/paths.js");
const { marketplaceDir } = await import("../../../core/src/plugins/marketplaceManager.js");
const { listPlugins, updatePluginEntry } = await import("./plugins-service.js");
const { resolveUninstallTarget } = await import("../renderer/extensions/uninstallTarget.js");

// Execute the actual PluginsTab uninstall closure with inert bridge/confirmation
// dependencies. No duplicated route switch and no real destructive IPC is used.
const tabSource = ts.createSourceFile(
  "PluginsTab.tsx",
  readFileSync(new URL("../renderer/extensions/PluginsTab.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let uninstallSource: string | undefined;
function visit(node: ts.Node): void {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(tabSource) === "uninstall" &&
    node.initializer
  )
    uninstallSource = node.initializer.getText(tabSource);
  ts.forEachChild(node, visit);
}
visit(tabSource);
if (!uninstallSource) throw new Error("Actual PluginsTab uninstall closure missing");
const makeUninstall = new Function(
  "resolveUninstallTarget",
  "window",
  "confirm",
  "alert",
  "t",
  "setBusy",
  "setReloadKey",
  "onChanged",
  ts.transpileModule(`return (${uninstallSource});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText,
);

const roots = new Set<string>();
afterEach(() => {
  expect(attempts).toEqual([]);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.clear();
});
afterAll(() => {
  console.log(
    "OWNED_PLUGIN_ORIGIN_GUARD " + JSON.stringify({ guardProbes, actualAttempts: attempts }),
  );
  for (const undo of restore.reverse()) undo();
  syncBuiltinESMExports();
});
function fixture() {
  expect(process.env.NODE_ENV).toBe("test");
  expect(process.env.CODE_SHELL_TEST_HOME).toBe(join(process.env.HOME!, ".code-shell"));
  expect(guardProbes).toBe(8);
  const root = pluginsRoot();
  expect(root).toBe(join(process.env.HOME!, ".code-shell", "plugins"));
  mkdirSync(root, { recursive: true });
  roots.add(root);
  const installed: InstalledPluginsV2 = { version: 2, plugins: {} };
  function add(
    name: string,
    marketplace: string | null,
    dir: string,
    key = `${name}@${marketplace ?? "local"}`,
  ) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, ".cs-plugin-manifest.json"),
      JSON.stringify({ schemaVersion: 1, name, version: "1.0.0" }),
    );
    const row = {
      scope: "user" as const,
      installPath: dir,
      version: "1.0.0",
      installedAt: "2026-10-17T00:00:00Z",
      lastUpdated: "2026-10-17T00:00:00Z",
    };
    (installed.plugins[key] ??= []).push(row);
    writeFileSync(join(root, "installed_plugins.json"), JSON.stringify(installed));
    return row;
  }
  function summaries() {
    writeFileSync(join(root, "installed_plugins.json"), JSON.stringify(installed));
    const catalog = loadPluginCatalog();
    // Same production summary builder with the real source catalog, never an
    // injected preconstructed summary/origin. The registry is real too.
    return { catalog, summaries: listPlugins("", () => catalog) };
  }
  return { root, installed, add, summaries };
}
async function uninstall(plugin: unknown, approved = true) {
  const calls: unknown[] = [];
  const handler = makeUninstall(
    resolveUninstallTarget,
    {
      codeshell: {
        uninstallPlugin: async (...args: unknown[]) => calls.push(["marketplace", ...args]),
        uninstallLocalPlugin: async (...args: unknown[]) => calls.push(["direct", ...args]),
      },
    },
    async () => approved,
    async () => calls.push(["refused"]),
    (key: string) => key,
    () => {},
    () => {},
    () => {},
  );
  await handler(plugin);
  return calls;
}
function updateServices(catalog: ReturnType<typeof loadPluginCatalog>) {
  const calls: string[] = [];
  return {
    calls,
    value: {
      listCatalog: () => catalog,
      updateLocal: async (name: string) => {
        calls.push(`direct:${name}`);
        return { updated: true, reason: "owned direct" };
      },
      refreshMarket: async (name: string) => {
        calls.push(`refresh:${name}`);
        return { ok: true };
      },
      installFromMarket: async (name: string, marketplace: string) => {
        calls.push(`marketplace:${name}@${marketplace}`);
        return { ok: true };
      },
      invalidateSkills: () => calls.push("invalidate"),
      now: () => "2026-10-17T00:00:00Z",
    },
  };
}
for (const market of ["local", "ordinary"]) {
  test(`actual catalog and PluginsTab uninstall route marketplace ${market} through marketplace IPC`, async () => {
    const f = fixture();
    // Both are real production path producers; 'local' is not reserved.
    expect(marketplaceDir(market)).toBe(join(f.root, "marketplaces", market));
    f.add("sample", market, pluginCacheDir(market, "sample", "1.0.0"));
    const { catalog, summaries } = f.summaries();
    expect(await uninstall(summaries[0])).toEqual([["marketplace", "sample", market]]);
    expect(
      readFileSync(join(catalog[0]!.installPath, ".cs-plugin-manifest.json"), "utf8"),
    ).toContain("sample");
  });
  test(`actual catalog updates marketplace ${market} through refresh/install services`, async () => {
    const f = fixture();
    f.add("sample", market, pluginCacheDir(market, "sample", "1.0.0"));
    const fake = updateServices(f.summaries().catalog);
    await updatePluginEntry(`sample@${market}`, fake.value);
    expect(fake.calls).toEqual([`refresh:${market}`, `marketplace:sample@${market}`, "invalidate"]);
  });
}
for (const key of ["sample@local", "sample"]) {
  test(`actual direct layout keeps uninstall/update source for legacy key ${key}`, async () => {
    const f = fixture();
    f.add("sample", null, pluginInstallDir("sample"), key);
    const { catalog, summaries } = f.summaries();
    expect(await uninstall(summaries[0])).toEqual([["direct", "sample"]]);
    const fake = updateServices(catalog);
    await updatePluginEntry(key, fake.value);
    expect(fake.calls).toEqual(["direct:sample"]);
    expect(await uninstall(summaries[0], false)).toEqual([]);
  });
}
test("same-key direct plus marketplace local rows fail closed in either registry order", async () => {
  const f = fixture();
  f.add("sample", null, pluginInstallDir("sample"));
  f.add("sample", "local", pluginCacheDir("local", "sample", "1.0.0"));
  for (let order = 0; order < 2; order++) {
    const { catalog, summaries } = f.summaries();
    expect(await uninstall(summaries[0])).toEqual([["refused"]]);
    expect(catalog[0]!.installationKind).toBe("unknown");
    const fake = updateServices(catalog);
    await expect(updatePluginEntry("sample@local", fake.value)).rejects.toThrow("source");
    expect(fake.calls).toEqual([]);
    f.installed.plugins["sample@local"]!.reverse();
  }
});
test("unknown layout and mismatched cache/key/version cannot acquire a destructive origin", async () => {
  const f = fixture();
  for (const [key, dir] of [
    ["one@local", join(f.root, "unrecognized", "one")],
    ["two@local", pluginCacheDir("other", "two", "1.0.0")],
    ["three@local", pluginCacheDir("local", "three", "different-version")],
    ["four@shop", pluginInstallDir("four")],
  ])
    f.add(key!.split("@")[0]!, "local", dir!, key);
  const { catalog, summaries } = f.summaries();
  expect(catalog).toHaveLength(4);
  for (const summary of summaries) {
    expect(await uninstall(summary)).toEqual([["refused"]]);
    const fake = updateServices(catalog);
    await expect(updatePluginEntry(summary.installKey, fake.value)).rejects.toThrow("source");
    expect(fake.calls).toEqual([]);
  }
});
test("outside-root rows remain excluded and cannot confer origin to an inventory item", () => {
  const f = fixture();
  const outside = join(process.env.HOME!, "owned-outside-plugins");
  roots.add(outside);
  f.add("outside", "local", outside);
  expect(f.summaries()).toEqual({ catalog: [], summaries: [] });
  expect(realpathSync(f.root)).not.toBe(realpathSync(outside));
});

test("missing or unknown DTO origin refuses the actual UI closure and updater without effects", async () => {
  const f = fixture();
  f.add("sample", "local", pluginCacheDir("local", "sample", "1.0.0"));
  for (const kind of [undefined, "unknown", "future-source"]) {
    const { catalog, summaries } = f.summaries();
    for (const row of [catalog[0]!, summaries[0]!]) {
      if (kind === undefined) Reflect.deleteProperty(row, "installationKind");
      else Object.defineProperty(row, "installationKind", { value: kind });
    }
    expect(await uninstall(summaries[0])).toEqual([["refused"]]);
    const fake = updateServices(catalog);
    await expect(updatePluginEntry("sample@local", fake.value)).rejects.toThrow("source");
    expect(fake.calls).toEqual([]);
  }
});

test("multiple versions from the same validated marketplace preserve one source route", async () => {
  const f = fixture();
  f.add("sample", "local", pluginCacheDir("local", "sample", "1.0.0"));
  const second = f.add("sample", "local", pluginCacheDir("local", "sample", "2.0.0"));
  second.version = "2.0.0";
  const { catalog, summaries } = f.summaries();
  expect(catalog).toHaveLength(1);
  expect(catalog[0]!.version).toBe("1.0.0");
  expect(await uninstall(summaries[0])).toEqual([["marketplace", "sample", "local"]]);
  expect(await uninstall(summaries[0], false)).toEqual([]);
  const fake = updateServices(catalog);
  await updatePluginEntry("sample@local", fake.value);
  expect(fake.calls).toEqual(["refresh:local", "marketplace:sample@local", "invalidate"]);
});

test("a manifest cannot rename a legacy bare install key into a destructive direct target", async () => {
  const f = fixture();
  f.add("manifest-name", null, pluginInstallDir("manifest-name"), "different-key");
  const { catalog, summaries } = f.summaries();
  expect(catalog[0]!.installationKind).toBe("unknown");
  expect(await uninstall(summaries[0])).toEqual([["refused"]]);
  const fake = updateServices(catalog);
  await expect(updatePluginEntry("different-key", fake.value)).rejects.toThrow("source");
  expect(fake.calls).toEqual([]);
});
