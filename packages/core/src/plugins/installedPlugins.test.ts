import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  installedPluginsPath,
  readInstalledPlugins,
  writeInstalledPlugins,
} from "./installedPlugins.js";

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
});
