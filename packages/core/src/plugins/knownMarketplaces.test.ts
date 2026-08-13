import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  knownMarketplacesPath,
  readKnownMarketplaces,
  upsertKnownMarketplace,
} from "./knownMarketplaces.js";

const MODULE = join(import.meta.dir, "knownMarketplaces.ts");
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeshell-known-markets-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("known marketplaces registry", () => {
  test("does not follow a linked registry", () => {
    const path = knownMarketplacesPath();
    const outside = join(home, "outside.json");
    writeFileSync(outside, JSON.stringify({ keep: true }));
    mkdirSync(join(path, ".."), { recursive: true });
    symlinkSync(outside, path);
    expect(Object.keys(readKnownMarketplaces())).toEqual([]);
    expect(() =>
      upsertKnownMarketplace("safe", {
        source: { source: "github", repo: "owner/repo" },
        installLocation: "/tmp/safe",
        lastUpdated: "now",
      }),
    ).toThrow(/bounded regular file/);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ keep: true });
  });

  test("concurrent processes preserve every marketplace", async () => {
    const total = 16;
    const children = Array.from({ length: total }, (_, index) => {
      const script = `
        import { upsertKnownMarketplace } from ${JSON.stringify(MODULE)};
        upsertKnownMarketplace(${JSON.stringify(`market-${index}`)}, {
          source: { source: "github", repo: ${JSON.stringify(`owner/repo-${index}`)} },
          installLocation: ${JSON.stringify(`/tmp/market-${index}`)},
          lastUpdated: "now"
        });
      `;
      return Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
    });
    expect(
      (await Promise.all(children.map((child) => child.exited))).every((code) => code === 0),
    ).toBe(true);
    expect(Object.keys(readKnownMarketplaces())).toHaveLength(total);
  }, 60_000);

  test("one legacy name does not erase the registry or brick every later write", () => {
    // Names like "My Market" were reachable: AddMarketplace accepted any
    // non-empty string and assertSafePluginName permits spaces. Throwing on
    // them made readKnownMarketplaces() return {} — hiding the valid entries —
    // while mutateKnownMarketplaces() threw on every write, with no way out
    // because the read showed the user nothing to fix.
    const entry = (repo: string) => ({
      source: { source: "github", repo },
      installLocation: join(home, ".code-shell", "plugins", "marketplaces", "x"),
      lastUpdated: new Date(0).toISOString(),
    });
    mkdirSync(join(home, ".code-shell", "plugins"), { recursive: true });
    writeFileSync(
      knownMarketplacesPath(),
      JSON.stringify({
        official: entry("acme/official"),
        "My Market": entry("acme/legacy"),
      }),
    );

    // The conforming entry survives; only the unusable key is isolated.
    expect(Object.keys(readKnownMarketplaces())).toEqual(["official"]);

    // And the registry still accepts writes.
    upsertKnownMarketplace("brand-new", entry("acme/new") as never);
    expect(Object.keys(readKnownMarketplaces()).sort()).toEqual(["brand-new", "official"]);
  });
});
