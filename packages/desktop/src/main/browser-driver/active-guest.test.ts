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
  browserPartitionForBucket,
  forgetSession,
  rememberAttachedGuest,
  partitionForSession,
  registeredPartitionForBucket,
  registerAttachedGuestMetadata,
  sessionIdsForBucket,
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
    registerSessionBucket(
      "session-a",
      "repo::session-a",
      browserPartitionForBucket("repo::session-a"),
    );
    registerSessionBucket(
      "session-b",
      "repo::session-b",
      browserPartitionForBucket("repo::session-b"),
    );
    registerGuest({
      guest: a,
      bucket: "repo::session-a",
      partition: browserPartitionForBucket("repo::session-a"),
      engineSessionId: "session-a",
      source: "panel",
    });
    registerGuest({
      guest: b,
      bucket: "repo::session-b",
      partition: browserPartitionForBucket("repo::session-b"),
      engineSessionId: "session-b",
      source: "panel",
    });

    b.emit("focus");

    expect(activeGuestForBucket("repo::session-a")?.guest).toBe(a);
    expect(activeGuestForBucket("repo::session-b")?.guest).toBe(b);
    expect(activeGuestForSession("session-a")?.guest).toBe(a);
    expect(partitionForSession("session-a")).toBe(browserPartitionForBucket("repo::session-a"));
    expect(sessionIdsForBucket("repo::session-a")).toEqual(["session-a"]);
    expect(sessionIdsForBucket("missing")).toEqual([]);
  });

  test("uses an in-memory partition for Quick Chat and releases its registry mapping", () => {
    const bucket = "__quick_chat__::qchat-owned";
    const partition = browserPartitionForBucket(bucket);
    // Non-persistent: a quick chat's browser state must not outlive the window.
    expect(partition.startsWith("persist:")).toBe(false);
    registerSessionBucket("qchat-owned", bucket, partition);
    expect(partitionForSession("qchat-owned")).toBe(partition);

    forgetSession("qchat-owned");

    expect(partitionForSession("qchat-owned")).toBeNull();
    expect(registeredPartitionForBucket(bucket)).toBeNull();
  });

  test("tab listing and focusing are constrained to the requested bucket", () => {
    const a = guest(11, "https://a.example/", "A");
    const b = guest(22, "https://b.example/", "B");
    registerGuest({
      guest: a,
      bucket: "bucket-a",
      partition: browserPartitionForBucket("bucket-a"),
      source: "panel",
    });
    registerGuest({
      guest: b,
      bucket: "bucket-b",
      partition: browserPartitionForBucket("bucket-b"),
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
      partition: browserPartitionForBucket("bucket-a"),
      source: "panel",
    });
    registerGuest({
      guest: b,
      bucket: "bucket-b",
      partition: browserPartitionForBucket("bucket-b"),
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
      partition: browserPartitionForBucket("bucket-a"),
    });
    registerAttachedGuestMetadata({
      guestId: 51,
      windowId: 7,
      bucket: "bucket-a",
      partition: browserPartitionForBucket("bucket-a"),
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
        partition: browserPartitionForBucket("bucket-a"),
      }),
    ).toThrow(/not attached|different window/);

    rememberAttachedGuest({
      guest: a,
      windowId: 1,
      partition: browserPartitionForBucket("bucket-a"),
    });
    expect(() =>
      registerAttachedGuestMetadata({
        guestId: 61,
        windowId: 2,
        bucket: "bucket-a",
        partition: browserPartitionForBucket("bucket-a"),
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

    registerSessionBucket("session-a", "bucket-a", browserPartitionForBucket("bucket-a"));
    const b = guest(62, "https://b.example/", "B");
    rememberAttachedGuest({
      guest: b,
      windowId: 1,
      partition: browserPartitionForBucket("bucket-b"),
    });
    expect(() =>
      registerAttachedGuestMetadata({
        guestId: 62,
        windowId: 1,
        bucket: "bucket-b",
        partition: browserPartitionForBucket("bucket-b"),
        engineSessionId: "session-a",
      }),
    ).toThrow(/session bucket mismatch/);
    expect(activeGuestForBucket("bucket-a")).toBeNull();
    expect(activeGuestForBucket("bucket-b")).toBeNull();
  });
});

describe("session ↔ bucket mapping (renderer authorization seam)", () => {
  test("lists every session sharing a bucket, and nothing for an unknown one", () => {
    // sessionIdsForBucket authorizes renderer browser operations, so both the
    // positive and the empty answer are security-relevant.
    registerSessionBucket("s-1", "proj::b1");
    registerSessionBucket("s-2", "proj::b1");
    registerSessionBucket("s-3", "proj::b2");
    expect(sessionIdsForBucket("proj::b1").sort()).toEqual(["s-1", "s-2"]);
    expect(sessionIdsForBucket("proj::b2")).toEqual(["s-3"]);
    expect(sessionIdsForBucket("proj::never")).toEqual([]);
    expect(sessionIdsForBucket(undefined)).toEqual([]);
    forgetSession("s-1");
    forgetSession("s-2");
    forgetSession("s-3");
  });

  test("rebinding a session moves it out of its old bucket", () => {
    registerSessionBucket("s-move", "proj::from");
    registerSessionBucket("s-move", "proj::to");
    expect(sessionIdsForBucket("proj::from")).toEqual([]);
    expect(sessionIdsForBucket("proj::to")).toEqual(["s-move"]);
    forgetSession("s-move");
  });

  test("forgetting one session keeps the bucket's other members addressable", () => {
    registerSessionBucket("s-a", "proj::shared");
    registerSessionBucket("s-b", "proj::shared");
    forgetSession("s-a");
    expect(sessionIdsForBucket("proj::shared")).toEqual(["s-b"]);
    expect(partitionForSession("s-b")).toBe(browserPartitionForBucket("proj::shared"));
    forgetSession("s-b");
  });

  test("the partition mapping survives until the last session leaves", () => {
    // forgetSession drops the partition only when nothing references the
    // bucket any more; dropping it early would strand a live guest.
    registerSessionBucket("s-x", "proj::last");
    registerSessionBucket("s-y", "proj::last");
    forgetSession("s-x");
    expect(partitionForSession("s-y")).toBe(browserPartitionForBucket("proj::last"));
    forgetSession("s-y");
  });

  test("forgetting an unknown session is a no-op", () => {
    expect(() => forgetSession("never-registered")).not.toThrow();
  });
});
