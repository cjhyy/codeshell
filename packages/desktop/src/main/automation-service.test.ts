import { describe, test, expect, beforeEach } from "bun:test";
import { CronScheduler } from "@cjhyy/code-shell-core/internal";
import {
  reloadAutomations,
  setAutomationScheduler,
  listAutomations,
  getAutomation,
  createAutomation as createAuthorizedAutomation,
  updateAutomation as updateAuthorizedAutomation,
  listAutomationsForResumeSession,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
} from "./automation-service.js";

let sched: CronScheduler;

const authorityDeps = {
  requireRendererPath: async (cwd: string) => cwd,
  isNoRepoCwd: (cwd: string) => cwd === "/no-repo",
  resolveProjectRootById: (projectId: string, rootId?: string) => ({
    projectId,
    rootId: rootId ?? "root-primary",
    cwd: rootId === "root-2" || rootId === "root-secondary" ? "/secondary" : "/primary",
  }),
  resolveExactRoot: (cwd: string) =>
    cwd === "/primary" ? { projectId: "project-1", rootId: "root-primary", cwd } : undefined,
  resolveSessionAuthority: async (sessionId: string) =>
    sessionId === "session-job-hunt"
      ? {
          sessionId,
          cwd: "/primary",
          projectId: "project-1",
          rootId: "root-primary",
        }
      : undefined,
};

const createAutomation = (input: Parameters<typeof createAuthorizedAutomation>[0]) =>
  createAuthorizedAutomation(input, authorityDeps);
const updateAutomation = (id: string, patch: Parameters<typeof updateAuthorizedAutomation>[1]) =>
  updateAuthorizedAutomation(id, patch, authorityDeps);

beforeEach(() => {
  sched = new CronScheduler();
  setAutomationScheduler(sched);
});

describe("automation-service", () => {
  test("listAutomations returns [] when no scheduler is set", () => {
    setAutomationScheduler(null);
    expect(listAutomations()).toEqual([]);
  });

  test("create then list returns a serializable summary", async () => {
    const created = await createAutomation({
      name: "nightly",
      schedule: "0 9 * * 1-5",
      prompt: "review",
      cwd: "/secondary",
      projectId: "project-1",
      rootId: "root-2",
      timezone: "Asia/Shanghai",
      permissionLevel: "read-only",
    });
    expect(created.name).toBe("nightly");
    expect(created.cwd).toBe("/secondary");
    expect(created.projectId).toBe("project-1");
    expect(created.rootId).toBe("root-2");
    expect(created.permissionLevel).toBe("read-only");
    expect(created.templateSource).toBeNull();
    expect(typeof created.nextRun).toBe("number");

    const list = listAutomations();
    expect(list).toHaveLength(1);
    // Summary is a plain object (no class instance crosses IPC).
    expect(Object.getPrototypeOf(list[0])).toBe(Object.prototype);
    sched.stopAll();
  });

  test("pause/resume flips enabled in the summary", async () => {
    const job = await createAutomation({ name: "x", schedule: "1h", prompt: "p" });
    expect(pauseAutomation(job.id)).toBe(true);
    expect(getAutomation(job.id)?.enabled).toBe(false);
    expect(resumeAutomation(job.id)).toBe(true);
    expect(getAutomation(job.id)?.enabled).toBe(true);
    sched.stopAll();
  });

  test("update changes prompt + schedule and returns the new summary", async () => {
    const job = await createAutomation({ name: "j", schedule: "1h", prompt: "old" });
    const updated = await updateAutomation(job.id, {
      prompt: "new",
      schedule: "0 9 * * 1-5",
      timezone: "UTC",
    });
    expect(updated?.prompt).toBe("new");
    expect(updated?.schedule).toBe("0 9 * * 1-5");
    expect(updated?.timezone).toBe("UTC");
    expect(getAutomation(job.id)?.prompt).toBe("new");
    sched.stopAll();
  });

  test("update can atomically rebind or clear stable workspace ids", async () => {
    const job = await createAutomation({
      name: "j",
      schedule: "1h",
      prompt: "old",
      cwd: "/primary",
      projectId: "project-1",
      rootId: "root-1",
    });
    expect(
      await updateAutomation(job.id, {
        cwd: "/secondary",
        projectId: "project-1",
        rootId: "root-2",
      }),
    ).toMatchObject({ cwd: "/secondary", projectId: "project-1", rootId: "root-2" });
    expect(
      await updateAutomation(job.id, { cwd: "", projectId: null, rootId: null }),
    ).toMatchObject({
      cwd: "",
      projectId: null,
      rootId: null,
    });
    sched.stopAll();
  });

  test("update rejects an invalid schedule (throws, job unchanged)", async () => {
    const job = await createAutomation({ name: "j", schedule: "1h", prompt: "p" });
    await expect(updateAutomation(job.id, { schedule: "99 9 * * *" })).rejects.toThrow();
    expect(getAutomation(job.id)?.schedule).toBe("1h");
    sched.stopAll();
  });

  test("update returns null for unknown id", async () => {
    expect(await updateAutomation("nope", { prompt: "x" })).toBeNull();
  });

  test("delete removes the job", async () => {
    const job = await createAutomation({ name: "x", schedule: "1h", prompt: "p" });
    expect(deleteAutomation(job.id)).toBe(true);
    expect(getAutomation(job.id)).toBeNull();
  });

  test("create throws on an invalid cron expression", async () => {
    await expect(
      createAutomation({ name: "bad", schedule: "99 9 * * *", prompt: "p" }),
    ).rejects.toThrow();
  });

  test("summary carries the optional task binding", async () => {
    const standalone = await createAutomation({ name: "n", schedule: "5m", prompt: "p" });
    const bound = await createAutomation({
      name: "bound",
      schedule: "1h",
      prompt: "p",
      resumeSessionId: "session-job-hunt",
    });
    expect(standalone.resumeSessionId).toBeNull();
    expect(bound.resumeSessionId).toBe("session-job-hunt");
    expect(bound).toMatchObject({
      projectId: "project-1",
      rootId: "root-primary",
      cwd: "/primary",
    });
    sched.stopAll();
  });

  test("resume create/update/list stay scoped to durable Session stable ids", async () => {
    await expect(
      createAutomation({
        name: "forged",
        schedule: "1h",
        prompt: "p",
        resumeSessionId: "session-job-hunt",
        projectId: "project-1",
        rootId: "root-secondary",
      }),
    ).rejects.toThrow(/Session.*root/i);
    expect(listAutomations()).toEqual([]);

    const job = await createAutomation({
      name: "bound",
      schedule: "1h",
      prompt: "p",
      resumeSessionId: "session-job-hunt",
    });
    await expect(
      updateAutomation(job.id, {
        projectId: "project-1",
        rootId: "root-secondary",
      }),
    ).rejects.toThrow(/Session.*root/i);
    expect(getAutomation(job.id)).toMatchObject({
      projectId: "project-1",
      rootId: "root-primary",
    });
    await expect(
      listAutomationsForResumeSession("session-job-hunt", authorityDeps),
    ).resolves.toEqual([expect.objectContaining({ id: job.id })]);
    sched.stopAll();
  });
});

test("reloadAutomations calls scheduler.loadJobs", () => {
  let loaded = 0;
  setAutomationScheduler({
    loadJobs: () => {
      loaded++;
    },
  } as unknown as import("@cjhyy/code-shell-core").CronScheduler);
  reloadAutomations();
  expect(loaded).toBe(1);
  setAutomationScheduler(null);
});
