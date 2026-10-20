import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listPlugins, uninstallPluginEntry } from "./plugins-service.js";
import {
  addMarketplaceFromInput,
  classifyLocalInstallError,
  installLocalPluginForUi,
  installPluginForUi,
  listPluginInstallJobsForUi,
  parseRecommendedMarketplaces,
  previewLocalPluginForUi,
} from "./marketplace-service.js";

/**
 * Local-install error classification (protects the unsubmitted overwrite UI
 * flow). The contract: core bakes the authoritative plugin name into a
 * "plugin '<name>' already installed" error; the UI must extract that exact
 * name and surface { alreadyInstalled: true } so the overwrite prompt names the
 * right plugin. If core ever changes this error wording, the fragile regex
 * would silently break the overwrite flow — this test pins it.
 */
describe("classifyLocalInstallError", () => {
  test("already-installed error → { alreadyInstalled, authoritative name }", () => {
    const r = classifyLocalInstallError("plugin 'superpowers' already installed");
    expect(r).toEqual({ ok: false, alreadyInstalled: true, name: "superpowers" });
  });

  test("extracts the name core derived (manifest name), not the picker's filename guess", () => {
    // zip picked as "my-download.zip" but the manifest name is "mimi-video".
    const r = classifyLocalInstallError("plugin 'mimi-video' already installed");
    expect(r).toMatchObject({ alreadyInstalled: true, name: "mimi-video" });
  });

  test("handles names with spaces/hyphens (non-greedy capture stops at the quote)", () => {
    const r = classifyLocalInstallError("plugin 'My Cool-Plugin' already installed");
    expect(r).toMatchObject({ alreadyInstalled: true, name: "My Cool-Plugin" });
  });

  test("unrelated error → humanized { ok:false, error } without alreadyInstalled", () => {
    const r = classifyLocalInstallError("some random failure");
    expect(r).toEqual({ ok: false, error: "some random failure" });
    expect("alreadyInstalled" in r).toBe(false);
  });

  test("GIT_NOT_FOUND is humanized to actionable guidance", () => {
    const r = classifyLocalInstallError("GIT_NOT_FOUND: git not on PATH");
    expect(r.ok).toBe(false);
    if (!("alreadyInstalled" in r)) {
      expect(r.error).toContain("Git");
      expect(r.error).toContain("git-scm.com");
    }
  });
});

describe("parseRecommendedMarketplaces", () => {
  test("accepts the object shape served by the GitHub recommendation list", () => {
    const list = parseRecommendedMarketplaces({
      marketplaces: [
        {
          id: "mimi",
          name: "Mimi Plugins",
          reason: "default recommendation",
          source: { source: "github", repo: "cjhyy/mimi-plugins" },
          format: "universal",
          official: true,
          sort: 5,
        },
      ],
    });
    expect(list).toEqual([
      expect.objectContaining({
        id: "mimi",
        name: "Mimi Plugins",
        reason: "default recommendation",
        source: { source: "github", repo: "cjhyy/mimi-plugins" },
        format: "universal",
        official: true,
      }),
    ]);
  });

  test("derives stable names/ids and drops invalid entries", () => {
    const list = parseRecommendedMarketplaces([
      { source: { source: "github", repo: "owner/cool-market" } },
      { name: "bad" },
      { source: { source: "git", url: "https://example.com/team/second-market.git" } },
    ]);
    expect(list.map((item) => item.id)).toEqual(["cool-market", "second-market"]);
    expect(list.map((item) => item.name)).toEqual(["cool-market", "second-market"]);
  });
});

describe("reviewed local plugin installation", () => {
  let home: string;
  let source: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "desktop-plugin-review-home-"));
    source = mkdtempSync(join(tmpdir(), "desktop-plugin-review-source-"));
    process.env.HOME = home;
    mkdirSync(join(source, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(source, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "reviewed-local", version: "1.0.0" }),
    );
    mkdirSync(join(source, "commands"), { recursive: true });
    writeFileSync(join(source, "commands", "hello.md"), "hello\n");
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(source, { recursive: true, force: true });
  });

  test("rejects a source changed after review without mutating installed state", async () => {
    const reviewed = await previewLocalPluginForUi({ kind: "dir", path: source });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    writeFileSync(join(source, "commands", "hello.md"), "changed\n");

    const result = await installLocalPluginForUi({
      kind: "dir",
      path: source,
      reviewToken: reviewed.preview.reviewToken,
    });

    expect(result).toEqual(expect.objectContaining({ ok: false, previewChanged: true }));
    expect(existsSync(join(home, ".code-shell", "plugins", "reviewed-local"))).toBe(false);
  });

  test("installs only with the current review token", async () => {
    const reviewed = await previewLocalPluginForUi({ kind: "dir", path: source });
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;

    const result = await installLocalPluginForUi({
      kind: "dir",
      path: source,
      reviewToken: reviewed.preview.reviewToken,
    });

    expect(result).toEqual({ ok: true, name: "reviewed-local" });
    expect(existsSync(join(home, ".code-shell", "plugins", "reviewed-local"))).toBe(true);
  });
});

describe("marketplace install jobs", () => {
  let home: string;
  let base: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "desktop-market-job-home-"));
    base = mkdtempSync(join(tmpdir(), "desktop-market-job-source-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  function git(cwd: string, args: string[]): void {
    execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      stdio: "pipe",
    });
  }

  async function waitForJob(id: string, status: string): Promise<void> {
    const started = Date.now();
    while (listPluginInstallJobsForUi().find((job) => job.id === id)?.status !== status) {
      if (Date.now() - started > 10_000) throw new Error(`job ${id} never reached ${status}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("an uninstalled plugin can be reinstalled from the same marketplace", async () => {
    const market = "job-market";
    const plugin = "job-plugin";
    const repo = join(base, `${market}.git`);
    mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
    mkdirSync(join(repo, "payload", ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(repo, "payload", ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: plugin, version: "1.0.0" }),
    );
    writeFileSync(
      join(repo, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        name: market,
        owner: { name: "Fixture" },
        plugins: [{ name: plugin, source: "./payload", version: "1.0.0" }],
      }),
    );
    git(repo, ["init", "-q"]);
    git(repo, ["add", "."]);
    git(repo, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-q", "-m", "v1"]);
    expect(await addMarketplaceFromInput(repo)).toMatchObject({ ok: true, name: market });
    const jobId = `${market}::${plugin}`;
    const installed = () => listPlugins("").some((p) => p.installKey === `${plugin}@${market}`);

    expect(await installPluginForUi(plugin, market)).toMatchObject({ ok: true });
    await waitForJob(jobId, "installed");
    expect(installed()).toBe(true);

    uninstallPluginEntry(plugin, market);
    expect(installed()).toBe(false);
    // The earlier success no longer describes the installed inventory.
    expect(listPluginInstallJobsForUi().find((job) => job.id === jobId)?.status).not.toBe(
      "installed",
    );

    const again = await installPluginForUi(plugin, market);
    expect(again.job?.status).not.toBe("installed");
    await waitForJob(jobId, "installed");
    expect(installed()).toBe(true);
  });
});
