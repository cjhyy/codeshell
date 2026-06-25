import { describe, expect, test } from "bun:test";
import { parseSchedule } from "./scheduler.js";

describe("parseSchedule", () => {
  test("parses unit suffixes to milliseconds", () => {
    expect(parseSchedule("30s")).toBe(30_000);
    expect(parseSchedule("5m")).toBe(5 * 60_000);
    expect(parseSchedule("1h")).toBe(60 * 60_000);
    expect(parseSchedule("1d")).toBe(24 * 60 * 60_000);
  });

  test("parses raw positive milliseconds", () => {
    expect(parseSchedule("1500")).toBe(1500);
  });

  // Footgun guard: a zero interval ("0s"/"0m"/"0") would yield 0ms, and
  // setInterval(fn, 0) spins continuously (hammers the job, CPU burn). The
  // raw-ms path already required > 0; the unit path did NOT — "0s" slipped
  // through to 0. parseSchedule must reject all zero intervals, consistent
  // with its "throw on bad input rather than silently mis-schedule" contract.
  test("rejects zero intervals (no 0ms → no setInterval spin)", () => {
    expect(() => parseSchedule("0s")).toThrow();
    expect(() => parseSchedule("0m")).toThrow();
    expect(() => parseSchedule("0h")).toThrow();
    expect(() => parseSchedule("0d")).toThrow();
    expect(() => parseSchedule("0")).toThrow();
  });

  test("throws on malformed schedules (typo surfaces, not silent default)", () => {
    expect(() => parseSchedule("5mn")).toThrow();
    expect(() => parseSchedule("abc")).toThrow();
    expect(() => parseSchedule("1500abc")).toThrow();
    expect(() => parseSchedule("")).toThrow();
  });
});
