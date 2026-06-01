import { describe, it, expect } from "bun:test";
import { parseSchedule, buildSchedule, describeSchedule } from "./scheduleModel";

describe("parseSchedule", () => {
  it("parses a daily cron into {kind: daily, time}", () => {
    expect(parseSchedule("0 9 * * *")).toEqual({ kind: "daily", time: "09:00" });
  });

  it("parses weekdays (1-5) into {kind: weekdays, time}", () => {
    expect(parseSchedule("30 8 * * 1-5")).toEqual({ kind: "weekdays", time: "08:30" });
  });

  it("parses a single weekday into {kind: weekly, weekday, time}", () => {
    // Monday 09:00
    expect(parseSchedule("0 9 * * 1")).toEqual({ kind: "weekly", weekday: 1, time: "09:00" });
    // Sunday 18:15
    expect(parseSchedule("15 18 * * 0")).toEqual({ kind: "weekly", weekday: 0, time: "18:15" });
  });

  it("parses an hourly-step cron into {kind: hourly, everyHours}", () => {
    expect(parseSchedule("0 */6 * * *")).toEqual({ kind: "hourly", everyHours: 6 });
    expect(parseSchedule("0 * * * *")).toEqual({ kind: "hourly", everyHours: 1 });
  });

  it("parses an interval string into {kind: hourly, everyHours}", () => {
    expect(parseSchedule("1h")).toEqual({ kind: "hourly", everyHours: 1 });
    expect(parseSchedule("6h")).toEqual({ kind: "hourly", everyHours: 6 });
  });

  it("falls back to {kind: custom, raw} for anything it can't model", () => {
    expect(parseSchedule("1d")).toEqual({ kind: "custom", raw: "1d" });
    expect(parseSchedule("0 9 1 * *")).toEqual({ kind: "custom", raw: "0 9 1 * *" });
    expect(parseSchedule("*/15 9 * * 1-5")).toEqual({ kind: "custom", raw: "*/15 9 * * 1-5" });
    expect(parseSchedule("garbage")).toEqual({ kind: "custom", raw: "garbage" });
  });
});

describe("buildSchedule", () => {
  it("builds a daily cron", () => {
    expect(buildSchedule({ kind: "daily", time: "09:00" })).toBe("0 9 * * *");
  });

  it("builds a weekdays cron", () => {
    expect(buildSchedule({ kind: "weekdays", time: "08:30" })).toBe("30 8 * * 1-5");
  });

  it("builds a weekly cron", () => {
    expect(buildSchedule({ kind: "weekly", weekday: 1, time: "09:00" })).toBe("0 9 * * 1");
    expect(buildSchedule({ kind: "weekly", weekday: 0, time: "18:15" })).toBe("15 18 * * 0");
  });

  it("builds an hourly-step cron", () => {
    expect(buildSchedule({ kind: "hourly", everyHours: 6 })).toBe("0 */6 * * *");
    expect(buildSchedule({ kind: "hourly", everyHours: 1 })).toBe("0 * * * *");
  });

  it("passes custom raw through unchanged", () => {
    expect(buildSchedule({ kind: "custom", raw: "*/15 9 * * 1-5" })).toBe("*/15 9 * * 1-5");
  });

  it("round-trips every modelled kind", () => {
    for (const cron of ["0 9 * * *", "30 8 * * 1-5", "0 9 * * 1", "0 */6 * * *"]) {
      expect(buildSchedule(parseSchedule(cron) as never)).toBe(cron);
    }
  });
});

describe("describeSchedule", () => {
  it("humanizes the modelled kinds in Chinese", () => {
    expect(describeSchedule("0 9 * * *")).toBe("每天 09:00");
    expect(describeSchedule("30 8 * * 1-5")).toBe("工作日 08:30");
    expect(describeSchedule("0 9 * * 1")).toBe("每周一 09:00");
    expect(describeSchedule("15 18 * * 0")).toBe("每周日 18:15");
    expect(describeSchedule("0 */6 * * *")).toBe("每 6 小时");
    expect(describeSchedule("0 * * * *")).toBe("每小时");
  });

  it("shows the raw string for custom schedules", () => {
    expect(describeSchedule("*/15 9 * * 1-5")).toBe("*/15 9 * * 1-5");
    expect(describeSchedule("1d")).toBe("1d");
  });
});
