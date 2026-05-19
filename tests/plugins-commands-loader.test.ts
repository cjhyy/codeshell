import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanPluginCommands,
  invalidatePluginCommandsCache,
} from "../src/plugins/pluginCommandsLoader.js";

describe("scanPluginCommands", () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    invalidatePluginCommandsCache();
    fakeHome = mkdtempSync(join(tmpdir(), "plugincmd-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    invalidatePluginCommandsCache();
    rmSync(fakeHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  function installPluginWithCommands(
    pluginKey: string,
    cacheDir: string,
    commands: Record<string, string>,
  ) {
    const cmdDir = join(cacheDir, "commands");
    mkdirSync(cmdDir, { recursive: true });
    for (const [name, contents] of Object.entries(commands)) {
      writeFileSync(join(cmdDir, name), contents);
    }
    const pluginsDir = join(fakeHome, ".code-shell", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          [pluginKey]: [
            {
              scope: "user",
              installPath: cacheDir,
              version: "abc",
              installedAt: "t",
              lastUpdated: "t",
            },
          ],
        },
      }),
    );
  }

  it("returns [] when no plugins installed", () => {
    expect(scanPluginCommands()).toEqual([]);
  });

  it("discovers <plugin>:<cmd> from a commands/<cmd>.md file", () => {
    const cache = mkdtempSync(join(tmpdir(), "plugincmd-cache-"));
    try {
      installPluginWithCommands("sp@mkt", cache, {
        "brainstorm.md": "---\ndescription: brainstorm ideas\n---\nBrainstorm body",
      });
      const cmds = scanPluginCommands();
      expect(cmds).toHaveLength(1);
      expect(cmds[0]!.name).toBe("sp:brainstorm");
      expect(cmds[0]!.commandName).toBe("brainstorm");
      expect(cmds[0]!.pluginName).toBe("sp");
      expect(cmds[0]!.description).toBe("brainstorm ideas");
      expect(cmds[0]!.body).toBe("Brainstorm body");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("captures argument-hint", () => {
    const cache = mkdtempSync(join(tmpdir(), "plugincmd-arg-"));
    try {
      installPluginWithCommands("sp@mkt", cache, {
        "review.md":
          "---\ndescription: review code\nargument-hint: <pr-number>\n---\nReview body",
      });
      const cmds = scanPluginCommands();
      expect(cmds[0]!.argumentHint).toBe("<pr-number>");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("ignores non-.md files in commands/", () => {
    const cache = mkdtempSync(join(tmpdir(), "plugincmd-non-"));
    try {
      installPluginWithCommands("sp@mkt", cache, {
        "real.md": "---\ndescription: real\n---\nbody",
        "README.txt": "not a command",
      });
      const cmds = scanPluginCommands();
      expect(cmds).toHaveLength(1);
      expect(cmds[0]!.commandName).toBe("real");
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("handles plugin with no commands/ dir (no error)", () => {
    const cache = mkdtempSync(join(tmpdir(), "plugincmd-empty-"));
    try {
      // Don't create commands/ dir at all
      const pluginsDir = join(fakeHome, ".code-shell", "plugins");
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "sp@mkt": [
              {
                scope: "user",
                installPath: cache,
                version: "abc",
                installedAt: "t",
                lastUpdated: "t",
              },
            ],
          },
        }),
      );
      expect(scanPluginCommands()).toEqual([]);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it("orders commands stably by plugin name then command name", () => {
    const cacheA = mkdtempSync(join(tmpdir(), "plugincmd-orderA-"));
    const cacheB = mkdtempSync(join(tmpdir(), "plugincmd-orderB-"));
    try {
      // Add both plugins. Plugin id ordering: "a@m" < "b@m" stably.
      const cmdA = join(cacheA, "commands");
      mkdirSync(cmdA, { recursive: true });
      writeFileSync(join(cmdA, "z.md"), "---\ndescription: z\n---\nb");
      writeFileSync(join(cmdA, "a.md"), "---\ndescription: a\n---\nb");

      const cmdB = join(cacheB, "commands");
      mkdirSync(cmdB, { recursive: true });
      writeFileSync(join(cmdB, "m.md"), "---\ndescription: m\n---\nb");

      const pluginsDir = join(fakeHome, ".code-shell", "plugins");
      mkdirSync(pluginsDir, { recursive: true });
      writeFileSync(
        join(pluginsDir, "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: {
            "b@m": [{ scope: "user", installPath: cacheB, version: "v", installedAt: "t", lastUpdated: "t" }],
            "a@m": [{ scope: "user", installPath: cacheA, version: "v", installedAt: "t", lastUpdated: "t" }],
          },
        }),
      );
      const cmds = scanPluginCommands();
      expect(cmds.map((c) => c.name)).toEqual(["a:z", "a:a", "b:m"]);
    } finally {
      rmSync(cacheA, { recursive: true, force: true });
      rmSync(cacheB, { recursive: true, force: true });
    }
  });

  it("memoize invalidates on installed_plugins.json mtime change", async () => {
    expect(scanPluginCommands()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const cache = mkdtempSync(join(tmpdir(), "plugincmd-memo-"));
    try {
      installPluginWithCommands("sp@mkt", cache, {
        "later.md": "---\ndescription: later\n---\nbody",
      });
      const cmds = scanPluginCommands();
      expect(cmds.some((c) => c.name === "sp:later")).toBe(true);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });
});
