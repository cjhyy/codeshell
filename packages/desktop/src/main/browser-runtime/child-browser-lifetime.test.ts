import { describe, expect, test } from "bun:test";
import { ChildBrowserWorkerLifetime } from "./child-browser-lifetime.js";

describe("ChildBrowserWorkerLifetime", () => {
  test("worker exit releases only its registered child bindings", () => {
    const first = new ChildBrowserWorkerLifetime();
    const second = new ChildBrowserWorkerLifetime();
    const live = new Set(["parent", "child-a", "child-b", "other-worker-child"]);
    first.register("binding-a", () => live.delete("child-a"));
    first.register("binding-b", () => live.delete("child-b"));
    second.register("binding-other", () => live.delete("other-worker-child"));
    first.close();
    expect([...live]).toEqual(["parent", "other-worker-child"]);
    second.close();
    expect([...live]).toEqual(["parent"]);
  });

  test("normal release, duplicate activation, and repeated worker exit are idempotent", () => {
    const lifetime = new ChildBrowserWorkerLifetime();
    const closed: string[] = [];
    lifetime.register("binding", () => closed.push("original"));
    lifetime.register("binding", () => closed.push("replacement"));
    lifetime.release("binding");
    lifetime.release("binding");
    lifetime.close();
    lifetime.close();
    expect(closed).toEqual(["original"]);
  });

  test("a restarted worker can register fresh bindings without reviving old cleanup", () => {
    const lifetime = new ChildBrowserWorkerLifetime();
    const closed: string[] = [];
    lifetime.register("old-run", () => closed.push("old"));
    lifetime.close();
    lifetime.register("new-run", () => closed.push("new"));
    lifetime.release("old-run");
    expect(closed).toEqual(["old"]);
    lifetime.close();
    expect(closed).toEqual(["old", "new"]);
  });

  test("release removes the binding before invoking reentrant cleanup", () => {
    const lifetime = new ChildBrowserWorkerLifetime();
    let calls = 0;
    lifetime.register("binding", () => {
      calls += 1;
      lifetime.release("binding");
    });
    lifetime.release("binding");
    expect(calls).toBe(1);
  });

  test("close drains the old cohort before callbacks and survives a closing target error", () => {
    const lifetime = new ChildBrowserWorkerLifetime();
    const closed: string[] = [];
    lifetime.register("old-a", () => {
      closed.push("a");
      lifetime.close();
      lifetime.register("new-run", () => closed.push("new"));
      throw new Error("target already closed");
    });
    lifetime.register("old-b", () => closed.push("b"));
    expect(() => lifetime.close()).not.toThrow();
    expect(closed).toEqual(["a", "b"]);
    lifetime.close();
    expect(closed).toEqual(["a", "b", "new"]);
  });
});
