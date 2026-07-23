import { describe, expect, test } from "bun:test";
import type {
  ExternalSessionDiscoveryScope,
  RecentExternalSession,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import type { ExternalCli } from "./external-session-adapter";
import {
  ExternalSessionVisibilityController,
  resolveExternalSessionVisibility,
  touchesExternalSessionVisibility,
  type ControlledExternalSessionAdapter,
} from "./external-session-visibility";

describe("resolveExternalSessionVisibility", () => {
  test("defaults off and lets project on/off override the global baseline", () => {
    expect(resolveExternalSessionVisibility("codex", {})).toBe(false);
    expect(
      resolveExternalSessionVisibility(
        "codex",
        { pet: { showExternalCodexSessions: false } },
        { capabilityOverrides: { pet: { showExternalCodexSessions: "on" } } },
      ),
    ).toBe(true);
    expect(
      resolveExternalSessionVisibility(
        "claude",
        { pet: { showExternalClaudeSessions: true } },
        { capabilityOverrides: { pet: { showExternalClaudeSessions: "off" } } },
      ),
    ).toBe(false);
  });

  test("missing/inherit project values preserve the global value", () => {
    const user = { pet: { showExternalCodexSessions: true } };
    expect(resolveExternalSessionVisibility("codex", user, {})).toBe(true);
    expect(
      resolveExternalSessionVisibility("codex", user, {
        capabilityOverrides: { pet: { showExternalCodexSessions: "inherit" } },
      }),
    ).toBe(true);
  });

  test("detects only relevant user/project patches", () => {
    expect(
      touchesExternalSessionVisibility("user", {
        pet: { showExternalCodexSessions: true },
      }),
    ).toBe(true);
    expect(
      touchesExternalSessionVisibility("project", {
        capabilityOverrides: { pet: { showExternalClaudeSessions: "off" } },
      }),
    ).toBe(true);
    expect(
      touchesExternalSessionVisibility("project", {
        capabilityOverrides: { skills: { demo: "off" } },
      }),
    ).toBe(false);
  });
});

describe("ExternalSessionVisibilityController", () => {
  test("does not create or scan/tail either source while all effective settings are off", async () => {
    let creates = 0;
    const controller = new ExternalSessionVisibilityController({
      readUserSettings: () => ({}),
      readProjectSettings: () => ({}),
      listProjectCwds: async () => ["/work/a"],
      createAdapter: () => {
        creates += 1;
        throw new Error("disabled source must not be constructed");
      },
    });

    await controller.reconcile();
    expect(creates).toBe(0);
    controller.shutdown();
  });

  test("hot-reconciles project overrides and filters each discovered cwd", async () => {
    let userSettings: Record<string, unknown> = {};
    const projects: Record<string, Record<string, unknown>> = {
      "/work/a": {
        capabilityOverrides: { pet: { showExternalCodexSessions: "on" } },
      },
      "/work/b": {},
    };
    const created: Array<{
      cli: ExternalCli;
      scope: () => ExternalSessionDiscoveryScope;
      include: (session: RecentExternalSession) => boolean;
      adapter: ControlledExternalSessionAdapter & { starts: number; stops: number; scans: number };
    }> = [];
    const disabled: ExternalCli[] = [];
    const controller = new ExternalSessionVisibilityController({
      readUserSettings: () => userSettings,
      readProjectSettings: (cwd) => projects[cwd] ?? {},
      listProjectCwds: async () => ["/work/a/", "/work/b/"],
      createAdapter: (cli, scope, include) => {
        const adapter = {
          starts: 0,
          stops: 0,
          scans: 0,
          start() {
            this.starts += 1;
          },
          stop() {
            this.stops += 1;
          },
          async scanOnce() {
            this.scans += 1;
          },
        };
        created.push({ cli, scope, include, adapter });
        return adapter;
      },
      onSourceDisabled: (cli) => disabled.push(cli),
    });

    await controller.reconcile();
    expect(created.map((entry) => entry.cli)).toEqual(["codex"]);
    expect(created[0]!.adapter.starts).toBe(1);
    expect(
      created[0]!
        .scope()
        .projectRoots.filter((root) => root.enabled)
        .map((root) => root.cwd),
    ).toEqual(["/work/a"]);
    const session = (cwd: string): RecentExternalSession => ({
      sessionId: cwd,
      cwd,
      file: "/tmp/session.jsonl",
      lastModified: 1,
      firstMessage: "",
    });
    expect(created[0]!.include(session("/work/a/packages/app"))).toBe(true);
    expect(created[0]!.include(session("/work/b/packages/app"))).toBe(false);

    projects["/work/a"] = {
      capabilityOverrides: { pet: { showExternalCodexSessions: "off" } },
    };
    await controller.reconcile();
    expect(created[0]!.adapter.stops).toBe(1);
    expect(disabled).toEqual(["codex"]);

    userSettings = { pet: { showExternalCodexSessions: true } };
    await controller.reconcile();
    const restarted = created[1]!;
    expect(restarted.cli).toBe("codex");
    expect(restarted.include(session("/work/a/packages/app"))).toBe(false);
    expect(restarted.include(session("/work/b/packages/app"))).toBe(true);

    projects["/work/a"] = {
      capabilityOverrides: { pet: { showExternalCodexSessions: "on" } },
    };
    await controller.reconcile();
    expect(restarted.adapter.scans).toBe(1);
    expect(restarted.include(session("/work/a/packages/app"))).toBe(true);
    controller.shutdown();
  });

  test("normalizes roots and uses the longest registered ancestor for nested sessions", async () => {
    const reads: string[] = [];
    let include: ((session: RecentExternalSession) => boolean) | undefined;
    const controller = new ExternalSessionVisibilityController({
      readUserSettings: () => ({}),
      readProjectSettings: (cwd) => {
        reads.push(cwd);
        return {
          capabilityOverrides: {
            pet: {
              showExternalCodexSessions: cwd === "/work/repo/packages/app" ? "on" : "off",
            },
          },
        };
      },
      listProjectCwds: async () => ["/work/repo/", "/work/repo/packages/app/"],
      createAdapter: (_cli, _scope, predicate) => {
        include = predicate;
        return { start() {}, stop() {}, async scanOnce() {} };
      },
    });

    await controller.reconcile();
    expect(reads).toEqual(["/work/repo", "/work/repo/packages/app"]);
    const session = (cwd: string): RecentExternalSession => ({
      sessionId: cwd,
      cwd,
      file: "/tmp/session.jsonl",
      lastModified: 1,
      firstMessage: "",
    });
    expect(include?.(session("/work/repo/packages/app/src"))).toBe(true);
    expect(include?.(session("/work/repo/packages/other"))).toBe(false);
    controller.shutdown();
  });

  test("does not block settings reconciliation on a full adapter scan", async () => {
    let releaseScan: (() => void) | undefined;
    let scans = 0;
    const controller = new ExternalSessionVisibilityController({
      readUserSettings: () => ({ pet: { showExternalCodexSessions: true } }),
      readProjectSettings: () => ({}),
      listProjectCwds: async () => ["/work/a"],
      createAdapter: () => ({
        start() {},
        stop() {},
        scanOnce: () => {
          scans += 1;
          return new Promise<void>((resolve) => {
            releaseScan = resolve;
          });
        },
      }),
    });
    await controller.reconcile();

    const reconciled = controller.reconcile();
    await reconciled;
    expect(scans).toBe(1);
    releaseScan?.();
    controller.shutdown();
  });
});
