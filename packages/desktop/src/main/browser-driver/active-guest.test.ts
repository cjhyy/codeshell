import { describe, expect, test, beforeEach } from "bun:test";
import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import {
  _resetGuests,
  activeGuestForBucket,
  focusGuestForBucket,
  listGuestsForBucket,
  registerGuest,
  registerSessionBucket,
  activeGuestForSession,
  rememberAttachedGuest,
  partitionForSession,
  registerAttachedGuestMetadata,
} from "./active-guest.js";

class FakeGuest extends EventEmitter {
  destroyed = false;
  focused = 0;
  constructor(
    readonly id: number,
    private readonly url: string,
    private readonly title: string,
  ) {
    super();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  focus(): void {
    this.focused += 1;
    this.emit("focus");
  }
  destroy(): void {
    this.destroyed = true;
    this.emit("destroyed");
  }
}

function guest(id: number, url: string, title: string): WebContents {
  return new FakeGuest(id, url, title) as unknown as WebContents;
}

describe("bucket-aware browser guest registry", () => {
  beforeEach(() => _resetGuests());

  test("tracks active guest independently per bucket and per session", () => {
    const a = guest(1, "https://a.example/", "A");
    const b = guest(2, "https://b.example/", "B");
    registerSessionBucket("session-a", "repo::session-a", "persist:browser:repo::session-a");
    registerSessionBucket("session-b", "repo::session-b", "persist:browser:repo::session-b");
    registerGuest({
      guest: a,
      bucket: "repo::session-a",
      partition: "persist:browser:repo::session-a",
      engineSessionId: "session-a",
      source: "panel",
    });
    registerGuest({
      guest: b,
      bucket: "repo::session-b",
      partition: "persist:browser:repo::session-b",
      engineSessionId: "session-b",
      source: "panel",
    });

    b.emit("focus");

    expect(activeGuestForBucket("repo::session-a")?.guest).toBe(a);
    expect(activeGuestForBucket("repo::session-b")?.guest).toBe(b);
    expect(activeGuestForSession("session-a")?.guest).toBe(a);
    expect(partitionForSession("session-a")).toBe("persist:browser:repo::session-a");
  });

  test("tab listing and focusing are constrained to the requested bucket", () => {
    const a = guest(11, "https://a.example/", "A");
    const b = guest(22, "https://b.example/", "B");
    registerGuest({
      guest: a,
      bucket: "bucket-a",
      partition: "persist:browser:bucket-a",
      source: "panel",
    });
    registerGuest({
      guest: b,
      bucket: "bucket-b",
      partition: "persist:browser:bucket-b",
      source: "panel",
    });

    expect(listGuestsForBucket("bucket-a")).toEqual([
      { tabId: "11", url: "https://a.example/", title: "A", active: true },
    ]);
    expect(focusGuestForBucket("bucket-a", "22")).toBe(false);
    expect(activeGuestForBucket("bucket-a")?.guest).toBe(a);
    expect(focusGuestForBucket("bucket-b", "22")).toBe(true);
    expect((b as unknown as FakeGuest).focused).toBe(1);
  });

  test("destroying a guest only clears that bucket's active pointer", () => {
    const a = guest(31, "https://a.example/", "A");
    const b = guest(32, "https://b.example/", "B");
    registerGuest({
      guest: a,
      bucket: "bucket-a",
      partition: "persist:browser:bucket-a",
      source: "panel",
    });
    registerGuest({
      guest: b,
      bucket: "bucket-b",
      partition: "persist:browser:bucket-b",
      source: "panel",
    });

    (a as unknown as FakeGuest).destroy();

    expect(activeGuestForBucket("bucket-a")).toBeNull();
    expect(activeGuestForBucket("bucket-b")?.guest).toBe(b);
  });

  test("rejects a renderer guest registration with a mismatched partition", () => {
    const a = guest(41, "https://a.example/", "A");
    expect(() =>
      registerGuest({
        guest: a,
        bucket: "bucket-a",
        partition: "persist:browser:other",
        source: "panel",
      }),
    ).toThrow(/partition/i);
    expect(activeGuestForBucket("bucket-a")).toBeNull();
  });

  test("registers renderer metadata only after an authoritative attach from the same window", () => {
    const a = guest(51, "https://a.example/", "A");
    rememberAttachedGuest({
      guest: a,
      windowId: 7,
      partition: "persist:browser:bucket-a",
    });
    registerAttachedGuestMetadata({
      guestId: 51,
      windowId: 7,
      bucket: "bucket-a",
      partition: "persist:browser:bucket-a",
      source: "panel",
    });

    expect(activeGuestForBucket("bucket-a")?.guest).toBe(a);
  });

  test("rejects renderer-forged guest ids, owner windows, partitions, and session rebinds", () => {
    const a = guest(61, "https://a.example/", "A");
    expect(() =>
      registerAttachedGuestMetadata({
        guestId: 999,
        windowId: 1,
        bucket: "bucket-a",
        partition: "persist:browser:bucket-a",
      }),
    ).toThrow(/not attached|different window/);

    rememberAttachedGuest({
      guest: a,
      windowId: 1,
      partition: "persist:browser:bucket-a",
    });
    expect(() =>
      registerAttachedGuestMetadata({
        guestId: 61,
        windowId: 2,
        bucket: "bucket-a",
        partition: "persist:browser:bucket-a",
      }),
    ).toThrow(/different window/);
    expect(() =>
      registerAttachedGuestMetadata({
        guestId: 61,
        windowId: 1,
        bucket: "bucket-a",
        partition: "persist:browser:other",
      }),
    ).toThrow(/partition/i);

    registerSessionBucket("session-a", "bucket-a", "persist:browser:bucket-a");
    const b = guest(62, "https://b.example/", "B");
    rememberAttachedGuest({
      guest: b,
      windowId: 1,
      partition: "persist:browser:bucket-b",
    });
    expect(() =>
      registerAttachedGuestMetadata({
        guestId: 62,
        windowId: 1,
        bucket: "bucket-b",
        partition: "persist:browser:bucket-b",
        engineSessionId: "session-a",
      }),
    ).toThrow(/session bucket mismatch/);
    expect(activeGuestForBucket("bucket-a")).toBeNull();
    expect(activeGuestForBucket("bucket-b")).toBeNull();
  });
});
