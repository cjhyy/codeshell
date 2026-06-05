import { describe, expect, it } from "bun:test";
import { enqueueQueuedInput, dequeueQueuedInput, clearQueuedInput } from "./queuedInput";

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
});
