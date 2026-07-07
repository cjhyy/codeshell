import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveContainedPluginSubpath } from "./sourcePath.js";

describe("resolveContainedPluginSubpath", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "cs-plugin-root-"));
    outside = mkdtempSync(join(tmpdir(), "cs-plugin-out-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test("accepts an existing child path", () => {
    mkdirSync(join(root, "plugins", "ok"), { recursive: true });
    const resolved = resolveContainedPluginSubpath(root, "plugins/ok", "plugin source path");
    expect(resolved).toEqual({ ok: true, path: realpathSync(join(root, "plugins", "ok")) });
  });

  test("rejects parent-directory traversal", () => {
    const resolved = resolveContainedPluginSubpath(root, "../outside", "plugin source path");
    if (resolved.ok) throw new Error("expected traversal to be rejected");
    expect(resolved.error).toMatch(/parent-directory/);
  });

  test("rejects a symlink that realpaths outside the source tree", () => {
    const link = join(root, "link-out");
    symlinkSync(outside, link);
    const resolved = resolveContainedPluginSubpath(root, "link-out", "plugin source path");
    if (resolved.ok) throw new Error("expected symlink escape to be rejected");
    expect(resolved.error).toMatch(/escapes/);
  });
});
