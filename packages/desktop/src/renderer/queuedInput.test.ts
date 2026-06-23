import { describe, expect, it } from "bun:test";
import {
  enqueueQueuedInput,
  dequeueQueuedInput,
  drainQueuedInput,
  clearQueuedInput,
  removeQueuedInputAt,
  removeQueuedInputById,
  promoteQueuedInputAt,
} from "./queuedInput";

describe("queued input", () => {
  it("queues non-empty text per bucket in FIFO order with ids", () => {
    let state = {};
    state = enqueueQueuedInput(state, "repo:s1", "a", " first ");
    state = enqueueQueuedInput(state, "repo:s1", "b", "second");
    state = enqueueQueuedInput(state, "repo:s2", "c", "other");

    const first = dequeueQueuedInput(state, "repo:s1");
    expect(first.item).toEqual({ id: "a", text: "first" });
    expect(first.state["repo:s1"]).toEqual([{ id: "b", text: "second" }]);
    expect(first.state["repo:s2"]).toEqual([{ id: "c", text: "other" }]);

    const second = dequeueQueuedInput(first.state, "repo:s1");
    expect(second.item).toEqual({ id: "b", text: "second" });
    expect(second.state["repo:s1"]).toBeUndefined();
  });

  it("ignores blank input and blank id, and can clear a bucket", () => {
    let state = { "repo:s1": [{ id: "x", text: "hello" }] };
    state = enqueueQueuedInput(state, "repo:s1", "y", "   ");
    state = enqueueQueuedInput(state, "repo:s1", "", "no-id");
    expect(state["repo:s1"]).toEqual([{ id: "x", text: "hello" }]);

    state = clearQueuedInput(state, "repo:s1");
    expect(state["repo:s1"]).toBeUndefined();
  });

  it("removes a single queued item by index and reports the removed item", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
        { id: "3", text: "three" },
      ],
    };
    const { state: next, removed } = removeQueuedInputAt(state, "repo:s1", 1);

    expect(removed).toEqual({ id: "2", text: "two" });
    expect(next["repo:s1"]).toEqual([
      { id: "1", text: "one" },
      { id: "3", text: "three" },
    ]);
    // original not mutated
    expect(state["repo:s1"]).toHaveLength(3);
  });

  it("removeAt on an invalid index reports removed=null and keeps state", () => {
    const state = { "repo:s1": [{ id: "1", text: "one" }] };
    const { state: next, removed } = removeQueuedInputAt(state, "repo:s1", 9);
    expect(removed).toBeNull();
    expect(next).toBe(state);
  });

  it("removes a queued item by id (steer_injected confirmation)", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
      ],
    };
    const next = removeQueuedInputById(state, "repo:s1", "1");
    expect(next["repo:s1"]).toEqual([{ id: "2", text: "two" }]);
  });

  it("removeById is a no-op when the id is absent (already deleted)", () => {
    const state = { "repo:s1": [{ id: "2", text: "two" }] };
    const next = removeQueuedInputById(state, "repo:s1", "1");
    expect(next).toBe(state);
  });

  it("removeById clears the bucket when it empties", () => {
    const state = { "repo:s1": [{ id: "1", text: "one" }] };
    const next = removeQueuedInputById(state, "repo:s1", "1");
    expect(next["repo:s1"]).toBeUndefined();
  });

  it("promotes a queued item to the front", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
        { id: "3", text: "three" },
      ],
    };
    const next = promoteQueuedInputAt(state, "repo:s1", 2);
    expect(next["repo:s1"]).toEqual([
      { id: "3", text: "three" },
      { id: "1", text: "one" },
      { id: "2", text: "two" },
    ]);
  });

  it("drains the whole queue as one merged message + ids, and clears the slot", () => {
    const state = {
      "repo:s1": [
        { id: "1", text: "one" },
        { id: "2", text: "two" },
        { id: "3", text: "three" },
      ],
      "repo:s2": [{ id: "k", text: "keep" }],
    };
    const drained = drainQueuedInput(state, "repo:s1");

    expect(drained.text).toBe("one\n\ntwo\n\nthree");
    expect(drained.ids).toEqual(["1", "2", "3"]);
    expect(drained.state["repo:s1"]).toBeUndefined();
    expect(drained.state["repo:s2"]).toEqual([{ id: "k", text: "keep" }]);
    expect(state["repo:s1"]).toHaveLength(3);
  });

  it("drain on an empty bucket returns null without touching state", () => {
    const state = { "repo:s1": [{ id: "x", text: "x" }] };
    const drained = drainQueuedInput(state, "repo:empty");
    expect(drained.text).toBeNull();
    expect(drained.ids).toEqual([]);
    expect(drained.state).toBe(state);
  });
});
