import { describe, expect, it } from "bun:test";
import {
  enqueueQueuedInput,
  dequeueQueuedInput,
  clearQueuedInput,
  removeQueuedInputAt,
  promoteQueuedInputAt,
} from "./queuedInput";

describe("queued input", () => {
  it("queues non-empty text per bucket in FIFO order", () => {
    let state = {};
    state = enqueueQueuedInput(state, "repo:s1", " first ");
    state = enqueueQueuedInput(state, "repo:s1", "second");
    state = enqueueQueuedInput(state, "repo:s2", "other");

    const first = dequeueQueuedInput(state, "repo:s1");
    expect(first.text).toBe("first");
    expect(first.state["repo:s1"]).toEqual(["second"]);
    expect(first.state["repo:s2"]).toEqual(["other"]);

    const second = dequeueQueuedInput(first.state, "repo:s1");
    expect(second.text).toBe("second");
    expect(second.state["repo:s1"]).toBeUndefined();
  });

  it("ignores blank input and can clear a bucket", () => {
    let state = { "repo:s1": ["hello"] };
    state = enqueueQueuedInput(state, "repo:s1", "   ");
    expect(state["repo:s1"]).toEqual(["hello"]);

    state = clearQueuedInput(state, "repo:s1");
    expect(state["repo:s1"]).toBeUndefined();
  });

  it("removes a single queued item", () => {
    const state = { "repo:s1": ["one", "two", "three"] };
    const next = removeQueuedInputAt(state, "repo:s1", 1);

    expect(next["repo:s1"]).toEqual(["one", "three"]);
    expect(state["repo:s1"]).toEqual(["one", "two", "three"]);
  });

  it("promotes a queued item to the front", () => {
    const state = { "repo:s1": ["one", "two", "three"] };
    const next = promoteQueuedInputAt(state, "repo:s1", 2);

    expect(next["repo:s1"]).toEqual(["three", "one", "two"]);
    expect(state["repo:s1"]).toEqual(["one", "two", "three"]);
  });
});
