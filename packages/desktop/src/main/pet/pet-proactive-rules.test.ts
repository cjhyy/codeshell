import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePetNotificationSettings } from "./pet-notice-settings.js";
import {
  dailyCron,
  heartbeatCron,
  inClockWindow,
  syncSystemSchedules,
  systemScheduleInputs,
} from "./pet-proactive-rules.js";
import { PetRuleStore } from "./pet-rule-store.js";

const NOW = Date.UTC(2023, 10, 14, 22, 13);
let dir: string;
let clock = NOW;

beforeEach(async () => {
  clock = NOW;
  dir = await mkdtemp(join(tmpdir(), "pet-proactive-rules-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function settings(notifications: Record<string, unknown> = {}) {
  return parsePetNotificationSettings({ pet: { notifications } });
}

describe("system rule timing", () => {
  test("daily briefs and a half-hourly heartbeat over the active hours", () => {
    expect(dailyCron("09:00")).toBe("0 9 * * *");
    expect(dailyCron("18:30")).toBe("30 18 * * *");
    expect(heartbeatCron({ start: "09:00", end: "22:00" })).toBe("0,30 9-21 * * *");
    expect(heartbeatCron({ start: "09:15", end: "21:45" })).toBe("15,45 9-21 * * *");
    expect(heartbeatCron({ start: "22:00", end: "02:00" })).toBe("0,30 0-1,22-23 * * *");
  });

  test("windows are half-open and may cross midnight", () => {
    const window = { start: "22:00", end: "02:00" };
    expect(inClockWindow(window, Date.UTC(2023, 10, 14, 23, 0), 0)).toBe(true);
    expect(inClockWindow(window, Date.UTC(2023, 10, 14, 2, 0), 0)).toBe(false);
    expect(inClockWindow({ start: "09:00", end: "22:00" }, Date.UTC(2023, 10, 14, 1, 0), 480)).toBe(
      true,
    );
  });

  test("defaults: everything off, 09:00 / 18:30, heartbeat 09:00–22:00", () => {
    const inputs = Object.fromEntries(systemScheduleInputs(settings(), "Asia/Shanghai"));
    expect(inputs["system-brief-morning"]).toMatchObject({
      state: "paused",
      when: { cron: "0 9 * * *", timezone: "Asia/Shanghai", missedPolicy: "fire-once" },
    });
    expect(inputs["system-brief-evening"]?.when.cron).toBe("30 18 * * *");
    expect(inputs["system-heartbeat"]).toMatchObject({
      state: "paused",
      when: { cron: "0,30 9-21 * * *", missedPolicy: "skip" },
    });
  });
});

describe("syncSystemSchedules", () => {
  test("enable, retime and disable follow the settings; off rules are never created", async () => {
    const store = new PetRuleStore({ path: join(dir, "rules.json"), now: () => clock });
    await store.load();
    const log: string[] = [];
    await syncSystemSchedules(store, settings(), "UTC", (event) => log.push(event));
    expect(store.list()).toEqual([]);

    await syncSystemSchedules(
      store,
      settings({ briefs: { morning: { enabled: true } }, heartbeat: { enabled: true } }),
      "UTC",
      (event) => log.push(event),
    );
    expect(store.get("system-brief-morning")?.state).toBe("active");
    expect(store.get("system-brief-evening")).toBeUndefined();
    expect(store.get("system-heartbeat")?.state).toBe("active");

    await syncSystemSchedules(
      store,
      settings({ briefs: { morning: { enabled: true, time: "08:15" } } }),
      "UTC",
      (event) => log.push(event),
    );
    const morning = store.get("system-brief-morning");
    expect(morning?.when).toMatchObject({ cron: "15 8 * * *" });
    expect(morning?.version).toBe(2);
    expect(store.get("system-heartbeat")?.state).toBe("paused");
    expect(log).toEqual([]);
  });

  test("switching the heartbeat off pauses a pending recheck", async () => {
    const store = new PetRuleStore({ path: join(dir, "rules.json"), now: () => clock });
    await store.load();
    await store.setSystemSchedule("system-heartbeat-recheck", {
      when: { kind: "schedule", at: NOW + 600_000, timezone: "UTC", missedPolicy: "skip" },
      state: "active",
    });
    await syncSystemSchedules(store, settings(), "UTC", () => undefined);
    expect(store.get("system-heartbeat-recheck")?.state).toBe("paused");
  });
});
