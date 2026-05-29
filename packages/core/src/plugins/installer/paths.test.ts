import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { pluginInstallDir, pluginMetaPath, assertSafePluginName } from "./paths.js";

describe("plugin paths", () => {
  test("install dir is a direct child of ~/.code-shell/plugins", () => {
    const prev = process.env.HOME;
    process.env.HOME = "/tmp/fakehome";
    try {
      expect(pluginInstallDir("foo")).toBe("/tmp/fakehome/.code-shell/plugins/foo");
      expect(pluginMetaPath("foo")).toBe(join("/tmp/fakehome/.code-shell/plugins/foo", ".cs-meta.json"));
    } finally {
      process.env.HOME = prev;
    }
  });

  test("assertSafePluginName rejects path traversal and separators", () => {
    expect(() => assertSafePluginName("../evil")).toThrow();
    expect(() => assertSafePluginName("a/b")).toThrow();
    expect(() => assertSafePluginName("")).toThrow();
    expect(() => assertSafePluginName("..")).toThrow();
  });

  test("assertSafePluginName accepts a normal name", () => {
    expect(() => assertSafePluginName("my-plugin")).not.toThrow();
  });
});
