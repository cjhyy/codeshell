import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  NOW,
  SID,
  cleanupNoticeEnv,
  env,
  harness,
  resetNoticeEnv,
  type Harness,
} from "./test-utils/notice-wiring-harness.js";

let current: Harness | undefined;

beforeEach(resetNoticeEnv);

afterEach(async () => {
  await cleanupNoticeEnv(current);
  current = undefined;
});

describe("viewed Sessions", () => {
  test("setActiveSession records what the owner looked at", async () => {
    current = harness();
    const probe = (
      current.wiring.router as unknown as {
        options: { wasSessionViewedSince(id: string, ms: number): boolean };
      }
    ).options;
    expect(probe.wasSessionViewedSince(SID, NOW - 1)).toBe(false);
    current.wiring.attention.setActiveSession(SID);
    env.clock = NOW + 5_000;
    current.wiring.attention.setActiveSession(null);
    expect(probe.wasSessionViewedSince(SID, NOW + 4_000)).toBe(true);
    expect(probe.wasSessionViewedSince(SID, NOW + 6_000)).toBe(false);
  });
});
