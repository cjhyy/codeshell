import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runPluginCommand } from "../packages/tui/src/cli/commands/builtin/plugin-handler.js";

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

describe("/plugin command", () => {
  let fakeHome: string;
  let originalHome: string | undefined;
  let scratch: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), "plugin-cmd-home-"));
    scratch = mkdtempSync(join(tmpdir(), "plugin-cmd-fixture-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  it("no args prints usage", async () => {
    const out = await runPluginCommand("");
    expect(out).toContain("Usage:");
    expect(out).toContain("/plugin marketplace add");
  });

  it("unknown subcommand prints usage", async () => {
    const out = await runPluginCommand("foobar");
    expect(out).toContain("Unknown subcommand");
    expect(out).toContain("Usage:");
  });

  it("marketplace list shows empty state", async () => {
    const out = await runPluginCommand("marketplace list");
    expect(out).toContain("No marketplaces");
  });

  it("marketplace add succeeds and lists plugins", async () => {
    const bare = bareRepoWithFiles(scratch, "src", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "fixture",
        owner: { name: "T" },
        plugins: [{ name: "alpha", description: "the alpha plugin", source: "./alpha" }],
      }),
      "alpha/skills/hello/SKILL.md": "---\ndescription: hi\n---\nbody",
    });
    const out = await runPluginCommand(`marketplace add ${bare}`);
    expect(out).toContain("Added marketplace");
    expect(out).toContain("alpha");
    expect(out).toContain("the alpha plugin");
  });

  it("marketplace add rejects invalid input", async () => {
    const out = await runPluginCommand("marketplace add random-not-a-url");
    expect(out).toContain("Cannot parse");
  });

  it("marketplace remove handles missing name", async () => {
    const out = await runPluginCommand("marketplace remove ghost");
    expect(out).toContain("not found");
  });

  it("install + list + uninstall round trip", async () => {
    const bare = bareRepoWithFiles(scratch, "src", {
      ".claude-plugin/marketplace.json": JSON.stringify({
        name: "fixture",
        owner: { name: "T" },
        plugins: [{ name: "alpha", source: "./alpha" }],
      }),
      "alpha/skills/hello/SKILL.md": "---\ndescription: hi\n---\nbody",
    });
    const add = await runPluginCommand(`marketplace add ${bare}`);
    expect(add).toContain("Added marketplace");

    // derive marketplace name from URL: last segment of "/path/to/src.git" → "src"
    const inst = await runPluginCommand("install alpha@src");
    expect(inst).toContain("Installed alpha@src");

    const list = await runPluginCommand("list");
    expect(list).toContain("alpha@src");

    const uninst = await runPluginCommand("uninstall alpha@src");
    expect(uninst).toContain("Uninstalled alpha@src");
  });

  it("install rejects malformed key", async () => {
    const out = await runPluginCommand("install just-a-name");
    expect(out).toContain("Expected <plugin>@<marketplace>");
  });

  it("install reports marketplace not found", async () => {
    const out = await runPluginCommand("install alpha@nowhere");
    expect(out).toContain("not found");
  });
});
