import { describe, expect, test } from "bun:test";
import type { WebContents } from "electron";
import type { GuestRecord } from "../browser-driver/active-guest.js";
import { BuiltInBrowserHandoffGrants } from "./built-in-handoff.js";

function fakeRecord(overrides: Partial<GuestRecord> = {}): GuestRecord {
  const destroyedListeners: Array<() => void> = [];
  const guest = {
    id: 42,
    getURL: () => "https://signed-in.example.test/inbox",
    getTitle: () => "Inbox",
    isDestroyed: () => false,
    once: (event: string, listener: () => void) => {
      if (event === "destroyed") destroyedListeners.push(listener);
      return guest;
    },
  } as unknown as WebContents;
  return {
    guest,
    guestId: 42,
    bucket: "task-bucket",
    partition: "persist:browser:task-bucket",
    engineSessionId: "session-1",
    windowId: 7,
    attachedAt: 1,
    lastFocusedAt: 1,
    source: "panel",
    ...overrides,
  };
}

describe("BuiltInBrowserHandoffGrants", () => {
  test("requires an owner-window user gesture and the task's own bucket", () => {
    const record = fakeRecord();
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: () => record,
      bucketForSession: () => "task-bucket",
      now: () => 100,
    });

    expect(() =>
      grants.grant({ sessionId: "session-1", guestId: 42, sourceWindowId: 99 }),
    ).toThrow("window that owns");
    expect(() =>
      new BuiltInBrowserHandoffGrants({
        guestRecordForId: () => record,
        bucketForSession: () => "another-bucket",
      }).grant({ sessionId: "session-1", guestId: 42, sourceWindowId: 7 }),
    ).toThrow("does not belong");
  });

  test("pins one exact tab, expires, and never follows active-tab focus", async () => {
    let now = 1_000;
    const record = fakeRecord();
    const grants = new BuiltInBrowserHandoffGrants({
      guestRecordForId: (guestId) => (guestId === 42 ? record : null),
      bucketForSession: () => "task-bucket",
      now: () => now,
    });
    const granted = grants.grant({
      sessionId: "session-1",
      guestId: 42,
      sourceWindowId: 7,
      ttlMs: 5_000,
    });
    expect(granted).toMatchObject({
      granted: true,
      guestId: 42,
      url: "https://signed-in.example.test/inbox",
      expiresAt: 6_000,
    });

    const tabs = JSON.parse(
      (await grants.dispatch("session-1", { action: "listTabs" })) ?? "null",
    );
    expect(tabs).toEqual([
      {
        tabId: "42",
        url: "https://signed-in.example.test/inbox",
        title: "Inbox",
        active: true,
      },
    ]);

    now = 6_000;
    expect(grants.status("session-1")).toEqual({ granted: false, sessionId: "session-1" });
    expect(await grants.dispatch("session-1", { action: "listTabs" })).toBeUndefined();
  });
});
