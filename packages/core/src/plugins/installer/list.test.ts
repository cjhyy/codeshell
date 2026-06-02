import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listInstalledPlugins } from "./list.js";
import { installPluginFromPath } from "./install.js";

describe("listInstalledPlugins", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-ls-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-ls-src-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("lists local installs with name/format/version", async () => {
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "cx", version: "9.9" }));
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "a.toml"), 'name = "a"\ndescription = "d"');
    await installPluginFromPath(src, "cx", "t");
    const rows = listInstalledPlugins();
    const row = rows.find((r) => r.name === "cx");
    expect(row).toMatchObject({ name: "cx", format: "codex", version: "9.9" });
  });

  test("empty when nothing installed", () => {
    expect(listInstalledPlugins()).toEqual([]);
  });
});
