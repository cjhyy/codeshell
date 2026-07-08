import { describe, expect, test } from "bun:test";
import { shouldDrainBackgroundNotifications } from "./App.js";

describe("background notification drain guard", () => {
  test("does not drain when the synchronous query guard is already busy", () => {
    expect(
      shouldDrainBackgroundNotifications({
        notificationCount: 1,
        isQueryActive: false,
        queryGuardBusy: true,
        input: "",
        overlayOpen: false,
        sessionId: "sid",
      }),
    ).toBe(false);
  });

  test("drains when there are notifications and the turn slot is truly idle", () => {
    expect(
      shouldDrainBackgroundNotifications({
        notificationCount: 1,
        isQueryActive: false,
        queryGuardBusy: false,
        input: "",
        overlayOpen: false,
        sessionId: "sid",
      }),
    ).toBe(true);
  });
});
