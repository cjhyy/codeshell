import { describe, expect, it } from "bun:test";
import {
  enqueueQueuedInput,
  dequeueQueuedInput,
  drainQueuedInput,
  clearQueuedInput,
  removeQueuedInputAt,
  removeQueuedInputById,
  promoteQueuedInputAt,
  enqueueSerialTask,
  canSteerQueuedItem,
} from "./queuedInput";

describe("queued input", () => {
  it("queues non-empty text per bucket in FIFO order with ids", () => {
    let state = {};
    state = enqueueQueuedInput(state, "repo:s1", "a", " first ");
    state = enqueueQueuedInput(state, "repo:s1", "b", "second");
    state = enqueueQueuedInput(state, "repo:s2", "c", "other");

    const first = dequeueQueuedInput(state, "repo:s1");
    expect(first.item).toEqual({ id: "a", text: "first", clientMessageId: "a" });
    expect(first.state["repo:s1"]).toEqual([{ id: "b", text: "second", clientMessageId: "b" }]);
    expect(first.state["repo:s2"]).toEqual([{ id: "c", text: "other", clientMessageId: "c" }]);

    const second = dequeueQueuedInput(first.state, "repo:s1");
    expect(second.item).toEqual({ id: "b", text: "second", clientMessageId: "b" });
    expect(second.state["repo:s1"]).toBeUndefined();
  });

  it("ignores blank input and blank id, and can clear a bucket", () => {
    let state = { "repo:s1": [{ id: "x", text: "hello", clientMessageId: "x" }] };
    state = enqueueQueuedInput(state, "repo:s1", "y", "   ");
    state = enqueueQueuedInput(state, "repo:s1", "", "no-id");
    expect(state["repo:s1"]).toEqual([{ id: "x", text: "hello", clientMessageId: "x" }]);

    state = clearQueuedInput(state, "repo:s1");
    expect(state["repo:s1"]).toBeUndefined();
  });

  it("removes a single queued item by index and reports the removed item", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one", clientMessageId: "c1" },
        { id: "2", text: "two", clientMessageId: "c2" },
        { id: "3", text: "three", clientMessageId: "c3" },
      ],
    };
    const { state: next, removed } = removeQueuedInputAt(state, "repo:s1", 1);

    expect(removed).toEqual({ id: "2", text: "two", clientMessageId: "c2" });
    expect(next["repo:s1"]).toEqual([
      { id: "1", text: "one", clientMessageId: "c1" },
      { id: "3", text: "three", clientMessageId: "c3" },
    ]);
    // original not mutated
    expect(state["repo:s1"]).toHaveLength(3);
  });

  it("removeAt on an invalid index reports removed=null and keeps state", () => {
    const state = { "repo:s1": [{ id: "1", text: "one", clientMessageId: "c1" }] };
    const { state: next, removed } = removeQueuedInputAt(state, "repo:s1", 9);
    expect(removed).toBeNull();
    expect(next).toBe(state);
  });

  it("removes a queued item by id (steer_injected confirmation)", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one", clientMessageId: "c1" },
        { id: "2", text: "two", clientMessageId: "c2" },
      ],
    };
    const next = removeQueuedInputById(state, "repo:s1", "1");
    expect(next["repo:s1"]).toEqual([{ id: "2", text: "two", clientMessageId: "c2" }]);
  });

  it("removeById is a no-op when the id is absent (already deleted)", () => {
    const state = { "repo:s1": [{ id: "2", text: "two", clientMessageId: "c2" }] };
    const next = removeQueuedInputById(state, "repo:s1", "1");
    expect(next).toBe(state);
  });

  it("removeById clears the bucket when it empties", () => {
    const state = { "repo:s1": [{ id: "1", text: "one", clientMessageId: "c1" }] };
    const next = removeQueuedInputById(state, "repo:s1", "1");
    expect(next["repo:s1"]).toBeUndefined();
  });

  it("promotes a queued item to the front", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one", clientMessageId: "c1" },
        { id: "2", text: "two", clientMessageId: "c2" },
        { id: "3", text: "three", clientMessageId: "c3" },
      ],
    };
    const next = promoteQueuedInputAt(state, "repo:s1", 2);
    expect(next["repo:s1"]).toEqual([
      { id: "3", text: "three", clientMessageId: "c3" },
      { id: "1", text: "one", clientMessageId: "c1" },
      { id: "2", text: "two", clientMessageId: "c2" },
    ]);
  });

  it("drains the whole queue as one merged message + ids, and clears the slot", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one", clientMessageId: "c1" },
        { id: "2", text: "two", clientMessageId: "c2" },
        { id: "3", text: "three", clientMessageId: "c3" },
      ],
      "repo:s2": [{ id: "k", text: "keep", clientMessageId: "ck" }],
    };
    const drained = drainQueuedInput(state, "repo:s1");

    expect(drained.text).toBe("one\n\ntwo\n\nthree");
    expect(drained.ids).toEqual(["1", "2", "3"]);
    expect(drained.state["repo:s1"]).toBeUndefined();
    expect(drained.state["repo:s2"]).toEqual([{ id: "k", text: "keep", clientMessageId: "ck" }]);
    expect(state["repo:s1"]).toHaveLength(3);
  });

  it("preserves display text and structured attachments through queue drain", () => {
    const attachment = {
      id: "att-1",
      sessionId: "s1",
      kind: "directory" as const,
      origin: "mention" as const,
      path: "src",
      absPath: "/repo/src",
      relPath: "src",
      size: 0,
      sha256: "",
      createdAt: 1,
    };
    const state = enqueueQueuedInput({}, "repo:s1", "1", "inspect it", "client-1", {
      displayText: "inspect @src",
      attachments: [attachment],
    });

    const first = dequeueQueuedInput(state, "repo:s1");
    expect(first.item?.text).toBe("inspect it");
    expect(first.item?.displayText).toBe("inspect @src");
    expect(first.item?.attachments).toEqual([attachment]);
    expect(canSteerQueuedItem(first.item!)).toBe(false);

    const drained = drainQueuedInput(state, "repo:s1");
    expect(drained.text).toBe("inspect it");
    expect(drained.displayText).toBe("inspect @src");
    expect(drained.attachments).toEqual([attachment]);
  });

  it("keeps image-only queued drafts with display text and attachments", () => {
    const attachment = {
      id: "att-img",
      sessionId: "s1",
      kind: "image" as const,
      origin: "paste" as const,
      path: ".code-shell/attachments/s1/a.png",
      absPath: "/repo/.code-shell/attachments/s1/a.png",
      relPath: ".code-shell/attachments/s1/a.png",
      mime: "image/png",
      size: 1,
      sha256: "0".repeat(64),
      createdAt: 1,
    };
    const state = enqueueQueuedInput({}, "repo:s1", "1", "", "client-1", {
      displayText: "<codeshell-image />",
      attachments: [attachment],
    });
    const drained = drainQueuedInput(state, "repo:s1");

    expect(drained.text).toBe("");
    expect(drained.displayText).toBe("<codeshell-image />");
    expect(drained.attachments).toEqual([attachment]);
  });

  it("drain on an empty bucket returns null without touching state", () => {
    const state = { "repo:s1": [{ id: "x", text: "x", clientMessageId: "cx" }] };
    const drained = drainQueuedInput(state, "repo:empty");
    expect(drained.text).toBeNull();
    expect(drained.ids).toEqual([]);
    expect(drained.state).toBe(state);
  });

  it("runs queued async tasks serially", async () => {
    const queue = { tail: Promise.resolve() };
    const order: string[] = [];
    let markStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseFirst: () => void = () => {};
    const first = enqueueSerialTask(queue, async () => {
      order.push("first:start");
      markStarted();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    });
    const second = enqueueSerialTask(queue, () => {
      order.push("second");
    });

    await started;
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await first;
    await second;
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });
});
