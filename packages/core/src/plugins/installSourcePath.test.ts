import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
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
    writeMarketplace({
      source: "git-subdir",
      url: "file:///does-not-need-to-exist",
      path: "../payload",
    });

    const res = await installPlugin("p", "shop");

    if (res.ok) throw new Error("expected git-subdir traversal path to be rejected");
    expect(res.error).toMatch(/parent-directory/);
  });

  test("normalizes panel manifests before activating a marketplace install", async () => {
    mkdirSync(join(mpDir, "payload", ".claude-plugin"), { recursive: true });
    mkdirSync(join(mpDir, "payload", "panels", "dashboard"), { recursive: true });
    writeFileSync(join(mpDir, "payload", "panels", "dashboard", "index.html"), "dashboard");
    writeFileSync(
      join(mpDir, "payload", ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        panels: {
          version: 1,
          entries: [
            {
              id: "dashboard",
              title: { default: "Dashboard" },
              entry: "panels/dashboard/index.html",
            },
          ],
        },
      }),
    );
    writeMarketplace("./payload");

    const res = await installPlugin("p", "shop");

    if (!res.ok) throw new Error(res.error);
    const canonical = JSON.parse(
      readFileSync(join(res.entry.installPath, ".cs-plugin-manifest.json"), "utf-8"),
    );
    expect(canonical.panels.entries[0].entry).toBe("panels/dashboard/index.html");
  });

  test("projects Codex marketplace plugins into runtime-native contributions", async () => {
    mkdirSync(join(mpDir, "payload", ".codex-plugin"), { recursive: true });
    mkdirSync(join(mpDir, "payload", "agents"), { recursive: true });
    mkdirSync(join(mpDir, "payload", "prompts"), { recursive: true });
    mkdirSync(join(mpDir, "payload", "lifecycle"), { recursive: true });
    mkdirSync(join(mpDir, "payload", "scripts"), { recursive: true });
    writeFileSync(
      join(mpDir, "payload", ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "p",
        version: "1.0.0",
        hooks: "./lifecycle/hooks.json",
        mcpServers: {
          files: { command: "files", env_vars: ["FILES_TOKEN"] },
        },
      }),
    );
    writeFileSync(
      join(mpDir, "payload", "agents", "reviewer.toml"),
      'name = "reviewer"\ndescription = "Review changes"',
    );
    writeFileSync(
      join(mpDir, "payload", "prompts", "review.md"),
      "---\ndescription: review\n---\nReview $1",
    );
    writeFileSync(
      join(mpDir, "payload", "lifecycle", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: "node $PLUGIN_ROOT/scripts/start.mjs",
                },
              ],
            },
          ],
        },
      }),
    );
    writeFileSync(join(mpDir, "payload", "scripts", "start.mjs"), "console.log('{}')");
    writeMarketplace("./payload");

    const res = await installPlugin("p", "shop");

    if (!res.ok) throw new Error(res.error);
    expect(existsSync(join(res.entry.installPath, "agents", "reviewer.md"))).toBe(true);
    expect(existsSync(join(res.entry.installPath, "commands", "review.md"))).toBe(true);
    expect(existsSync(join(res.entry.installPath, "hooks", "hooks.json"))).toBe(true);
    expect(res.entry.hookDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.entry.approvedHookDigest).toBeUndefined();
    expect(res.entry.mcpDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(res.entry.approvedMcpDigest).toBeUndefined();
    const mcp = JSON.parse(readFileSync(join(res.entry.installPath, "mcp-servers.json"), "utf-8"));
    expect(mcp["p:files"]).toMatchObject({
      command: "files",
      envVars: ["FILES_TOKEN"],
      name: "p:files",
    });
  });
});
