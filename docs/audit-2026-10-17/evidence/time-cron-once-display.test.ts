import { afterEach, expect, spyOn, test } from "bun:test";
import { nextCronTime, parseCronExpression } from "../../../packages/core/src/automation/cron-expr.ts";
import { cronScheduler } from "../../../packages/core/src/automation/scheduler.ts";
import { cronCreateTool } from "../../../packages/core/src/tool-system/builtin/cron.ts";

let clock: { mockRestore(): void } | undefined;
afterEach(() => {
  clock?.mockRestore();
  for (const job of cronScheduler.list()) cronScheduler.delete(job.id);
  cronScheduler.stopAll();
});

test("one-shot confirmation appends the job timezone directly to the Host-local clock time", async () => {
  const now = Date.UTC(2026, 9, 17);
  clock = spyOn(Date, "now").mockReturnValue(now);
  cronScheduler.setExecutionEnabled(false);
  let timezone = "UTC";
  let next = nextCronTime(parseCronExpression("0 9 * * *"), timezone, now)!;
  if (new Date(next).toLocaleString() === new Date(next).toLocaleString(undefined, { timeZone: timezone })) {
    timezone = "Asia/Tokyo";
    next = nextCronTime(parseCronExpression("0 9 * * *"), timezone, now)!;
  }
  const hostText = new Date(next).toLocaleString();
  const expectedTime = new Date(next).toLocaleString(undefined, { timeZone: timezone });
  const output = await cronCreateTool({ name: "once date", schedule: "0 9 * * *", prompt: "once only", once: true, timezone });
  console.log(JSON.stringify({ observation: "once-wrong-zone-confirmation", hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, jobTimezone: timezone, next: new Date(next).toISOString(), expectedTime, actualHostText: hostText, actualOutput: output }));
  expect(hostText).not.toBe(expectedTime);
  expect(output).toContain(`将于 ${hostText} (${timezone}) 执行一次`);
  expect(output).not.toContain(`将于 ${expectedTime} (${timezone})`);
});
