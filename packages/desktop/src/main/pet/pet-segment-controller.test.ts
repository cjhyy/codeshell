import { describe, expect, test } from "bun:test";
import type { PetTopicSegment, PetWorkMemoryEntry } from "@cjhyy/code-shell-pet";
import { PetSegmentController } from "./pet-segment-controller";
import type { PetWorkMemoryStoreLike } from "./pet-segment-controller";

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
      lastInteractionAt: 0,
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

  test("a segment opened without a message id records no UI boundary", async () => {
    const store = new FakePetWorkMemoryStore();
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
});
