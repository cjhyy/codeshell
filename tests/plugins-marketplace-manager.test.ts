import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  addMarketplace,
  removeMarketplace,
  loadMarketplace,
  listMarketplaces,
  marketplaceDir,
  marketplacesRoot,
} from "../packages/core/src/plugins/marketplaceManager.js";
import {
  readKnownMarketplaces,
} from "../packages/core/src/plugins/knownMarketplaces.js";

function makeFakeMarketplaceRepo(repoRoot: string, manifest: object) {
  spawnSync("git", ["init", "-q", repoRoot]);
  spawnSync("git", ["-C", repoRoot, "config", "user.email", "t@t"]);
  spawnSync("git", ["-C", repoRoot, "config", "user.name", "T"]);
  mkdirSync(join(repoRoot, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".claude-plugin", "marketplace.json"),
    JSON.stringify(manifest, null, 2),
  );
  spawnSync("git", ["-C", repoRoot, "add", "."]);
  spawnSync("git", ["-C", repoRoot, "commit", "-q", "-m", "init"]);
  const bare = repoRoot + ".git";
  spawnSync("git", ["clone", "--bare", "-q", repoRoot, bare]);
  rmSync(repoRoot, { recursive: true, force: true });
  return bare;
}

describe("marketplaceManager", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let scratch: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "mp-home-"));
    scratch = mkdtempSync(join(tmpdir(), "mp-fixture-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("addMarketplace clones, validates, and persists", async () => {
    const bare = makeFakeMarketplaceRepo(join(scratch, "src"), {
      name: "fixtures",
      owner: { name: "T" },
      plugins: [{ name: "alpha", source: "./plugins/alpha" }],
    });
    const r = await addMarketplace("fixtures", { source: "git", url: bare });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.marketplace.plugins).toHaveLength(1);
      expect(r.replaced).toBe(false);
    }
    expect(existsSync(marketplaceDir("fixtures"))).toBe(true);
    expect(readKnownMarketplaces().fixtures?.source).toEqual({ source: "git", url: bare });
  });

  it("addMarketplace rejects bad marketplace.json", async () => {
    const bare = makeFakeMarketplaceRepo(join(scratch, "src"), {
      name: "fixtures",
      owner: { name: "T" },
      // plugins must be an array — a string is a hard validation failure.
      // (Note: a missing owner is NO LONGER rejected — Codex compat falls back
      // to the marketplace name; see plugins-schemas.test.ts.)
      plugins: "not-an-array",
    });
    const r = await addMarketplace("fixtures", { source: "git", url: bare });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("plugins");
    // Cleanup: dir should have been removed.
    expect(existsSync(marketplaceDir("fixtures"))).toBe(false);
  });

  it("addMarketplace rejects missing manifest", async () => {
    // Make a repo with no .claude-plugin/marketplace.json.
    const work = join(scratch, "src2");
    spawnSync("git", ["init", "-q", work]);
    spawnSync("git", ["-C", work, "config", "user.email", "t@t"]);
    spawnSync("git", ["-C", work, "config", "user.name", "T"]);
    writeFileSync(join(work, "README.md"), "no manifest");
    spawnSync("git", ["-C", work, "add", "."]);
    spawnSync("git", ["-C", work, "commit", "-q", "-m", "init"]);
    const bare = join(scratch, "src2.git");
    spawnSync("git", ["clone", "--bare", "-q", work, bare]);

    const r = await addMarketplace("nomanifest", { source: "git", url: bare });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("marketplace.json");
  });

  it("addMarketplace surfaces git clone failure", async () => {
    const r = await addMarketplace("nope", {
      source: "git",
      url: "/definitely/not/a/repo.git",
    });
    expect(r.ok).toBe(false);
  });

  it("addMarketplace with same source replaces lastUpdated", async () => {
    const bare = makeFakeMarketplaceRepo(join(scratch, "src"), {
      name: "fixtures",
      owner: { name: "T" },
      plugins: [{ name: "alpha", source: "./plugins/alpha" }],
    });
    const first = await addMarketplace("m1", { source: "git", url: bare });
    expect(first.ok).toBe(true);
    const tsFirst = readKnownMarketplaces().m1!.lastUpdated;
    // Small delay to ensure ISO timestamp differs.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await addMarketplace("m1", { source: "git", url: bare });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.replaced).toBe(true);
    expect(readKnownMarketplaces().m1!.lastUpdated).not.toBe(tsFirst);
  });

  it("loadMarketplace returns null for unknown name", () => {
    expect(loadMarketplace("none")).toBeNull();
  });

  it("listMarketplaces returns counts after add", async () => {
    const bare = makeFakeMarketplaceRepo(join(scratch, "src"), {
      name: "fixtures",
      owner: { name: "T" },
      plugins: [
        { name: "a", source: "./a" },
        { name: "b", source: "./b" },
      ],
    });
    await addMarketplace("fx", { source: "git", url: bare });
    const list = listMarketplaces();
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("fx");
    expect(list[0]!.pluginCount).toBe(2);
  });

  it("removeMarketplace deletes manifest entry and disk dir", async () => {
    const bare = makeFakeMarketplaceRepo(join(scratch, "src"), {
      name: "fixtures",
      owner: { name: "T" },
      plugins: [{ name: "a", source: "./a" }],
    });
    await addMarketplace("rm-me", { source: "git", url: bare });
    expect(removeMarketplace("rm-me")).toBe(true);
    expect(existsSync(marketplaceDir("rm-me"))).toBe(false);
    expect(readKnownMarketplaces()["rm-me"]).toBeUndefined();
  });

  it("removeMarketplace returns false when not present", () => {
    expect(removeMarketplace("never-added")).toBe(false);
  });
});
