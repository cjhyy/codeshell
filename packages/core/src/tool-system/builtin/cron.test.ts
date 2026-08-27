import { describe, test, expect, afterEach } from "bun:test";
import { cronCreateTool, cronCreateToolDef, cronListTool } from "./cron.js";
import { cronScheduler } from "../../automation/scheduler.js";
import { runWithSid } from "../../logging/logger.js";
import type { ToolContext } from "../context.js";

// The tools operate on the shared cronScheduler singleton. Clean up jobs we
// create so tests don't leak timers/state into each other.
const created: string[] = [];
afterEach(() => {
  for (const j of cronScheduler.list()) cronScheduler.delete(j.id);
  created.length = 0;
});

describe("CronCreate tool — conversational config", () => {
  test("description tells the model it accepts a cron expression + timezone", () => {
    const d = cronCreateToolDef.description.toLowerCase();
    expect(d).toContain("cron expression");
    expect(d).toContain("timezone");
  });

  test("schema exposes timezone / cwd / permissionLevel so the model can fill them", () => {
    const props = (cronCreateToolDef.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.timezone).toBeDefined();
    expect(props.cwd).toBeDefined();
    expect(props.permissionLevel).toBeDefined();
  });

  test("creates a calendar job from a cron expression + timezone", async () => {
    const out = await cronCreateTool({
      name: "工作日晨间简报",
      schedule: "0 8 * * 1-5",
      prompt: "检查今天的 git 变更并总结",
      timezone: "Asia/Shanghai",
      cwd: "/tmp/proj",
      permissionLevel: "read-only",
    });
    expect(out).toContain("工作日晨间简报");
    const job = cronScheduler.list().find((j) => j.name === "工作日晨间简报");
    expect(job).toBeDefined();
    expect(job!.schedule).toBe("0 8 * * 1-5");
    expect(job!.timezone).toBe("Asia/Shanghai");
    expect(job!.cwd).toBe("/tmp/proj");
    expect(job!.permissionLevel).toBe("read-only");
  });

  test("still accepts a plain interval schedule (back-compat)", async () => {
    const out = await cronCreateTool({ name: "poll", schedule: "1h", prompt: "check CI" });
    expect(out).toContain("poll");
    const job = cronScheduler.list().find((j) => j.name === "poll");
    expect(job!.schedule).toBe("1h");
  });

  test("binds production calls to the host cwd and rejects model-supplied cwd escapes", async () => {
    const context = { cwd: "/tmp/current-project" } as ToolContext;
    const created = await cronCreateTool(
      { name: "local", schedule: "1h", prompt: "check" },
      context,
    );
    expect(created).toContain("local");
    expect(cronScheduler.list().find((job) => job.name === "local")?.cwd).toBe(
      "/tmp/current-project",
    );

    const escaped = await cronCreateTool(
      { name: "escape", schedule: "1h", prompt: "check", cwd: "/tmp/other-project" },
      context,
    );
    expect(escaped).toMatch(/error.*outside/i);
    expect(cronScheduler.list().find((job) => job.name === "escape")).toBeUndefined();
  });

  test("persists stable project/root ids from the Main-authorized workspace context", async () => {
    const workspace = {
      version: 1,
      projectId: "project-1",
      projectRevision: 7,
      sessionMainRootId: "root-2",
      roots: [
        { id: "root-1", path: "/primary", role: "secondary" },
        { id: "root-2", path: "/secondary", role: "primary" },
      ],
      rootsDigest: "digest",
    } as ToolContext["workspace"];
    await cronCreateTool({ name: "bound", schedule: "1h", prompt: "check" }, {
      cwd: "/secondary",
      workspace,
    } as ToolContext);
    expect(cronScheduler.list().find((job) => job.name === "bound")).toMatchObject({
      cwd: "/secondary",
      projectId: "project-1",
      rootId: "root-2",
    });
  });

  test("rejects non-string and oversized payloads without creating a job", async () => {
    expect(await cronCreateTool({ name: 42, schedule: "1h", prompt: "check" })).toMatch(/error/i);
    expect(
      await cronCreateTool({ name: "huge", schedule: "1h", prompt: "x".repeat(1024 * 1024 + 1) }),
    ).toMatch(/error.*large/i);
    expect(cronScheduler.list()).toEqual([]);
  });

  test("rejects an invalid schedule with an error message (not a throw)", async () => {
    const out = await cronCreateTool({ name: "bad", schedule: "99 9 * * *", prompt: "x" });
    expect(out.toLowerCase()).toContain("error");
    expect(cronScheduler.list().find((j) => j.name === "bad")).toBeUndefined();
  });

  test("CronList shows timezone for calendar jobs", async () => {
    await cronCreateTool({ name: "daily", schedule: "0 9 * * *", prompt: "p", timezone: "UTC" });
    const out = await cronListTool({});
    expect(out).toContain("daily");
  });

  test("once:true 透传到 scheduler 并区分返回文案", async () => {
    const out = await cronCreateTool({ name: "remind", schedule: "10m", prompt: "p", once: true });
    const job = cronScheduler.list().find((j) => j.name === "remind");
    expect(job?.once).toBe(true);
    expect(out).toContain("一次"); // 一次性任务文案
  });

  test("不传 once 时 job.once 不为 true(循环语义)", async () => {
    await cronCreateTool({ name: "loop", schedule: "10m", prompt: "p" });
    const job = cronScheduler.list().find((j) => j.name === "loop");
    expect(job?.once).not.toBe(true);
  });

  test("schema 暴露 once 供模型填写", () => {
    const props = (cronCreateToolDef.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.once).toBeDefined();
  });

  // #8: continueInSession → resumeSessionId. The model never supplies the sid;
  // the tool resolves it from the running Engine's ALS context (getCurrentSid),
  // which we pin here via runWithSid.
  test("continueInSession:true 绑定当前会话 id 到 resumeSessionId", async () => {
    await runWithSid("sess-current-42", async () => {
      const out = await cronCreateTool({
        name: "接着做",
        schedule: "1h",
        prompt: "继续刚才的活",
        continueInSession: true,
      });
      expect(out).toContain("续接当前对话");
    });
    const job = cronScheduler.list().find((j) => j.name === "接着做");
    expect(job?.resumeSessionId).toBe("sess-current-42");
  });

  test("不传 continueInSession 时不绑定 resumeSessionId(独立会话默认)", async () => {
    await runWithSid("sess-current-42", async () => {
      await cronCreateTool({ name: "独立", schedule: "1h", prompt: "daily report" });
    });
    const job = cronScheduler.list().find((j) => j.name === "独立");
    expect(job?.resumeSessionId).toBeUndefined();
  });

  test("continueInSession:false 显式关闭也不绑定", async () => {
    await runWithSid("sess-current-42", async () => {
      await cronCreateTool({
        name: "显式关",
        schedule: "1h",
        prompt: "p",
        continueInSession: false,
      });
    });
    const job = cronScheduler.list().find((j) => j.name === "显式关");
    expect(job?.resumeSessionId).toBeUndefined();
  });

  test("schema 暴露 continueInSession 供模型填写", () => {
    const props = (cronCreateToolDef.inputSchema as { properties: Record<string, unknown> })
      .properties;
    expect(props.continueInSession).toBeDefined();
  });
});
