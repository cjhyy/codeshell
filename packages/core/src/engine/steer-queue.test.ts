import { describe, test, expect } from "bun:test";
import type { InputAttachmentMeta } from "../protocol/types.js";
import type { StreamEvent } from "../types.js";
import {
  enqueueSteerItem,
  consumeSteerItems,
  removeSteerItem,
  type SteerItem,
} from "./steer-queue.js";

/**
 * Step-gap steering — contract tests.
 *
 * The full splice-at-step-boundary behavior runs through the heavy TurnLoop +
 * Engine harness (same rationale as turn-loop.test.ts: a faithful fake would
 * test the mock). What we lock down cheaply here is the type-level contract the
 * implementation depends on, so a refactor that drops the event silently fails
 * to compile instead of silently dropping injected guidance.
 */
describe("steer-injection wiring contract", () => {
  test("StreamEvent union includes steer_injected with a text payload", () => {
    const ev: StreamEvent = { type: "steer_injected", text: "也看看收藏页" };
    expect(ev.type).toBe("steer_injected");
    // narrow to the member so a shape change (text → something else) breaks here
    if (ev.type === "steer_injected") {
      expect(ev.text).toBe("也看看收藏页");
    }
  });

  test("steer_injected carries the id so the host can match it back to the queued draft", () => {
    const ev: StreamEvent = { type: "steer_injected", text: "也看看收藏页", id: "s-1" };
    if (ev.type === "steer_injected") {
      expect(ev.id).toBe("s-1");
    }
  });
});

describe("steer-queue helpers (id-keyed, revocable)", () => {
  const attachment: InputAttachmentMeta = {
    id: "att-1",
    sessionId: "s1",
    kind: "image",
    origin: "paste",
    path: ".code-shell/attachments/s1/shot.png",
    absPath: "/tmp/work/.code-shell/attachments/s1/shot.png",
    relPath: ".code-shell/attachments/s1/shot.png",
    mime: "image/png",
    size: 12,
    sha256: "0".repeat(64),
    originalName: "shot.png",
    createdAt: 1,
  };

  test("enqueue appends with id + trimmed text", () => {
    let q: SteerItem[] = [];
    q = enqueueSteerItem(q, "a", "  hi  ", "client-a");
    q = enqueueSteerItem(q, "b", "there");
    expect(q).toEqual([
      { id: "a", text: "hi", clientMessageId: "client-a" },
      { id: "b", text: "there" },
    ]);
  });

  test("enqueue serializes and consumes structured attachments with the steer item", () => {
    let q: SteerItem[] = [];
    q = enqueueSteerItem(q, "a", "  inspect this  ", "client-a", [attachment]);

    const serialized = JSON.parse(JSON.stringify(q)) as SteerItem[];
    const { drained, rest } = consumeSteerItems(serialized);

    expect(drained).toEqual([
      { id: "a", text: "inspect this", clientMessageId: "client-a", attachments: [attachment] },
    ]);
    expect(rest).toEqual([]);
  });

  test("enqueue drops blank text and missing id", () => {
    let q: SteerItem[] = [];
    q = enqueueSteerItem(q, "a", "   ");
    q = enqueueSteerItem(q, "", "x");
    expect(q).toEqual([]);
  });

  test("consume drains all and clears", () => {
    const q: SteerItem[] = [
      { id: "a", text: "1" },
      { id: "b", text: "2" },
    ];
    const { drained, rest } = consumeSteerItems(q);
    expect(drained).toEqual(q);
    expect(rest).toEqual([]);
  });

  test("remove takes out a pending entry and reports removed=true", () => {
    const q: SteerItem[] = [
      { id: "a", text: "1" },
      { id: "b", text: "2" },
    ];
    const { list, removed } = removeSteerItem(q, "a");
    expect(removed).toBe(true);
    expect(list).toEqual([{ id: "b", text: "2" }]);
  });

  test("remove of an already-consumed id reports removed=false (can't revoke)", () => {
    const q: SteerItem[] = [{ id: "b", text: "2" }];
    const { list, removed } = removeSteerItem(q, "a");
    expect(removed).toBe(false);
    expect(list).toEqual(q);
  });
});
