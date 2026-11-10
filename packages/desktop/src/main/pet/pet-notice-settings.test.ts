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
});
