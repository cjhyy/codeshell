import { afterEach, expect, spyOn, test } from "bun:test";
import { isCronExpression, nextCronTime, parseCronExpression } from "../../../packages/core/src/automation/cron-expr.ts";
import { CronScheduler, cronScheduler, validateSchedule } from "../../../packages/core/src/automation/scheduler.ts";
import { cronCreateTool } from "../../../packages/core/src/tool-system/builtin/cron.ts";

const clocks: Array<{ mockRestore(): void }> = [];
afterEach(() => {
  for (const clock of clocks.splice(0)) clock.mockRestore();
  for (const job of cronScheduler.list()) cronScheduler.delete(job.id);
  cronScheduler.stopAll();
});

test("observation: malformed cron separators pass validation and replace a valid definition", () => {
  const now = Date.UTC(2026, 9, 17, 9, 0);
  clocks.push(spyOn(Date, "now").mockReturnValue(now));
  const expressions = ["0-1-59 9 * * *", "*/5/0 9 * * *"];
  const actual = expressions.map((expression) => {
    expect(isCronExpression(expression)).toBe(true);
    expect(() => validateSchedule(expression, "UTC")).not.toThrow();
    const parsed = parseCronExpression(expression);
    return { expression, minutes: [...parsed.minutes], next: new Date(nextCronTime(parsed, "UTC", now)!).toISOString() };
  });
  const scheduler = new CronScheduler();
  scheduler.setExecutionEnabled(false);
  const job = scheduler.create("valid", "0 9 * * *", "original", { timezone: "UTC" });
  const updated = scheduler.update(job.id, { schedule: expressions[0], prompt: "updated" });
  console.log(JSON.stringify({ observation: "malformed-cron-accepted", expected: "reject malformed separators before any update", actual, updatedSchedule: updated?.schedule, updatedPrompt: updated?.prompt }));
  expect(actual[0]?.minutes).toEqual([0, 1]);
  expect(actual[1]?.minutes).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
  expect(updated?.schedule).toBe(expressions[0]);
  expect(updated?.prompt).toBe("updated");
  scheduler.stopAll();
});

test("observation: CronCreate labels Host-local nextRun text with a different job timezone", async () => {
  const now = Date.UTC(2026, 9, 17, 0, 0);
  clocks.push(spyOn(Date, "now").mockReturnValue(now));
  cronScheduler.setExecutionEnabled(false);
  let timezone = "UTC";
  let next = nextCronTime(parseCronExpression("0 9 * * *"), timezone, now)!;
  if (new Date(next).toLocaleString() === new Date(next).toLocaleString(undefined, { timeZone: timezone })) {
    timezone = "Asia/Tokyo";
    next = nextCronTime(parseCronExpression("0 9 * * *"), timezone, now)!;
  }
  const hostText = new Date(next).toLocaleString();
  const jobZoneText = new Date(next).toLocaleString(undefined, { timeZone: timezone });
  const output = await cronCreateTool({ name: "timezone display", schedule: "0 9 * * *", prompt: "show the date", timezone });
  console.log(JSON.stringify({ observation: "cron-create-timezone-label", hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, jobTimezone: timezone, next: new Date(next).toISOString(), hostText, expectedJobZoneText: jobZoneText, actualOutput: output }));
  expect(hostText).not.toBe(jobZoneText);
  expect(output).toContain(`Next run: ${hostText}`);
  expect(output).toContain(`(${timezone})`);
  expect(output).not.toContain(`Next run: ${jobZoneText}`);
});
