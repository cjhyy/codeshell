import { describe, test, expect } from "bun:test";
import { pluginCacheDir } from "./pluginInstaller.js";

/**
 * Supply-chain path-traversal guard. `pluginCacheDir(marketplace, plugin,
 * version)` composes join(cacheRoot, marketplace, plugin, version) from values
 * that originate in a marketplace manifest / git output. A `..`, separator, or
 * NUL in any segment must be rejected so a malicious manifest cannot cause the
 * plugin cache to be written outside its root.
 */
describe("pluginCacheDir segment validation", () => {
  const prev = process.env.HOME;
  const withFakeHome = (fn: () => void) => {
    process.env.HOME = "/tmp/fakehome-pcd";
    try {
      fn();
    } finally {
      process.env.HOME = prev;
    }
  };

  test("accepts normal segments (returns a child of the cache root)", () => {
    withFakeHome(() => {
      expect(pluginCacheDir("mp", "my-plugin", "abc123def456")).toBe(
        "/tmp/fakehome-pcd/.code-shell/plugins/cache/mp/my-plugin/abc123def456",
      );
    });
  });

  test("rejects `..` traversal in the marketplace segment", () => {
    withFakeHome(() => {
      expect(() => pluginCacheDir("..", "p", "v")).toThrow();
    });
  });

  test("rejects `..` traversal in the plugin segment", () => {
    withFakeHome(() => {
      expect(() => pluginCacheDir("mp", "..", "v")).toThrow();
    });
  });

  test("rejects `..` traversal in the version segment", () => {
    withFakeHome(() => {
      expect(() => pluginCacheDir("mp", "p", "..")).toThrow();
    });
  });

  test("rejects a path separator embedded in a segment", () => {
    withFakeHome(() => {
      expect(() => pluginCacheDir("../../etc", "p", "v")).toThrow();
      expect(() => pluginCacheDir("mp", "a/b", "v")).toThrow();
      expect(() => pluginCacheDir("mp", "p", "a\\b")).toThrow();
    });
  });

  test("rejects an empty segment and a NUL byte", () => {
    withFakeHome(() => {
      expect(() => pluginCacheDir("", "p", "v")).toThrow();
      expect(() => pluginCacheDir("mp", "p\0", "v")).toThrow();
    });
  });
});
