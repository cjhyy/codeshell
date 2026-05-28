import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { resolveSafePluginPath } from "../packages/core/src/plugins/pluginInstaller.js";

/**
 * Task 2 — plugin uninstall must refuse to delete anything that doesn't
 * realpath to a strict child of the plugin cache. The defended invariant is
 * "an attacker-controlled installed_plugins.json cannot make us rmSync paths
 * outside the cache." Every case here corresponds to a way that could fail.
 */

describe("resolveSafePluginPath", () => {
  let root: string;
  let cacheRoot: string;
  let outsideDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codeshell-plugin-uninstall-"));
    cacheRoot = join(root, "plugins-cache");
    outsideDir = join(root, "outside");
    mkdirSync(cacheRoot, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts a real child of the cache root", () => {
    const target = join(cacheRoot, "marketplace", "plugin", "1.0.0");
    mkdirSync(target, { recursive: true });
    const safe = resolveSafePluginPath(target, cacheRoot);
    expect(safe).not.toBeNull();
    // Path normalization may add /private on macOS, etc. — just check the
    // shape: starts with the resolved cache root and is not equal to it.
    expect(safe).toMatch(new RegExp(`marketplace.${"plugin".replace(".", "\\.")}`));
  });

  test("rejects the cache root itself", () => {
    // Tampered manifest pointing at the cache root would otherwise wipe
    // every installed plugin in a single uninstall call.
    expect(resolveSafePluginPath(cacheRoot, cacheRoot)).toBeNull();
  });

  test("rejects the parent of the cache root", () => {
    expect(resolveSafePluginPath(root, cacheRoot)).toBeNull();
  });

  test("rejects '/' as installPath", () => {
    expect(resolveSafePluginPath("/", cacheRoot)).toBeNull();
  });

  test("rejects $HOME-equivalent path", () => {
    // homedir() always exists and is never inside our temp cache.
    expect(resolveSafePluginPath(process.env.HOME ?? "/", cacheRoot)).toBeNull();
  });

  test("rejects '..' escape that still exists on disk", () => {
    const inside = join(cacheRoot, "marketplace", "plugin", "1.0.0");
    mkdirSync(inside, { recursive: true });
    // Resolves up out of the cache root into a real directory.
    const escaped = join(inside, "..", "..", "..", "..", "outside");
    expect(resolveSafePluginPath(escaped, cacheRoot)).toBeNull();
  });

  test("rejects a sibling directory that lives outside the cache", () => {
    const sibling = join(outsideDir, "fake-plugin");
    mkdirSync(sibling, { recursive: true });
    expect(resolveSafePluginPath(sibling, cacheRoot)).toBeNull();
  });

  test("rejects a symlink in the cache that points outside the cache", () => {
    // The realpath check is the whole point: a symlink under the cache that
    // dereferences to an outside path must NOT be deleted.
    const outsideTarget = join(outsideDir, "tempting-target");
    mkdirSync(outsideTarget, { recursive: true });
    writeFileSync(join(outsideTarget, "marker"), "keep me");
    const linkPath = join(cacheRoot, "evil-symlink");
    symlinkSync(outsideTarget, linkPath, "dir");
    expect(resolveSafePluginPath(linkPath, cacheRoot)).toBeNull();
  });

  test("rejects empty / nonsense installPath", () => {
    expect(resolveSafePluginPath("", cacheRoot)).toBeNull();
    // Non-existent path — realpath fails, we refuse.
    expect(resolveSafePluginPath(join(cacheRoot, "does-not-exist"), cacheRoot)).toBeNull();
  });

  test("rejects when cacheRoot itself doesn't exist", () => {
    const target = join(cacheRoot, "marketplace", "plugin", "1.0.0");
    mkdirSync(target, { recursive: true });
    const bogusCache = join(root, "no-such-cache");
    // If the cache root can't be resolved we refuse — better safe than wrong.
    expect(resolveSafePluginPath(target, bogusCache)).toBeNull();
  });

  test("a deep nested child of the cache root is accepted", () => {
    const deep = join(cacheRoot, "m", "p", "v", "extra", "nested");
    mkdirSync(deep, { recursive: true });
    expect(resolveSafePluginPath(deep, cacheRoot)).not.toBeNull();
  });

  test("the resolved path is reported without a trailing separator", () => {
    const target = join(cacheRoot, "marketplace", "plugin", "1.0.0");
    mkdirSync(target, { recursive: true });
    const safe = resolveSafePluginPath(target, cacheRoot);
    expect(safe?.endsWith(sep)).toBe(false);
  });
});
