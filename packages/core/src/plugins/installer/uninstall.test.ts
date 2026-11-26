import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { uninstallPluginByName, uninstallPluginByNameAsync } from "./uninstall.js";
import { installPluginFromPath } from "./install.js";
import { withLocalPluginMutation } from "./mutation-lock.js";
import { readInstalledPlugins } from "../installedPlugins.js";
import { nativeModuleId } from "../native/manifest.js";
import {
  nativeRuntimeRoot,
  prepareNativeSnapshot,
  removeNativeSnapshot,
} from "../native/snapshot.js";

describe("uninstallPluginByName", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-un-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-un-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, "skills", "s"), { recursive: true });
    writeFileSync(join(src, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nb");
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("takes a native plugin's runtime copy and log with it", async () => {
    mkdirSync(join(src, ".codeshell-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codeshell-plugin", "plugin.json"),
      JSON.stringify({ schemaVersion: 2, apiVersion: 1, main: "./index.js" }),
    );
    writeFileSync(join(src, "index.js"), "export default () => {};\n");
    const dir = await installPluginFromPath(src, "native", "t");
    const runtimeRoot = nativeRuntimeRoot();
    expect(runtimeRoot.startsWith(home)).toBe(true);
    const moduleId = nativeModuleId("native", "native@local");
    const snapshot = prepareNativeSnapshot({
      moduleId,
      installPath: dir,
      contentDigest: readInstalledPlugins().plugins["native@local"]![0]!.contentDigest!,
    });
    if (!snapshot.ok) throw new Error(snapshot.reason);
    mkdirSync(join(runtimeRoot, ".logs"), { recursive: true });
    writeFileSync(join(runtimeRoot, ".logs", `${moduleId}.log`), "line\n");
    try {
      uninstallPluginByName("native");
      expect(existsSync(join(runtimeRoot, moduleId))).toBe(false);
      expect(existsSync(join(runtimeRoot, ".logs", `${moduleId}.log`))).toBe(false);
    } finally {
      removeNativeSnapshot(runtimeRoot);
    }
  });

  test("removes the dir and the registry entry", async () => {
    const dir = await installPluginFromPath(src, "gone", "t");
    expect(existsSync(dir)).toBe(true);
    uninstallPluginByName("gone");
    expect(existsSync(dir)).toBe(false);
    expect(readInstalledPlugins().plugins["gone@local"]).toBeUndefined();
  });

  test("async uninstall yields and never deletes a replacement installed at the same name", async () => {
    const dir = await installPluginFromPath(src, "gone", "t");
    for (let i = 0; i < 100; i++) writeFileSync(join(dir, `data-${i}`), "fixture");
    let finished = false;
    const removal = uninstallPluginByNameAsync("gone").then(() => {
      finished = true;
    });
    expect(existsSync(dir)).toBe(false);
    expect(readInstalledPlugins().plugins["gone@local"]).toBeUndefined();
    mkdirSync(dir);
    writeFileSync(join(dir, "replacement"), "new install");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    await removal;
    expect(existsSync(join(dir, "replacement"))).toBe(true);
  });

  test("a competing publication cannot turn a queued removal into removing its replacement", async () => {
    const dir = await installPluginFromPath(src, "gone", "t");
    const published = Promise.withResolvers<void>();
    const publishing = withLocalPluginMutation("gone", async () => {
      await published.promise;
      renameSync(dir, join(home, "previous"));
      mkdirSync(dir);
      writeFileSync(join(dir, "replacement"), "new install");
    });
    const removal = uninstallPluginByNameAsync("gone");
    published.resolve();
    await publishing;
    await expect(removal).rejects.toThrow("changed while waiting for removal");
    expect(existsSync(join(dir, "replacement"))).toBe(true);
    expect(readInstalledPlugins().plugins["gone@local"]).toBeDefined();
  });

  test("throws on unknown plugin", () => {
    expect(() => uninstallPluginByName("nope")).toThrow(/no plugin/);
  });

  test("rejects unsafe names", () => {
    expect(() => uninstallPluginByName("../evil")).toThrow();
  });
});
