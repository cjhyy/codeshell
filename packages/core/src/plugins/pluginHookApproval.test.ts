import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPlugins, writeInstalledPlugins } from "./installedPlugins.js";
import { approvePluginHooks, reviewPluginHooks, revokePluginHooks } from "./pluginHookApproval.js";
import { pluginHooksDigest } from "./pluginHookIntegrity.js";

describe("plugin hook approval", () => {
  let home: string;
  let previousHome: string | undefined;
  let installPath: string;

  beforeEach(() => {
    previousHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "plugin-hook-approval-"));
    process.env.HOME = home;
    installPath = join(home, "installed", "demo");
    mkdirSync(join(installPath, "hooks"), { recursive: true });
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo demo" }] }],
        },
      }),
    );
    mkdirSync(join(home, ".code-shell", "plugins"), { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function writeEntry(entry: Record<string, unknown> = {}): void {
    writeFileSync(
      join(home, ".code-shell", "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "demo@local": [
            {
              scope: "user",
              installPath,
              version: "1.0.0",
              installedAt: "t1",
              lastUpdated: "t1",
              ...entry,
            },
          ],
        },
      }),
    );
  }

  test("approves a pending install digest and revoke returns it to pending", () => {
    const hookDigest = pluginHooksDigest(installPath);
    writeEntry({ hookDigest });

    expect(approvePluginHooks("demo")).toEqual([
      {
        installKey: "demo@local",
        plugin: "demo",
        status: "approved",
        changed: true,
      },
    ]);
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedHookDigest).toBe(hookDigest);
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedHookSnapshot).toMatchObject([
      { rawEvent: "SessionStart", command: "echo demo" },
    ]);

    expect(revokePluginHooks("demo@local")[0]).toMatchObject({
      status: "pending",
      changed: true,
    });
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.approvedHookDigest).toBeUndefined();
  });

  test("reviews each upgraded command against the last explicitly approved snapshot", () => {
    const hookDigest = pluginHooksDigest(installPath);
    writeEntry({ hookDigest });
    approvePluginHooks("demo");

    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "resume",
              hooks: [{ type: "command", command: "echo upgraded" }],
            },
          ],
        },
      }),
    );
    const data = readInstalledPlugins();
    const entry = data.plugins["demo@local"]![0]!;
    entry.hookDigest = pluginHooksDigest(installPath);
    delete entry.approvedHookDigest;
    writeInstalledPlugins(data);

    expect(reviewPluginHooks("demo")[0]).toMatchObject({
      installKey: "demo@local",
      status: "pending",
      baselineAvailable: true,
      items: [
        {
          change: "changed",
          previous: { command: "echo demo" },
          current: { command: "echo upgraded", matcher: "resume" },
        },
      ],
    });

    approvePluginHooks("demo");
    expect(reviewPluginHooks("demo")[0]).toMatchObject({
      status: "approved",
      items: [{ change: "unchanged" }],
    });
  });

  test("revoking a legacy install records the digest so it fails closed", () => {
    writeEntry();

    expect(revokePluginHooks("demo")[0]).toMatchObject({
      status: "pending",
      changed: true,
    });
    const entry = readInstalledPlugins().plugins["demo@local"]?.[0];
    expect(entry?.hookDigest).toBe(pluginHooksDigest(installPath));
    expect(entry?.approvedHookDigest).toBeUndefined();
  });

  test("refuses to approve bytes that changed after installation", () => {
    writeEntry({ hookDigest: pluginHooksDigest(installPath) });
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo tampered" }] }],
        },
      }),
    );

    expect(() => approvePluginHooks("demo")).toThrow(/changed after install/);
  });

  test("refuses to approve an invalid bounded definition", () => {
    writeEntry();
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: "[",
              hooks: [{ type: "command", command: "echo invalid" }],
            },
          ],
        },
      }),
    );

    expect(() => approvePluginHooks("demo")).toThrow(/invalid and cannot be approved/);
    expect(readInstalledPlugins().plugins["demo@local"]?.[0]?.hookDigest).toBeUndefined();
  });

  test("requires an install key when a bare name is ambiguous", () => {
    writeEntry();
    const data = JSON.parse(
      readFileSync(join(home, ".code-shell", "plugins", "installed_plugins.json"), "utf-8"),
    );
    data.plugins["demo@other"] = [
      {
        scope: "user",
        installPath,
        version: "1.0.0",
        installedAt: "t1",
        lastUpdated: "t1",
      },
    ];
    writeFileSync(
      join(home, ".code-shell", "plugins", "installed_plugins.json"),
      JSON.stringify(data),
    );

    expect(() => approvePluginHooks("demo")).toThrow(/multiple installs/);
  });
});
