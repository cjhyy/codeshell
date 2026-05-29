import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updatePluginByName } from "./update.js";
import { installPluginFromPath } from "./install.js";

describe("updatePluginByName", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-up-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-up-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "u", version: "1.0.0" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "a.toml"), 'name = "a"\ndescription = "d"');
    installPluginFromPath(src, "u", "t1");
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("no-op when version unchanged", () => {
    const r = updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(false);
  });

  test("reinstalls when source version bumped", () => {
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "u", version: "2.0.0" }));
    const r = updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(true);
    const meta = JSON.parse(readFileSync(join(home, ".code-shell", "plugins", "u", ".cs-meta.json"), "utf-8"));
    expect(meta.version).toBe("2.0.0");
  });

  test("force reinstalls even when unchanged", () => {
    const r = updatePluginByName("u", "t2", true);
    expect(r.updated).toBe(true);
  });
});
