import { expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as promises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addMarketplace,
  createMarketplaceLifetime,
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

test("an unreaped private checkout is reported to the Host drain when the seed is cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-market-cleanup-"));
  const previous = process.env.HOME;
  process.env.HOME = root;
  const controller = new AbortController();
  const lifetime = createMarketplaceLifetime(controller.signal, () => controller.signal.aborted);
  const denied = Object.assign(new Error("Checkout is busy"), { code: "EPERM" });
  const cleanup = spyOn(promises, "rm").mockImplementation(async (path, options) => {
    expect(String(path)).toStartWith(
      join(root, ".code-shell", "plugins", "marketplaces", ".publish-"),
    );
    expect(options?.maxRetries).toBeGreaterThan(0);
    throw denied;
  });
  try {
    controller.abort();
    await expect(
      lifetime.run(() => addMarketplace("fixture", { source: "git", url: root })),
    ).rejects.toThrow("Checkout is busy");
    expect(lifetime.cleanupError).toContain("Checkout is busy");
  } finally {
    cleanup.mockRestore();
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
