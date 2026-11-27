import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readInstalledPlugins, writeInstalledPlugins } from "./installedPlugins.js";
import { approvePluginHooks, reviewPluginHooks, revokePluginHooks } from "./pluginHookApproval.js";
import { pluginHooksDigest } from "./pluginHookIntegrity.js";
import { computePluginTreeDigest } from "./pluginTreeDigest.js";

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

  function treeDigest(): string {
    const tree = computePluginTreeDigest(installPath);
    if (!tree.ok) throw new Error(tree.reason);
    return tree.digest;
  }

  function installed() {
    return readInstalledPlugins().plugins["demo@local"]?.[0];
  }

  test("checks the initiating document before persisting either trust transition", () => {
    writeEntry({ hookDigest: pluginHooksDigest(installPath) });
    const registry = () => JSON.stringify(readInstalledPlugins());
    const reject = () => {
      throw Error("Document revoked");
    };
    const before = registry();
    expect(() => approvePluginHooks("demo@local", reject)).toThrow("Document revoked");
    expect(registry()).toBe(before);
    approvePluginHooks("demo@local");
    const accepted = registry();
    expect(() => revokePluginHooks("demo@local", reject)).toThrow("Document revoked");
    expect(registry()).toBe(accepted);
  });

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
    expect(installed()?.contentDigest).toBe(treeDigest());
    expect(installed()?.approvedContentDigest).toBe(treeDigest());

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
    entry.contentDigest = treeDigest();
    delete entry.approvedContentDigest;
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

  test("revoking only removes approvals; an unrecorded install stays as it was", () => {
    writeEntry();

    expect(revokePluginHooks("demo")[0]).toMatchObject({
      status: "pending",
      changed: false,
    });
    const entry = readInstalledPlugins().plugins["demo@local"]?.[0];
    expect(entry?.hookDigest).toBeUndefined();
    expect(entry?.approvedHookDigest).toBeUndefined();
  });

  test("hooks edited after installation are approved in place, and the edit is what runs", () => {
    const installedDigest = pluginHooksDigest(installPath);
    writeEntry({ hookDigest: installedDigest });
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo edited locally" }] }],
        },
      }),
    );

    expect(approvePluginHooks("demo")[0]).toMatchObject({ status: "approved", changed: true });
    // The record still names the installed version; the review baseline is what was approved.
    expect(installed()?.hookDigest).toBe(installedDigest);
    expect(installed()?.approvedHookSnapshot).toMatchObject([{ command: "echo edited locally" }]);
  });

  test("revoking a plugin without hooks keeps hooks added later from running", () => {
    rmSync(join(installPath, "hooks"), { recursive: true, force: true });
    const absent = pluginHooksDigest(installPath);
    // As installed: content approved, the absent hooks approved along with it.
    writeEntry({
      hookDigest: absent,
      approvedHookDigest: absent,
      contentDigest: treeDigest(),
      approvedContentDigest: treeDigest(),
    });
    revokePluginHooks("demo");

    mkdirSync(join(installPath, "hooks"));
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } }),
    );
    expect(reviewPluginHooks("demo")[0]?.status).toBe("pending");
  });

  test("hooks added locally to an approved plugin run", () => {
    rmSync(join(installPath, "hooks"), { recursive: true, force: true });
    const absent = pluginHooksDigest(installPath);
    writeEntry({
      hookDigest: absent,
      approvedHookDigest: absent,
      contentDigest: treeDigest(),
      approvedContentDigest: treeDigest(),
    });

    mkdirSync(join(installPath, "hooks"));
    writeFileSync(
      join(installPath, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } }),
    );
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
  });

  test("an install recorded before whole-tree approval is pending until approved once", () => {
    writeEntry();
    expect(reviewPluginHooks("demo")[0]?.status).toBe("pending");

    expect(approvePluginHooks("demo")[0]).toMatchObject({ status: "approved", changed: true });
    expect(installed()).toMatchObject({
      hookDigest: pluginHooksDigest(installPath),
      approvedHookDigest: pluginHooksDigest(installPath),
      contentDigest: treeDigest(),
      approvedContentDigest: treeDigest(),
    });
  });

  test("a hook approval granted before whole-tree approval does not carry over", () => {
    const hookDigest = pluginHooksDigest(installPath);
    writeEntry({ hookDigest, approvedHookDigest: hookDigest });
    expect(reviewPluginHooks("demo")[0]?.status).toBe("pending");

    approvePluginHooks("demo");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
  });

  test("a script edited after approval keeps the hooks approved", () => {
    mkdirSync(join(installPath, "scripts"));
    writeFileSync(join(installPath, "scripts", "run.sh"), "echo approved\n");
    writeEntry();
    approvePluginHooks("demo");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");

    writeFileSync(join(installPath, "scripts", "run.sh"), "echo edited locally\n");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
    expect(approvePluginHooks("demo")[0]).toMatchObject({ status: "approved", changed: false });
  });

  test("a file added after approval leaves the approval alone", () => {
    writeEntry();
    approvePluginHooks("demo");
    writeFileSync(join(installPath, "extra.sh"), "echo extra\n");
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
  });

  test("the installer's own root metadata does not disturb an approval", () => {
    writeEntry();
    approvePluginHooks("demo");
    writeFileSync(join(installPath, ".cs-meta.json"), JSON.stringify({ installedAt: "t2" }));
    writeFileSync(join(installPath, ".code-shell-installed.json"), JSON.stringify({ at: "t2" }));
    expect(reviewPluginHooks("demo")[0]?.status).toBe("approved");
  });

  test("an update that is not approved yet is pending", () => {
    writeEntry({ hookDigest: pluginHooksDigest(installPath), contentDigest: treeDigest() });
    expect(reviewPluginHooks("demo")[0]?.status).toBe("pending");
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "refuses to approve a tree it cannot read in full",
    () => {
      mkdirSync(join(installPath, "private"));
      writeFileSync(join(installPath, "private", "run.sh"), "echo hidden\n");
      writeEntry();
      chmodSync(join(installPath, "private"), 0o000);
      try {
        expect(() => approvePluginHooks("demo")).toThrow(/cannot be approved/);
        expect(installed()?.approvedContentDigest).toBeUndefined();
      } finally {
        chmodSync(join(installPath, "private"), 0o700);
      }
    },
  );

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
