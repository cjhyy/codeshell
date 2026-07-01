import { describe, test, expect } from "bun:test";
import { allTimezones, offsetLabel, offsetBucket, uniqueOffsetBuckets, bucketLabel, systemTimezone } from "./timezones";

describe("timezones", () => {
  test("allTimezones comes from the engine and includes UTC + Shanghai", () => {
    const zones = allTimezones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain("Asia/Shanghai");
  });
  test("offsetLabel formats as UTC±H", () => {
    expect(offsetLabel("Asia/Shanghai")).toBe("UTC+8");
  });
  test("offsetBucket is minutes east of UTC", () => {
    expect(offsetBucket("Asia/Shanghai")).toBe(480);
  });
  test("uniqueOffsetBuckets sorted ascending and includes 480", () => {
    const b = uniqueOffsetBuckets();
    expect(b[0]).toBeLessThan(b[b.length - 1]);
    expect(b).toContain(480);
  });
  test("bucketLabel formats a raw bucket", () => {
    expect(bucketLabel(480)).toBe("UTC+8");
    expect(bucketLabel(-330)).toBe("UTC-5:30");
  });
  test("systemTimezone returns a non-empty IANA-ish string", () => {
    expect(systemTimezone().length).toBeGreaterThan(0);
  });
});
