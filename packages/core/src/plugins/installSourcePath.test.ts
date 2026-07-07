import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPlugin } from "./pluginInstaller.js";
import { writeKnownMarketplaces } from "./knownMarketplaces.js";

describe("installPlugin marketplace source path containment", () => {
  let home: string;
  let mpDir: string;
  let outside: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-sourcepath-home-"));
    outside = mkdtempSync(join(tmpdir(), "cs-sourcepath-out-"));
    process.env.HOME = home;

    mpDir = join(home, ".code-shell", "plugins", "marketplaces", "shop");
    mkdirSync(join(mpDir, ".claude-plugin"), { recursive: true });
    mkdirSync(join(mpDir, "payload"), { recursive: true });
    mkdirSync(join(outside, "payload"), { recursive: true });
    writeFileSync(join(mpDir, "payload", "plugin.json"), JSON.stringify({ name: "ok" }));
    writeFileSync(join(outside, "payload", "plugin.json"), JSON.stringify({ name: "evil" }));

    writeKnownMarketplaces({
      shop: { source: { source: "git", url: "x" }, installLocation: mpDir, lastUpdated: "t" },
    });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  function writeMarketplace(source: unknown): void {
    writeFileSync(
      join(mpDir, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: "shop",
        owner: { name: "shop" },
        plugins: [{ name: "p", source }],
      }),
    );
  }

  test("rejects a string source path with parent-directory traversal", async () => {
    writeMarketplace("../payload");

    const res = await installPlugin("p", "shop");

    if (res.ok) throw new Error("expected traversal source path to be rejected");
    expect(res.error).toMatch(/parent-directory|inside the source tree/);
  });

  test("rejects an absolute string source path", async () => {
    writeMarketplace(join(outside, "payload"));

    const res = await installPlugin("p", "shop");

    if (res.ok) throw new Error("expected absolute source path to be rejected");
    expect(res.error).toMatch(/relative/);
  });

  test("rejects a git-subdir path with parent-directory traversal before cloning", async () => {
    writeMarketplace({ source: "git-subdir", url: "file:///does-not-need-to-exist", path: "../payload" });

    const res = await installPlugin("p", "shop");

    if (res.ok) throw new Error("expected git-subdir traversal path to be rejected");
    expect(res.error).toMatch(/parent-directory/);
  });
});
