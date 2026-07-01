import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { cronCreateTool, cronDeleteTool, setCronChangedSink } from "./cron.js";
import { cronScheduler } from "../../automation/scheduler.js";

describe("cron tools fire cronChanged sink", () => {
  let fired: string[] = [];
  beforeEach(() => {
    fired = [];
    setCronChangedSink(() => fired.push("changed"));
  });
  afterEach(() => {
    setCronChangedSink(null);
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
});
