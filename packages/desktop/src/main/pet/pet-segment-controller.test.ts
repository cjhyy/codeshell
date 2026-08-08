import { describe, expect, test } from "bun:test";
import type { PetTopicSegment, PetWorkMemoryEntry } from "@cjhyy/code-shell-pet";
import { buildArchiveAnchors, PetSegmentController } from "./pet-segment-controller";
import type { PetSegmentClosed, PetWorkMemoryStoreLike } from "./pet-segment-controller";

const MINUTE = 60 * 1000;
const HOUR = 60 * 60 * 1000;

class FakePetWorkMemoryStore implements PetWorkMemoryStoreLike {
  appended: PetWorkMemoryEntry[] = [];
  opened: PetTopicSegment[] = [];
  private last = 0;

  seed(input: { lastInteractionAt: number; entries: PetWorkMemoryEntry[] }): void {
    this.last = input.lastInteractionAt;
    this.appended = [...input.entries];
  }
  entries(): PetWorkMemoryEntry[] {
    return this.appended;
  }
  activeSegment(): PetTopicSegment | undefined {
    return this.opened.at(-1);
  }
  segmentBoundaries(): { boundaryBeforeMessageId: string; brief?: string }[] {
    return this.opened
      .filter((segment) => typeof segment.boundaryBeforeMessageId === "string")
      .map((segment) => ({
        boundaryBeforeMessageId: segment.boundaryBeforeMessageId!,
        ...(segment.brief ? { brief: segment.brief } : {}),
      }));
  }
  lastInteractionAt(): number {
    return this.last;
  }
  async append(entry: PetWorkMemoryEntry): Promise<void> {
    this.appended.push(entry);
  }
  async openSegment(segment: PetTopicSegment): Promise<void> {
    this.opened.push(segment);
  }
  async setLastInteractionAt(at: number): Promise<void> {
    this.last = at;
  }
}

describe("PetSegmentController", () => {
  test("delegation closure records work memory and archives the segment turns", async () => {
    const archived: Array<{ sessionId: string; range: { start: number; end: number } }> = [];
    const store = new FakePetWorkMemoryStore();
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async (sessionId, range) => {
        archived.push({ sessionId, range });
        return { before: 100, after: 20 };
      },
      now: () => 1_000,
      idleMs: 12 * HOUR,
    });
    await controller.onDelegationClosed({
      objective: "修登录",
      outcome: "completed",
      workspace: "alpha",
      sessionRef: "sess-9",
      turnRange: { start: 2, end: 6 },
    });
    expect(store.appended).toHaveLength(1);
    expect(store.appended[0]).toMatchObject({
      objective: "修登录",
      outcome: "completed",
      workspace: "alpha",
      sessionRef: "sess-9",
      at: 1_000,
    });
    expect(archived).toEqual([{ sessionId: "pet-1", range: { start: 2, end: 6 } }]);
  });

  test("delegation closure without a turnRange records memory but never archives", async () => {
    let archiveCalls = 0;
    const store = new FakePetWorkMemoryStore();
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => {
        archiveCalls += 1;
        return { before: 0, after: 0 };
      },
      now: () => 1_000,
      idleMs: 12 * HOUR,
    });
    await controller.onDelegationClosed({
      objective: "修登录",
      outcome: "completed",
      sessionRef: "sess-9",
    });
    expect(store.appended).toHaveLength(1);
    expect(archiveCalls).toBe(0);
  });

  test("carryover brief is produced when a new segment opens after long idle", async () => {
    const store = new FakePetWorkMemoryStore();
    store.seed({
      // A real prior interaction (not a fresh store) so the idle gap can be crossed.
      lastInteractionAt: 30 * MINUTE,
      entries: [
        { segmentId: "old", objective: "重构 X", outcome: "completed", at: 1, workspace: "alpha" },
      ],
    });
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => ({ before: 0, after: 0 }),
      now: () => 13 * HOUR,
      idleMs: 12 * HOUR,
    });
    const brief = await controller.beginTurn("pet-msg-1");
    expect(brief).toContain("重构 X");
    // A fresh segment must have been opened and the interaction clock advanced.
    expect(store.activeSegment()).toBeDefined();
    expect(store.lastInteractionAt()).toBe(13 * HOUR);
    // The boundary is keyed to the message id of the turn that opened the
    // segment, carrying the same brief that was injected as continuity.
    expect(store.activeSegment()?.boundaryBeforeMessageId).toBe("pet-msg-1");
    expect(store.segmentBoundaries()).toEqual([{ boundaryBeforeMessageId: "pet-msg-1", brief }]);
  });

  test("each long-idle turn opens a distinct message-keyed boundary", async () => {
    const store = new FakePetWorkMemoryStore();
    // Seed a real prior interaction so both turns are genuine idle crossings
    // (not the first-interaction baseline, which never opens a segment).
    store.seed({ lastInteractionAt: 30 * MINUTE, entries: [] });
    let now = 0;
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => ({ before: 0, after: 0 }),
      now: () => now,
      idleMs: 12 * HOUR,
    });
    now = 13 * HOUR;
    await controller.beginTurn("pet-a");
    now = 13 * HOUR + 13 * HOUR;
    await controller.beginTurn("pet-b");
    expect(store.segmentBoundaries()).toEqual([
      { boundaryBeforeMessageId: "pet-a" },
      { boundaryBeforeMessageId: "pet-b" },
    ]);
  });

  test("a fresh store's first chat turn opens no visible segment boundary", async () => {
    const store = new FakePetWorkMemoryStore();
    let now = HOUR; // fresh store → lastInteractionAt === 0
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => ({ before: 0, after: 0 }),
      now: () => now,
      idleMs: 12 * HOUR,
    });
    // First turn: establishes the baseline only — no brief, no boundary, even
    // though the idle gap since epoch nominally exceeds idleMs.
    const first = await controller.beginTurn("pet-first");
    expect(first).toBeUndefined();
    expect(store.segmentBoundaries()).toEqual([]);
    expect(store.lastInteractionAt()).toBe(HOUR);

    // A later turn crossing the 12h idle window opens the first visible segment.
    now = HOUR + 13 * HOUR;
    await controller.beginTurn("pet-second");
    expect(store.segmentBoundaries()).toEqual([{ boundaryBeforeMessageId: "pet-second" }]);
  });

  test("a segment opened without a message id records no UI boundary", async () => {
    const store = new FakePetWorkMemoryStore();
    // Prior interaction present so the idle crossing genuinely opens a segment;
    // it just carries no message id (e.g. an IM-gateway turn without one).
    store.seed({ lastInteractionAt: 30 * MINUTE, entries: [] });
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => ({ before: 0, after: 0 }),
      now: () => 13 * HOUR,
      idleMs: 12 * HOUR,
    });
    await controller.beginTurn();
    expect(store.activeSegment()).toBeDefined();
    expect(store.segmentBoundaries()).toEqual([]);
  });

  test("opening a new segment fires onSegmentClosed for the segment that just closed", async () => {
    const store = new FakePetWorkMemoryStore();
    store.seed({ lastInteractionAt: 30 * MINUTE, entries: [] });
    const closed: PetSegmentClosed[] = [];
    let now = 13 * HOUR;
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => ({ before: 0, after: 0 }),
      onSegmentClosed: (event) => closed.push(event),
      now: () => now,
      idleMs: 12 * HOUR,
    });
    // First idle crossing opens seg A; there is no prior segment to close.
    await controller.beginTurn("pet-a");
    expect(closed).toHaveLength(0);
    // Second idle crossing closes seg A (keyed to pet-a) and opens seg B.
    now = 13 * HOUR + 13 * HOUR;
    await controller.beginTurn("pet-b");
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      closingBoundaryMessageId: "pet-a",
      nextBoundaryMessageId: "pet-b",
      startedAt: 13 * HOUR,
      endedAt: 13 * HOUR + 13 * HOUR,
    });
    expect(closed[0]?.segmentId).toBe(store.opened[0]!.id);
  });

  test("the closed event's anchors, when built, carry exactly the boundary/segment fields for archive_range", () => {
    // Mirrors what packages/desktop/src/main/index.ts's onSegmentClosed does
    // with the event this controller emits: derive the archive-marker anchors
    // and forward them into the archive_range worker query payload.
    const closed: PetSegmentClosed = {
      segmentId: "seg-a",
      closingBoundaryMessageId: "pet-a",
      nextBoundaryMessageId: "pet-b",
      startedAt: 1,
      endedAt: 2,
    };
    expect(buildArchiveAnchors(closed)).toEqual({
      toClientMessageId: "pet-b",
      fromClientMessageId: "pet-a",
      segmentId: "seg-a",
    });
  });

  test("anchors omit fromClientMessageId when the closed segment never captured a closing boundary", () => {
    const closed: PetSegmentClosed = {
      segmentId: "seg-a",
      nextBoundaryMessageId: "pet-b",
      startedAt: 1,
      endedAt: 2,
    };
    const anchors = buildArchiveAnchors(closed);
    expect(anchors).toEqual({ toClientMessageId: "pet-b", segmentId: "seg-a" });
    expect(anchors).not.toHaveProperty("fromClientMessageId");
  });

  test("anchors are undefined (degraded in-memory-only archive) when there is no next boundary message id", () => {
    const closed: PetSegmentClosed = {
      segmentId: "seg-a",
      closingBoundaryMessageId: "pet-a",
      startedAt: 1,
      endedAt: 2,
    };
    expect(buildArchiveAnchors(closed)).toBeUndefined();
  });

  test("no new segment within the idle window: no brief, clock still advances", async () => {
    const store = new FakePetWorkMemoryStore();
    store.seed({
      lastInteractionAt: 11 * HOUR,
      entries: [{ segmentId: "old", objective: "重构 X", outcome: "completed", at: 1 }],
    });
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => ({ before: 0, after: 0 }),
      now: () => 13 * HOUR,
      idleMs: 12 * HOUR,
    });
    const brief = await controller.beginTurn("pet-msg-1");
    expect(brief).toBeUndefined();
    expect(store.activeSegment()).toBeUndefined();
    expect(store.lastInteractionAt()).toBe(13 * HOUR);
    expect(store.segmentBoundaries()).toEqual([]);
  });

  test("concurrent beginTurn across the idle boundary opens ONE segment / closes ONCE", async () => {
    // A store whose writes actually yield, so the read-modify-write of
    // lastInteractionAt spans an await — the window the race lived in.
    class SlowStore extends FakePetWorkMemoryStore {
      async setLastInteractionAt(at: number): Promise<void> {
        await Promise.resolve();
        await super.setLastInteractionAt(at);
      }
      async openSegment(segment: PetTopicSegment): Promise<void> {
        await Promise.resolve();
        await super.openSegment(segment);
      }
    }
    const store = new SlowStore();
    store.seed({ lastInteractionAt: 30 * MINUTE, entries: [] });
    // Seed one active segment so there IS something to close (and archive).
    await store.openSegment({ id: "seg-old", startedAt: 0, boundaryBeforeMessageId: "pet-0" });
    const closed: PetSegmentClosed[] = [];
    const controller = new PetSegmentController({
      store,
      petSessionId: "pet-1",
      archiveRange: async () => ({ before: 0, after: 0 }),
      onSegmentClosed: (event) => closed.push(event),
      now: () => 13 * HOUR,
      idleMs: 12 * HOUR,
    });

    // Two turns cross the idle boundary at the same instant.
    await Promise.all([controller.beginTurn("pet-a"), controller.beginTurn("pet-b")]);

    // Exactly one NEW segment opened (plus the seeded one) and the close fired once.
    expect(store.opened.filter((s) => s.id !== "seg-old")).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.segmentId).toBe("seg-old");
  });
});
