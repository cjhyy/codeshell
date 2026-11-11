import { describe, expect, test } from "bun:test";
import {
  parsePetNotificationSettings,
  petNotificationSettingsView,
} from "./pet-notice-settings.js";

describe("parsePetNotificationSettings", () => {
  test("defaults until the settings schema exists", () => {
    expect(parsePetNotificationSettings({})).toEqual({
      quietHours: { start: "23:00", end: "08:30" },
      maxPerHour: 6,
      maxP0PerHour: 12,
      mergeWindowSec: 600,
      presenceIdleSec: 120,
      delegatedFromDesktop: "auto",
      briefs: {
        morning: { enabled: false, time: "09:00" },
        evening: { enabled: false, time: "18:30" },
      },
      heartbeat: { enabled: false, activeHours: { start: "09:00", end: "22:00" } },
      digestSlots: [],
    });
  });

  test("reads bounded values and falls back on malformed ones", () => {
    const parsed = parsePetNotificationSettings({
      pet: {
        notifications: {
          quietHours: { start: "21:00", end: "07:00", enabled: false },
          maxPerHour: 3,
          maxP0PerHour: -1,
          mergeWindowSec: "10",
          presenceIdleSec: 300,
          delegatedFromDesktop: "desktop",
        },
      },
    });
    expect(parsed).toEqual({
      // Switched off with enabled:false (a null is the settings writer's "delete").
      quietHours: null,
      maxPerHour: 3,
      maxP0PerHour: 12,
      mergeWindowSec: 600,
      presenceIdleSec: 300,
      delegatedFromDesktop: "desktop",
      briefs: {
        morning: { enabled: false, time: "09:00" },
        evening: { enabled: false, time: "18:30" },
      },
      heartbeat: { enabled: false, activeHours: { start: "09:00", end: "22:00" } },
      digestSlots: [],
    });
  });

  test("uses the settings schema's bounds", () => {
    const parsed = parsePetNotificationSettings({
      pet: {
        notifications: {
          quietHours: { start: "22:00", end: "25:00" },
          maxPerHour: 61,
          maxP0PerHour: 120,
          mergeWindowSec: 3_600,
          presenceIdleSec: 10,
        },
      },
    });
    expect(parsed).toMatchObject({
      quietHours: { start: "23:00", end: "08:30" },
      maxPerHour: 6,
      maxP0PerHour: 120,
      mergeWindowSec: 3_600,
      presenceIdleSec: 120,
    });
  });

  test("quiet hours switched off keep their times for the form", () => {
    const settings = {
      pet: { notifications: { quietHours: { start: "22:15", end: "07:45", enabled: false } } },
    };
    expect(parsePetNotificationSettings(settings).quietHours).toBeNull();
    expect(petNotificationSettingsView(settings).quietHours).toEqual({
      enabled: false,
      start: "22:15",
      end: "07:45",
    });
    expect(petNotificationSettingsView({}).quietHours).toEqual({
      enabled: true,
      start: "23:00",
      end: "08:30",
    });
    // A null is "reset to default", never "off".
    expect(
      parsePetNotificationSettings({ pet: { notifications: { quietHours: null } } }).quietHours,
    ).toEqual({ start: "23:00", end: "08:30" });
  });

  test("briefs, heartbeat and digest slots: defaults per field, slots sorted and unique", () => {
    const parsed = parsePetNotificationSettings({
      pet: {
        notifications: {
          briefs: { morning: { enabled: true }, evening: { time: "19:05", enabled: true } },
          heartbeat: { enabled: true, activeHours: { start: "10:00", end: "26:00" } },
          digestSlots: ["18:00", "12:00", "18:00"],
        },
      },
    });
    expect(parsed.briefs).toEqual({
      morning: { enabled: true, time: "09:00" },
      evening: { enabled: true, time: "19:05" },
    });
    // A malformed active-hours window falls back to the default window, not "off".
    expect(parsed.heartbeat).toEqual({
      enabled: true,
      activeHours: { start: "09:00", end: "22:00" },
    });
    expect(parsed.digestSlots).toEqual(["12:00", "18:00"]);
    expect(petNotificationSettingsView({}).digestSlots).toEqual([]);
    // A null is the writer's "delete": back to the defaults.
    expect(
      parsePetNotificationSettings({ pet: { notifications: { briefs: null, digestSlots: null } } })
        .briefs.morning,
    ).toEqual({ enabled: false, time: "09:00" });
  });
});
