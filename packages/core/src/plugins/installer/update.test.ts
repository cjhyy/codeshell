import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { updatePluginByName } from "./update.js";
import { installPluginFromPath } from "./install.js";
import { installPluginFromSource } from "./installFromSource.js";
import { parseSource } from "./parseSource.js";
import { PluginInstallError } from "./types.js";
import { approvePluginHooks, reviewPluginHooks } from "../pluginHookApproval.js";
import { approvePluginMcp } from "../pluginMcpApproval.js";
import { readInstalledPlugins } from "../installedPlugins.js";

/** Any leftover backup dirs (`.bak-*`) in the plugins root — must be empty after both success and failure. */
function leftoverBaks(home: string): string[] {
  const root = join(home, ".code-shell", "plugins");
  if (!existsSync(root)) return [];
  return readdirSync(root).filter((n) => n.includes(".bak-"));
}

describe("updatePluginByName", () => {
  let home: string, src: string, prev: string | undefined;
  beforeEach(async () => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-up-home-"));
    src = mkdtempSync(join(tmpdir(), "cs-up-src-"));
    process.env.HOME = home;
    mkdirSync(join(src, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "u", version: "1.0.0" }),
    );
    mkdirSync(join(src, "agents"), { recursive: true });
    writeFileSync(join(src, "agents", "a.toml"), 'name = "a"\ndescription = "d"');
    await installPluginFromPath(src, "u", "t1");
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  test("no-op when version unchanged", async () => {
    const r = await updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(false);
  });

  test("reinstalls when source version bumped", async () => {
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "u", version: "2.0.0" }),
    );
    const r = await updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(home, ".code-shell", "plugins", "u", ".cs-meta.json"), "utf-8"),
    );
    expect(meta.version).toBe("2.0.0");
  });

  test("force reinstalls even when unchanged", async () => {
    const r = await updatePluginByName("u", "t2", true);
    expect(r.updated).toBe(true);
  });

  test("a failed reinstall is atomic: old plugin is kept, error says so", async () => {
    const installed = join(home, ".code-shell", "plugins", "u");
    const metaPath = join(installed, ".cs-meta.json");
    const before = readFileSync(metaPath, "utf-8");
    // Corrupt the source so installPluginFromPath fails during the reinstall.
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), "{ not valid json");

    await expect(updatePluginByName("u", "t2", true)).rejects.toThrow(PluginInstallError);
    // The OLD version must still be intact (dir + meta + converted agent file).
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);
    expect(readFileSync(metaPath, "utf-8")).toBe(before);
    expect(existsSync(join(installed, "agents", "a.md"))).toBe(true);
    // No backup dir leftover in the plugins root.
    expect(leftoverBaks(home).length).toBe(0);
  });

  test("a failed reinstall error mentions the old version was kept (not removed)", async () => {
    writeFileSync(join(src, ".codex-plugin", "plugin.json"), "{ not valid json");
    await expect(updatePluginByName("u", "t2", true)).rejects.toThrow(/\bkept\b/);
    await expect(updatePluginByName("u", "t2", true)).rejects.not.toThrow(/was removed/);
  });

  test("a successful reinstall leaves the new version and no .bak leftover", async () => {
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "u", version: "3.0.0" }),
    );
    const r = await updatePluginByName("u", "t2", false);
    expect(r.updated).toBe(true);
    const meta = JSON.parse(
      readFileSync(join(home, ".code-shell", "plugins", "u", ".cs-meta.json"), "utf-8"),
    );
    expect(meta.version).toBe("3.0.0");
    expect(leftoverBaks(home).length).toBe(0);
  });

  test("does not remove an unrelated stale backup while staging an update", async () => {
    const staleBackup = join(home, ".code-shell", "plugins", `u.bak-${process.pid}`);
    mkdirSync(staleBackup, { recursive: true });
    writeFileSync(join(staleBackup, "sentinel.txt"), "keep");
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "u", version: "4.0.0" }),
    );

    const result = await updatePluginByName("u", "t2", false);

    expect(result.updated).toBe(true);
    expect(readFileSync(join(staleBackup, "sentinel.txt"), "utf-8")).toBe("keep");
  });

  test("preserves approval for an unchanged hook digest and resets it when hooks change", async () => {
    mkdirSync(join(src, "hooks"), { recursive: true });
    writeFileSync(
      join(src, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo v1" }] }],
        },
      }),
    );
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "u", version: "2.0.0" }),
    );

    await updatePluginByName("u", "t2", false);
    let entry = readInstalledPlugins().plugins["u@local"]?.[0];
    expect(entry?.hookDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.approvedHookDigest).toBeUndefined();

    approvePluginHooks("u");
    const approvedEntry = readInstalledPlugins().plugins["u@local"]?.[0];
    const approvedDigest = approvedEntry?.approvedHookDigest;
    expect(approvedDigest).toBeDefined();
    expect(approvedEntry?.approvedHookSnapshot?.[0]?.command).toBe("echo v1");

    await updatePluginByName("u", "t3", true);
    entry = readInstalledPlugins().plugins["u@local"]?.[0];
    expect(entry?.approvedHookDigest).toBe(approvedDigest);

    writeFileSync(
      join(src, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo v2" }] }],
        },
      }),
    );
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "u", version: "3.0.0" }),
    );

    await updatePluginByName("u", "t4", false);
    entry = readInstalledPlugins().plugins["u@local"]?.[0];
    expect(entry?.hookDigest).not.toBe(approvedDigest);
    expect(entry?.approvedHookDigest).toBeUndefined();
    expect(entry?.approvedHookSnapshot?.[0]?.command).toBe("echo v1");
    expect(reviewPluginHooks("u")[0]).toMatchObject({
      baselineAvailable: true,
      items: [
        {
          change: "changed",
          previous: { command: "echo v1" },
          current: { command: "echo v2" },
        },
      ],
    });
  });

  test("preserves approval for an unchanged MCP digest and resets it when config changes", async () => {
    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "u",
        version: "2.0.0",
        mcpServers: { server: { command: "mcp-v1" } },
      }),
    );

    await updatePluginByName("u", "t2", false);
    let entry = readInstalledPlugins().plugins["u@local"]?.[0];
    expect(entry?.mcpDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(entry?.approvedMcpDigest).toBeUndefined();

    approvePluginMcp("u");
    const approvedDigest = readInstalledPlugins().plugins["u@local"]?.[0]?.approvedMcpDigest;
    expect(approvedDigest).toBeDefined();

    await updatePluginByName("u", "t3", true);
    entry = readInstalledPlugins().plugins["u@local"]?.[0];
    expect(entry?.approvedMcpDigest).toBe(approvedDigest);

    writeFileSync(
      join(src, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "u",
        version: "3.0.0",
        mcpServers: { server: { command: "mcp-v2" } },
      }),
    );

    await updatePluginByName("u", "t4", false);
    entry = readInstalledPlugins().plugins["u@local"]?.[0];
    expect(entry?.mcpDigest).not.toBe(approvedDigest);
    expect(entry?.approvedMcpDigest).toBeUndefined();
  });
});

describe("updatePluginByName (remote source)", () => {
  let home: string, repo: string, prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cs-upr-home-"));
    repo = mkdtempSync(join(tmpdir(), "cs-upr-repo-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test("re-clones a remote-sourced plugin (always reinstalls)", async () => {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv1");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);

    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw, { allowUnsafeTransport: true }), "rem", "t1");

    // bump the repo content + commit
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv2");
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "bump"]);

    const r = await updatePluginByName("rem", "t2", false, { allowUnsafeTransport: true });
    expect(r.updated).toBe(true);
    const body = readFileSync(
      join(home, ".code-shell", "plugins", "rem", "skills", "s", "SKILL.md"),
      "utf-8",
    );
    expect(body).toContain("v2");
    // source string preserved across re-clone
    const meta = JSON.parse(
      readFileSync(join(home, ".code-shell", "plugins", "rem", ".cs-meta.json"), "utf-8"),
    );
    expect(meta.source).toBe(raw);
    expect(existsSync(join(home, ".code-shell", "plugins", "rem"))).toBe(true);
  });

  test("a failed remote reinstall is atomic: old clone is restored", async () => {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv1");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);

    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw, { allowUnsafeTransport: true }), "rem", "t1");
    const installed = join(home, ".code-shell", "plugins", "rem");
    const skillBefore = readFileSync(join(installed, "skills", "s", "SKILL.md"), "utf-8");

    // Destroy the repo so the re-clone fails during the reinstall.
    rmSync(repo, { recursive: true, force: true });

    await expect(
      updatePluginByName("rem", "t2", false, { allowUnsafeTransport: true }),
    ).rejects.toThrow(PluginInstallError);
    // OLD remote install must still be intact and unchanged.
    expect(existsSync(installed)).toBe(true);
    expect(existsSync(join(installed, ".cs-meta.json"))).toBe(true);
    expect(readFileSync(join(installed, "skills", "s", "SKILL.md"), "utf-8")).toBe(skillBefore);
    const root = join(home, ".code-shell", "plugins");
    expect(readdirSync(root).filter((n) => n.includes(".bak-")).length).toBe(0);
  });

  test("rejects unsafe transports from installed metadata by default", async () => {
    mkdirSync(join(repo, "skills", "s"), { recursive: true });
    writeFileSync(join(repo, "skills", "s", "SKILL.md"), "---\nname: s\ndescription: d\n---\nv1");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
    const run = (args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t.t"]);
    run(["config", "user.name", "t"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "init"]);

    const raw = `file://${repo}`;
    await installPluginFromSource(parseSource(raw, { allowUnsafeTransport: true }), "rem", "t1");

    await expect(updatePluginByName("rem", "t2", false)).rejects.toThrow(
      /unsafe plugin source transport 'file:\/\/'/i,
    );
  });
});
