import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSafePluginPath } from "./pluginInstaller.js";

/**
 * Path-containment guard for plugin deletion. A tampered installed_plugins.json
 * entry must never let a delete escape the cache root (symlink, ../ traversal,
 * or pointing at the root itself). The guard realpaths both sides and requires
 * strict containment (root + separator), rejecting equal-to-root.
 */
describe("resolveSafePluginPath", () => {
  let root: string;
  let cacheRoot: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-rsp-"));
    cacheRoot = join(root, "cache");
    outside = join(root, "outside");
    mkdirSync(cacheRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("accepts a real plugin dir inside the cache root (returns realpath)", () => {
    const p = join(cacheRoot, "my-plugin");
    mkdirSync(p);
    expect(resolveSafePluginPath(p, cacheRoot)).toBe(realpathSync(p));
  });

  test("rejects a target that resolves OUTSIDE the cache root", () => {
    const evil = join(outside, "victim");
    mkdirSync(evil);
    expect(resolveSafePluginPath(evil, cacheRoot)).toBeNull();
  });

  test("rejects a symlink inside the cache that points outside (realpath escape)", () => {
    const evil = join(outside, "victim");
    mkdirSync(evil);
    const link = join(cacheRoot, "sneaky");
    symlinkSync(evil, link);
    // String prefix would pass; realpath must catch the escape.
    expect(resolveSafePluginPath(link, cacheRoot)).toBeNull();
  });

  test("rejects the cache root itself (equal-to-root can't wipe the whole cache)", () => {
    expect(resolveSafePluginPath(cacheRoot, cacheRoot)).toBeNull();
  });

  test("rejects ../ traversal that climbs out of the cache root", () => {
    const climb = join(cacheRoot, "..", "outside");
    expect(resolveSafePluginPath(climb, cacheRoot)).toBeNull();
  });

  test("returns null for empty / non-string input", () => {
    expect(resolveSafePluginPath("", cacheRoot)).toBeNull();
    expect(resolveSafePluginPath(undefined as unknown as string, cacheRoot)).toBeNull();
  });

  test("returns null when the cache root cannot be resolved (refuse, don't fall back)", () => {
    expect(resolveSafePluginPath(join(cacheRoot, "x"), join(root, "no-such-cache"))).toBeNull();
  });

  test("returns null for a missing target (dangling entry → caller skips silently)", () => {
    expect(resolveSafePluginPath(join(cacheRoot, "ghost"), cacheRoot)).toBeNull();
  });

  test("accepts a nested dir several levels under the cache root", () => {
    const nested = join(cacheRoot, "mp", "owner", "plugin");
    mkdirSync(nested, { recursive: true });
    expect(resolveSafePluginPath(nested, cacheRoot)).toBe(realpathSync(nested));
  });
});
