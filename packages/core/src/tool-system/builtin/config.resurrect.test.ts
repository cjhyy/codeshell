import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configTool } from "./config.js";

// Regression: a `config write` whose cwd points at a DELETED project dir used
// to recreate that dir as an empty shell (mkdirSync recursive of
// <cwd>/.code-shell builds the missing `cwd` too). A stale session pointing at
// a removed dir then "resurrected" the project. The write must refuse instead.
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete (Object.prototype as Record<string, unknown>).polluted;
  delete (Object.prototype as Record<string, unknown>).x;
  delete (Object.prototype as Record<string, unknown>).inheritedSettings;
});

describe("config tool — deleted project resurrection guard", () => {
  test("does not recreate a deleted cwd when writing project settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-"));
    dirs.push(dir);
    const gone = join(dir, "deleted-project");
    // cwd never existed (simulates a deleted project root).
    expect(existsSync(gone)).toBe(false);

    const result = await configTool({
      action: "write",
      key: "model.temperature",
      value: 0.5,
      __cwd: gone,
    });

    expect(result).toMatch(/does not exist/i);
    expect(existsSync(gone)).toBe(false); // NOT resurrected
  });

  test("still writes when the project root exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-"));
    dirs.push(dir);

    const result = await configTool({
      action: "write",
      key: "model.temperature",
      value: 0.5,
      __cwd: dir,
    });

    expect(result).toMatch(/Updated/);
    expect(existsSync(join(dir, ".code-shell", "settings.json"))).toBe(true);
  });
});

describe("config tool — rejects unsafe dotted setting keys", () => {
  test("rejects __proto__ writes without mutating Object.prototype", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-"));
    dirs.push(dir);

    const result = await configTool({
      action: "write",
      key: "__proto__.polluted",
      value: "yes",
      __cwd: dir,
    });

    expect(result).toMatch(/invalid setting key/i);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(existsSync(join(dir, ".code-shell", "settings.json"))).toBe(false);
  });

  test("rejects constructor.prototype writes without mutating Object.prototype", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-"));
    dirs.push(dir);

    const result = await configTool({
      action: "write",
      key: "constructor.prototype.x",
      value: "yes",
      __cwd: dir,
    });

    expect(result).toMatch(/invalid setting key/i);
    expect((Object.prototype as Record<string, unknown>).x).toBeUndefined();
    expect(existsSync(join(dir, ".code-shell", "settings.json"))).toBe(false);
  });

  test("rejects dotted keys with empty segments", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-"));
    dirs.push(dir);

    const result = await configTool({
      action: "write",
      key: "model..temperature",
      value: 0.5,
      __cwd: dir,
    });

    expect(result).toMatch(/invalid setting key/i);
    expect(existsSync(join(dir, ".code-shell", "settings.json"))).toBe(false);
  });

  test("rejects inherited-object descent without mutating Object.prototype", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-config-"));
    dirs.push(dir);
    (Object.prototype as Record<string, unknown>).inheritedSettings = { existing: true };

    const result = await configTool({
      action: "write",
      key: "inheritedSettings.y",
      value: "yes",
      __cwd: dir,
    });

    expect(result).toMatch(/invalid setting key/i);
    expect(
      ((Object.prototype as Record<string, unknown>).inheritedSettings as Record<string, unknown>)
        .y,
    ).toBeUndefined();
    expect(existsSync(join(dir, ".code-shell", "settings.json"))).toBe(false);
  });
});
