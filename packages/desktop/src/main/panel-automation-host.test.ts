import { expect, test } from "bun:test";
import { CronScheduler } from "@cjhyy/code-shell-core/internal";
import {
  panelAutomationCreationKey,
  parsePanelAutomationCall,
} from "@cjhyy/code-shell-server/panels";
import { createDesktopPanelAutomationHost } from "./panel-automation-host.js";
import type { AutomationAuthorityDeps } from "./automation-authority.js";

const deps: AutomationAuthorityDeps = {
  requireRendererPath: async (cwd) => cwd,
  isNoRepoCwd: () => false,
  resolveExactRoot: () => undefined,
  resolveProjectRootById: (projectId, rootId) => ({
    projectId,
    rootId: rootId!,
    cwd: `/${projectId}`,
  }),
  resolveSessionAuthority: async (sessionId) =>
    sessionId.startsWith("session-")
      ? { sessionId, cwd: "/a", projectId: "a", rootId: "a-root" }
      : undefined,
};
const input = { name: "daily", schedule: "1h", prompt: "check", timezone: "UTC", key: "market.us" };
const scope = { appId: "panel", cwd: "/a", sessionId: "session-a", isAuthorized: async () => true };

test("Web shares native job identity, definitions, pause and deletion through the live scheduler", async () => {
  const s = new CronScheduler();
  s.setExecutionEnabled(false);
  const host = createDesktopPanelAutomationHost(
    () => deps,
    () => s,
  );
  try {
    const native = s.create(input.name, input.schedule, input.prompt, {
      cwd: "/a",
      projectId: "a",
      rootId: "a-root",
      resumeSessionId: scope.sessionId,
      timezone: "UTC",
      permissionLevel: "full",
      creationKey: panelAutomationCreationKey(scope.appId, scope.cwd, scope.sessionId, input.key),
    });
    const web = (await host.call(scope, "automations.createUnique", input)) as any;
    expect(web.id).toBe(native.id);
    expect(s.list()).toHaveLength(1);
    expect(await host.call(scope, "automations.pause", { id: web.id })).toEqual({ ok: true });
    expect(s.get(web.id)?.enabled).toBe(false);
    expect(
      await host.call(scope, "automations.update", { id: web.id, prompt: "updated" }),
    ).toMatchObject({ prompt: "updated", enabled: false });
    expect(await host.call(scope, "automations.resume", { id: web.id })).toEqual({ ok: true });
    expect(
      ((await host.call({ ...scope, sessionId: "session-b" }, "automations.list", {})) as any)
        .automations,
    ).toEqual([]);
    for (const method of ["pause", "resume", "delete", "runNow", "update"])
      await expect(
        host.call({ ...scope, sessionId: "session-b" }, `automations.${method}`, {
          id: web.id,
          ...(method === "update" ? { prompt: "forged" } : {}),
        }),
      ).rejects.toThrow(/not available/);
    await expect(host.call({ ...scope, cwd: "/b" }, "automations.list", {})).rejects.toThrow(/cwd/);
    const executions: string[] = [];
    s.setExecutor(async (job) => {
      executions.push(`${job.resumeSessionId}:${job.prompt}`);
    });
    expect(await host.call(scope, "automations.runNow", { id: web.id })).toEqual({ ok: true });
    await Promise.resolve();
    expect(executions).toEqual(["session-a:updated"]);
    expect(s.get(web.id)?.runCount).toBe(1);
    expect(await host.call(scope, "automations.delete", { id: web.id })).toEqual({ ok: true });
    expect(s.list()).toEqual([]);
  } finally {
    s.stopAll();
  }
});

test("device revocation during persisted session lookup prevents writes and data disclosure", async () => {
  const s = new CronScheduler();
  s.setExecutionEnabled(false);
  let active = true;
  const host = createDesktopPanelAutomationHost(
    () => ({
      ...deps,
      resolveSessionAuthority: async (id) => {
        active = false;
        return deps.resolveSessionAuthority(id);
      },
    }),
    () => s,
  );
  try {
    for (const method of ["automations.createUnique", "automations.list"]) {
      active = true;
      await expect(
        host.call(
          { ...scope, isAuthorized: async () => active },
          method,
          method.endsWith("list") ? {} : input,
        ),
      ).rejects.toThrow(/expired/);
      expect(s.list()).toEqual([]);
    }
  } finally {
    s.stopAll();
  }
});

test("wire calls cannot forge workspace, identity, permission, or method-specific fields", () => {
  for (const extra of [
    { cwd: "/b" },
    { projectId: "b" },
    { resumeSessionId: "other" },
    { creationKey: "forged" },
    { permissionLevel: "workspace-write" },
  ])
    expect(() =>
      parsePanelAutomationCall("automations.createUnique", { ...input, ...extra }),
    ).toThrow();
  expect(() => parsePanelAutomationCall("automations.create", input)).toThrow();
  expect(() =>
    parsePanelAutomationCall("automations.update", { id: "1", creationKey: "forged" }),
  ).toThrow();
  expect(() => parsePanelAutomationCall("automations.list", { id: "1" })).toThrow();
  expect(() =>
    parsePanelAutomationCall("automations.createUnique", { ...input, key: "invalid key" }),
  ).toThrow();
  expect(() =>
    parsePanelAutomationCall("automations.createUnique", { ...input, prompt: "p".repeat(20001) }),
  ).toThrow();
});

test("paired conditional mutations detect native edits and exclude execution statistics", async () => {
  const s = new CronScheduler();
  s.setExecutionEnabled(false);
  const host = createDesktopPanelAutomationHost(
    () => deps,
    () => s,
  );
  try {
    const first = (await host.call(scope, "automations.createUnique", input)) as any;
    s.update(first.id, { prompt: "native edit" });
    expect(
      await host.call(scope, "automations.updateIfRevision", {
        id: first.id,
        expectedRevision: first.revision,
        prompt: "old page",
      }),
    ).toEqual({ ok: false, conflict: true });
    expect(
      await host.call(scope, "automations.deleteIfRevision", {
        id: first.id,
        expectedRevision: first.revision,
      }),
    ).toEqual({ ok: false, conflict: true });
    const current = ((await host.call(scope, "automations.list")) as any).automations[0];
    expect(current.prompt).toBe("native edit");
    s.get(first.id)!.runCount++;
    const updated = (await host.call(scope, "automations.updateIfRevision", {
      id: first.id,
      expectedRevision: current.revision,
      prompt: "reviewed edit",
    })) as any;
    expect(updated.ok).toBe(true);
    expect(updated.automation.prompt).toBe("reviewed edit");
    expect(updated.automation.runCount).toBe(1);
    await expect(
      host.call({ ...scope, sessionId: "session-b" }, "automations.deleteIfRevision", {
        id: first.id,
        expectedRevision: updated.automation.revision,
      }),
    ).rejects.toThrow(/not available/);
    expect(
      await host.call(scope, "automations.deleteIfRevision", {
        id: first.id,
        expectedRevision: updated.automation.revision,
      }),
    ).toEqual({ ok: true });
  } finally {
    s.stopAll();
  }
});
