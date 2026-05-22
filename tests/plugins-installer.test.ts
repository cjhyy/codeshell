import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { addMarketplace } from "../packages/core/src/plugins/marketplaceManager.js";
import {
  installPlugin,
  uninstallPlugin,
  listInstalled,
} from "../packages/core/src/plugins/pluginInstaller.js";
import {
  readInstalledPlugins,
  pluginInstallKey,
} from "../packages/core/src/plugins/installedPlugins.js";

/**
 * Build a bare repo at `dest` whose contents are seeded with the given
 * files (relative path → contents). Returns the bare repo path.
 */
function bareRepoWithFiles(scratch: string, name: string, files: Record<string, string>): string {
  const work = join(scratch, `${name}-work`);
  mkdirSync(work, { recursive: true });
  spawnSync("git", ["init", "-q", work]);
  spawnSync("git", ["-C", work, "config", "user.email", "t@t"]);
  spawnSync("git", ["-C", work, "config", "user.name", "T"]);
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(work, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, contents);
  }
  spawnSync("git", ["-C", work, "add", "."]);
  spawnSync("git", ["-C", work, "commit", "-q", "-m", "init"]);
  const bare = join(scratch, `${name}.git`);
  spawnSync("git", ["clone", "--bare", "-q", work, bare]);
  rmSync(work, { recursive: true, force: true });
  return bare;
}

describe("pluginInstaller", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let scratch: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "installer-home-"));
    scratch = mkdtempSync(join(tmpdir(), "installer-fixture-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  /**
   * Build a marketplace repo whose manifest references inline plugins
   * (path) — the simplest source type.
   */
  async function setupPathSourceMarketplace() {
    const mp = bareRepoWithFiles(scratch, "mkt-path", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "mkt",
        owner: { name: "T" },
        plugins: [{ name: "alpha", source: "./plugins/alpha" }],
      }),
      "plugins/alpha/skills/hello/SKILL.md":
        "---\ndescription: hi\n---\nHello body",
      "plugins/alpha/README.md": "alpha plugin",
    });
    const r = await addMarketplace("mkt", { source: "git", url: mp });
    if (!r.ok) throw new Error("setup failed: " + r.error);
  }

  it("installs a path-source plugin into cache and updates manifest", async () => {
    await setupPathSourceMarketplace();
    const r = await installPlugin("alpha", "mkt");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.version).toBe("local");
      expect(r.entry.scope).toBe("user");
      expect(existsSync(join(r.entry.installPath, "skills/hello/SKILL.md"))).toBe(true);
      expect(readFileSync(join(r.entry.installPath, "README.md"), "utf-8")).toBe("alpha plugin");
    }
    const data = readInstalledPlugins();
    expect(data.plugins[pluginInstallKey("alpha", "mkt")]).toHaveLength(1);
  });

  it("reinstall replaces the cache + manifest entry (idempotent)", async () => {
    await setupPathSourceMarketplace();
    const a = await installPlugin("alpha", "mkt");
    expect(a.ok).toBe(true);
    const b = await installPlugin("alpha", "mkt");
    expect(b.ok).toBe(true);
    const data = readInstalledPlugins();
    expect(data.plugins[pluginInstallKey("alpha", "mkt")]).toHaveLength(1);
  });

  it("returns error when plugin not in marketplace", async () => {
    await setupPathSourceMarketplace();
    const r = await installPlugin("does-not-exist", "mkt");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });

  it("returns error when marketplace not added", async () => {
    const r = await installPlugin("alpha", "unknown");
    expect(r.ok).toBe(false);
  });

  it("installs a git-source plugin and captures SHA", async () => {
    const pluginRepo = bareRepoWithFiles(scratch, "plugin-git", {
      "skills/x/SKILL.md": "---\ndescription: x\n---\nX body",
    });
    const mp = bareRepoWithFiles(scratch, "mkt-git", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "mkt",
        owner: { name: "T" },
        plugins: [{ name: "g", source: { source: "git", url: pluginRepo } }],
      }),
    });
    const add = await addMarketplace("mkt", { source: "git", url: mp });
    expect(add.ok).toBe(true);

    const inst = await installPlugin("g", "mkt");
    expect(inst.ok).toBe(true);
    if (inst.ok) {
      expect(inst.entry.version).toMatch(/^[0-9a-f]{12}$/);
      expect(inst.entry.gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(join(inst.entry.installPath, "skills/x/SKILL.md"))).toBe(true);
    }
  });

  it("installs a git-subdir plugin (copies the subPath only)", async () => {
    const monoRepo = bareRepoWithFiles(scratch, "mono", {
      "plugins/foo/skills/y/SKILL.md": "---\ndescription: y\n---\nY body",
      "plugins/bar/README.md": "bar plugin (should NOT be copied)",
      "README.md": "monorepo (should NOT be copied)",
    });
    const mp = bareRepoWithFiles(scratch, "mkt-sub", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "mkt",
        owner: { name: "T" },
        plugins: [
          {
            name: "foo",
            source: { source: "git-subdir", url: monoRepo, path: "plugins/foo" },
          },
        ],
      }),
    });
    const add = await addMarketplace("mkt", { source: "git", url: mp });
    expect(add.ok).toBe(true);

    const inst = await installPlugin("foo", "mkt");
    expect(inst.ok).toBe(true);
    if (inst.ok) {
      expect(existsSync(join(inst.entry.installPath, "skills/y/SKILL.md"))).toBe(true);
      // bar is NOT copied
      expect(existsSync(join(inst.entry.installPath, "..", "bar"))).toBe(false);
      // monorepo README NOT copied
      expect(existsSync(join(inst.entry.installPath, "README.md"))).toBe(false);
    }
  });

  it("uninstall removes manifest entry and cache dir", async () => {
    await setupPathSourceMarketplace();
    const inst = await installPlugin("alpha", "mkt");
    expect(inst.ok).toBe(true);
    if (!inst.ok) return;
    const cache = inst.entry.installPath;
    expect(existsSync(cache)).toBe(true);

    const r = uninstallPlugin("alpha", "mkt");
    expect(r.removedFromManifest).toBe(true);
    expect(r.removedFromDisk).toBe(true);
    expect(existsSync(cache)).toBe(false);
    expect(readInstalledPlugins().plugins[pluginInstallKey("alpha", "mkt")]).toBeUndefined();
  });

  it("uninstall returns false if nothing installed", () => {
    const r = uninstallPlugin("none", "none");
    expect(r.removedFromManifest).toBe(false);
    expect(r.removedFromDisk).toBe(false);
  });

  it("listInstalled returns sorted entries", async () => {
    await setupPathSourceMarketplace();
    await installPlugin("alpha", "mkt");
    const list = listInstalled();
    expect(list).toHaveLength(1);
    expect(list[0]!.key).toBe("alpha@mkt");
  });
});
