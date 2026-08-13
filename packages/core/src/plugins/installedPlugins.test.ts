import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  installedPluginsPath,
  appendInstallEntry,
  readInstalledPlugins,
  writeInstalledPlugins,
} from "./installedPlugins.js";

const MODULE = join(import.meta.dir, "installedPlugins.ts");

describe("installed plugin registry persistence", () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "installed-plugins-store-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("replaces the registry atomically without leaving temporary files", () => {
    writeInstalledPlugins({
      version: 2,
      plugins: {
        "demo@local": [
          {
            scope: "user",
            installPath: join(home, "demo"),
            version: "1.0.0",
            installedAt: "t1",
            lastUpdated: "t1",
          },
        ],
      },
    });
    writeInstalledPlugins({ version: 2, plugins: {} });

    expect(JSON.parse(readFileSync(installedPluginsPath(), "utf8"))).toEqual({
      version: 2,
      plugins: {},
    });
    expect(
      readdirSync(dirname(installedPluginsPath())).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    if (process.platform !== "win32") {
      expect(statSync(installedPluginsPath()).mode & 0o777).toBe(0o600);
    }
  });

  test("rejects an array-shaped plugins registry", () => {
    const path = installedPluginsPath();
    writeInstalledPlugins({ version: 2, plugins: {} });
    writeFileSync(path, JSON.stringify({ version: 2, plugins: [] }));
    expect(readInstalledPlugins()).toEqual({ version: 2, plugins: {} });
  });

  test("round-trips bounded last-approved hook review metadata", () => {
    writeInstalledPlugins({
      version: 2,
      plugins: {
        "demo@local": [
          {
            scope: "user",
            installPath: join(home, "demo"),
            version: "1.0.0",
            installedAt: "t1",
            lastUpdated: "t1",
            approvedHookSnapshot: [
              {
                rawEvent: "PreToolUse",
                matcher: "^Bash$",
                command: "node hook.mjs",
                commandDigest: "a".repeat(64),
                async: false,
                timeoutMs: 1_000,
              },
            ],
          },
        ],
      },
    });

    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedHookSnapshot).toEqual([
      {
        rawEvent: "PreToolUse",
        matcher: "^Bash$",
        command: "node hook.mjs",
        commandDigest: "a".repeat(64),
        async: false,
        timeoutMs: 1_000,
      },
    ]);
  });

  test("isolates malformed entries while preserving valid installs", () => {
    const path = installedPluginsPath();
    writeInstalledPlugins({ version: 2, plugins: {} });
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@local": [
            null,
            { scope: "user", installPath: 42 },
            {
              scope: "user",
              installPath: join(home, "demo"),
              version: "1.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
              hookDigest: "not-a-digest",
            },
          ],
          "bad\u0000key": [
            {
              scope: "user",
              installPath: join(home, "bad"),
              version: "1.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
            },
          ],
        },
      }),
    );

    expect(readInstalledPlugins()).toEqual({
      version: 2,
      plugins: {
        "demo@local": [
          {
            scope: "user",
            installPath: join(home, "demo"),
            version: "1.0.0",
            installedAt: "t1",
            lastUpdated: "t1",
          },
        ],
      },
    });
  });

  test("refuses a linked registry without touching its target", () => {
    const path = installedPluginsPath();
    mkdirSync(dirname(path), { recursive: true });
    const outside = join(home, "outside.json");
    writeFileSync(outside, JSON.stringify({ version: 2, plugins: {} }));
    symlinkSync(outside, path);
    expect(readInstalledPlugins()).toEqual({ version: 2, plugins: {} });
    expect(() =>
      appendInstallEntry("demo@local", {
        scope: "user",
        installPath: join(home, "demo"),
        version: "1",
        installedAt: "now",
        lastUpdated: "now",
      }),
    ).toThrow(/bounded regular file/);
    expect(JSON.parse(readFileSync(outside, "utf8"))).toEqual({ version: 2, plugins: {} });
  });

  test("concurrent processes preserve every independently installed plugin", async () => {
    const total = 16;
    const children = Array.from({ length: total }, (_, index) => {
      const script = `
        import { appendInstallEntry } from ${JSON.stringify(MODULE)};
        appendInstallEntry(${JSON.stringify(`plugin-${index}@local`)}, {
          scope: "user",
          installPath: ${JSON.stringify(join(home, `plugin-${index}`))},
          version: "1",
          installedAt: "now",
          lastUpdated: "now"
        });
      `;
      return Bun.spawn([process.execPath, "-e", script], {
        env: { ...process.env, HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });
    });
    expect((await Promise.all(children.map((child) => child.exited))).every((code) => code === 0)).toBe(
      true,
    );
    expect(Object.keys(readInstalledPlugins().plugins)).toHaveLength(total);
  }, 60_000);
});
