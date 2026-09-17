import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InstalledPanelApp } from "@cjhyy/code-shell-core";
import { PanelAppInspectionCache } from "./panel-app-inspection-cache.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "panel-inspection-cache-")));
  directories.push(directory);
  const root = join(directory, "app"),
    registry = join(directory, "registry.json"),
    manifestPath = join(root, ".codeshell-panel", "panel.json"),
    entry = join(root, "app", "index.html"),
    tool = join(root, "tools", "run.mjs");
  await Promise.all([
    mkdir(join(root, ".codeshell-panel"), { recursive: true }),
    mkdir(join(root, "app"), { recursive: true }),
    mkdir(join(root, "tools"), { recursive: true }),
  ]);
  const toolText = "console.log('safe')",
    hash = createHash("sha256").update(toolText).digest("hex");
  const manifest = {
    id: "demo",
    version: "1.0.0",
    entry: "app/index.html",
    permissions: ["resources", "process"],
    nativeEntries: { runner: { entry: "tools/run.mjs", sha256: hash } },
  };
  await Promise.all([
    writeFile(manifestPath, JSON.stringify(manifest)),
    writeFile(registry, JSON.stringify(["demo"])),
    writeFile(join(root, ".cs-panel-app-meta.json"), "{}"),
    writeFile(entry, "<h1>test</h1>"),
    writeFile(tool, toolText),
  ]);
  let inspections = 0;
  let duringInspection: (() => Promise<void>) | undefined;
  const cache = new PanelAppInspectionCache({
    installPath: () => root,
    registryPath: () => registry,
    listInstalled: async () => {
      inspections++;
      if (!(JSON.parse(await readFile(registry, "utf8")) as string[]).includes("demo")) return [];
      const value = JSON.parse(await readFile(manifestPath, "utf8"));
      if (createHash("sha256").update(await readFile(tool)).digest("hex") !== hash) return [];
      await duringInspection?.();
      return [{ ...value, installPath: root } as InstalledPanelApp];
    },
  });
  return {
    cache,
    root,
    registry,
    manifestPath,
    manifest,
    entry,
    tool,
    inspections: () => inspections,
    duringInspection: (callback: () => Promise<void>) => (duringInspection = callback),
  };
}

test("repeated transfer checks reuse inspection while still checking the installed snapshot", async () => {
  const f = await fixture();
  for (let i = 0; i < 400; i++) expect((await f.cache.get("demo"))?.version).toBe("1.0.0");
  expect(f.inspections()).toBe(1);
});

test("version and permissions changes invalidate the cache immediately", async () => {
  const f = await fixture();
  await f.cache.get("demo");
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, version: "1.0.1" }));
  expect((await f.cache.get("demo"))?.version).toBe("1.0.1");
  await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, permissions: ["resources"] }));
  expect((await f.cache.get("demo"))?.permissions).toEqual(["resources"]);
  expect(f.inspections()).toBe(3);
});

test("same-size native entry tampering invalidates inspection even if mtime is restored", async () => {
  const f = await fixture();
  await f.cache.get("demo");
  const before = await stat(f.tool);
  await writeFile(f.tool, "console.log('evil')");
  await utimes(f.tool, before.atime, before.mtime);
  expect(await f.cache.get("demo")).toBeUndefined();
  expect(f.inspections()).toBe(2);
});

test("uninstall through registry removal cannot reuse an otherwise unchanged package", async () => {
  const f = await fixture();
  await f.cache.get("demo");
  await writeFile(f.registry, "[]");
  expect(await f.cache.get("demo")).toBeUndefined();
  expect(f.inspections()).toBe(2);
});

test("removed packages and newly added symlinks fail closed", async () => {
  const f = await fixture();
  await f.cache.get("demo");
  await symlink(f.entry, join(f.root, "app", "unsafe.html"));
  expect(await f.cache.get("demo")).toBeUndefined();
  await rm(f.root, { recursive: true });
  expect(await f.cache.get("demo")).toBeUndefined();
});

test("metadata and entry replacements trigger a fresh inspection", async () => {
  const f = await fixture();
  await f.cache.get("demo");
  await writeFile(join(f.root, ".cs-panel-app-meta.json"), '{"installedAt":"new"}');
  expect(await f.cache.get("demo")).toBeDefined();
  await writeFile(`${f.entry}.new`, "<h1>test</h1>");
  await rename(`${f.entry}.new`, f.entry);
  expect(await f.cache.get("demo")).toBeDefined();
  expect(f.inspections()).toBe(3);
});

test("a package changed during full inspection is not cached or authorized", async () => {
  const f = await fixture();
  f.duringInspection(() => writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, version: "2" })));
  expect(await f.cache.get("demo")).toBeUndefined();
});

test("concurrent first calls share inspection without skipping subsequent identity checks", async () => {
  const f = await fixture();
  const apps = await Promise.all(Array.from({ length: 20 }, () => f.cache.get("demo")));
  expect(apps.every((app) => app?.id === "demo")).toBe(true);
  expect(f.inspections()).toBe(1);
  await rm(f.entry);
  // The fixture inspection does not validate the HTML entry itself. The directory
  // and file identity change must still force inspection instead of using cache.
  await f.cache.get("demo");
  expect(f.inspections()).toBe(2);
});
