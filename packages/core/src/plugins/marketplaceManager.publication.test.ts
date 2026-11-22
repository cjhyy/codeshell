import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMarketplace,
  loadMarketplace,
  marketplaceDir,
  removeMarketplace,
} from "./marketplaceManager.js";

test("a revoked or invalid marketplace replacement preserves the live catalog and registry", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-market-publish-"));
  const prior = process.env.HOME;
  process.env.HOME = root;
  const repo = join(root, "source");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  try {
    mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
    const manifest = join(repo, ".claude-plugin", "marketplace.json");
    git("init", "-q");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@localhost");
    writeFileSync(
      manifest,
      JSON.stringify({ name: "fixture", owner: { name: "Fixture" }, plugins: [] }),
    );
    git("add", ".");
    git("commit", "-qm", "fixture");
    const source = { source: "git" as const, url: repo };
    const revoked = () => {
      throw Error("revoked");
    };
    expect((await addMarketplace("fixture", source)).ok).toBe(true);
    const file = join(marketplaceDir("fixture"), ".claude-plugin", "marketplace.json");
    const before = readFileSync(file, "utf8"),
      list = readFileSync(join(root, ".code-shell", "plugins", "known_marketplaces.json"), "utf8");
    await expect(addMarketplace("fixture", source, revoked)).rejects.toThrow("revoked");
    expect(() => removeMarketplace("fixture", revoked)).toThrow("revoked");
    writeFileSync(manifest, "{");
    git("commit", "-qam", "invalid");
    expect((await addMarketplace("fixture", source)).ok).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(
      readFileSync(join(root, ".code-shell", "plugins", "known_marketplaces.json"), "utf8"),
    ).toBe(list);
    expect(loadMarketplace("fixture")?.name).toBe("fixture");
  } finally {
    if (prior === undefined) delete process.env.HOME;
    else process.env.HOME = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
