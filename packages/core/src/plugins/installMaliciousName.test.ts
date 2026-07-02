import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { installPlugin } from "./pluginInstaller.js";
import { writeKnownMarketplaces } from "./knownMarketplaces.js";

/**
 * Supply-chain guard, end-to-end: a marketplace manifest whose plugin `name`
 * is a path-traversal segment (`..`) must NOT let the materialized cache tree
 * escape the plugin cache root, and must surface as a clean `{ ok: false }`
 * result — not an uncaught throw that crashes the caller (bootstrap /
 * marketplace-service / tui handler all consume `{ ok, error }`).
 */
describe("installPlugin rejects a path-traversal plugin name", () => {
  let home: string, mpDir: string, prev: string | undefined;

  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-evilname-home-"));
    process.env.HOME = home;

    // A cloned marketplace whose manifest declares a plugin literally named "..".
    mpDir = join(home, ".code-shell", "plugins", "marketplaces", "shop");
    mkdirSync(join(mpDir, ".claude-plugin"), { recursive: true });
    // The plugin's own (benign) source tree.
    mkdirSync(join(mpDir, "payload"), { recursive: true });
    writeFileSync(join(mpDir, "payload", "plugin.json"), JSON.stringify({ name: ".." }));
    writeFileSync(
      join(mpDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "shop",
        plugins: [{ name: "..", source: "./payload" }],
      }),
    );

    writeKnownMarketplaces({
      shop: { source: { source: "git", url: "x" }, installLocation: mpDir, lastUpdated: "t" },
    });
  });

  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
  });

  test("returns { ok: false } and writes nothing outside the cache root", async () => {
    const cacheRoot = join(home, ".code-shell", "plugins", "cache");
    // The dir that a naive join(cacheRoot, "shop", "..", version) would climb to.
    const escapedParent = resolve(cacheRoot, "shop", "..");

    const res = await installPlugin("..", "shop");

    expect(res.ok).toBe(false);
    // No cache tree was materialized at the escaped location (the plugins root).
    expect(existsSync(join(escapedParent, "local"))).toBe(false);
  });
});
