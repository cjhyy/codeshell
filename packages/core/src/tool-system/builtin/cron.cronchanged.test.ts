import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  cronCreateTool,
  cronDeleteTool,
  setCronChangedSink,
  setCronCreateAuthority,
} from "./cron.js";
import { cronScheduler } from "../../automation/scheduler.js";
import { runWithSid } from "../../logging/logger.js";
import type { ToolContext } from "../context.js";

describe("cron tools fire cronChanged sink", () => {
  let fired: string[] = [];
  beforeEach(() => {
    fired = [];
    setCronChangedSink(() => fired.push("changed"));
  });
  afterEach(() => {
    setCronChangedSink(null);
    setCronCreateAuthority(null);
    for (const j of cronScheduler.list()) cronScheduler.delete(j.id);
  });

  test("CronCreate success fires the sink", async () => {
    const out = await cronCreateTool({ name: "t", schedule: "5m", prompt: "p" });
    expect(out).not.toMatch(/^Error/);
    expect(fired).toEqual(["changed"]);
  });

  test("CronDelete success fires the sink", async () => {
    const created = await cronCreateTool({ name: "t", schedule: "5m", prompt: "p" });
    fired = [];
    const id = created.match(/#(\d+)/)?.[1] ?? "";
    await cronDeleteTool({ jobId: id });
    expect(fired).toEqual(["changed"]);
  });

  test("CronCreate failure does NOT fire the sink", async () => {
    await cronCreateTool({ name: "t", schedule: "bogus", prompt: "p" });
    expect(fired).toEqual([]);
  });

  test("Desktop can delegate CronCreate to Main authority without mutating the worker scheduler", async () => {
    const calls: unknown[] = [];
    setCronCreateAuthority(async (input) => {
      calls.push(input);
      return {
        id: "main-1",
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        enabled: true,
        runCount: 0,
        createdAt: 1,
        cwd: "/main-authority",
        projectId: "project-1",
        rootId: "root-1",
        resumeSessionId: "session-1",
      };
    });

    const out = await runWithSid("session-1", () =>
      cronCreateTool(
        {
          name: "delegated",
          schedule: "5m",
          prompt: "p",
          cwd: "/caller",
        },
        {
          cwd: "/caller",
          workspace: {
            projectId: "project-1",
            sessionMainRootId: "root-1",
          },
        } as ToolContext,
      ),
    );

    expect(out).toContain("main-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      authoritySessionId: "session-1",
      projectId: "project-1",
      rootId: "root-1",
    });
    expect(cronScheduler.list()).toEqual([]);
    expect(fired).toEqual(["changed"]);
  });
});
