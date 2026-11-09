import { describe, expect, test } from "bun:test";
import { createPresenceDetector } from "./pet-presence";

describe("createPresenceDetector", () => {
  test("present only while recently active with a focused CodeShell window", () => {
    let idle = 0;
    let focused = true;
    const presence = createPresenceDetector({
      getSystemIdleTimeSec: () => idle,
      hasFocusedWindow: () => focused,
    });
    expect(presence.isPresent()).toBe(true);
    idle = 119;
    expect(presence.isPresent()).toBe(true);
    idle = 120;
    expect(presence.isPresent()).toBe(false);
    idle = 5;
    focused = false;
    expect(presence.isPresent()).toBe(false);
  });

  test("honours a custom threshold and treats probe failures as away", () => {
    const custom = createPresenceDetector({
      getSystemIdleTimeSec: () => 30,
      hasFocusedWindow: () => true,
      idleSec: 30,
    });
    expect(custom.isPresent()).toBe(false);
    const broken = createPresenceDetector({
      getSystemIdleTimeSec: () => {
        throw new Error("no power monitor");
      },
      hasFocusedWindow: () => true,
    });
    expect(broken.isPresent()).toBe(false);
    const nan = createPresenceDetector({
      getSystemIdleTimeSec: () => Number.NaN,
      hasFocusedWindow: () => true,
    });
    expect(nan.isPresent()).toBe(false);
  });
});
