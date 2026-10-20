import { describe, expect, test } from "bun:test";
import { HostRuntime, type HostAdapter } from "../../../packages/host/src/runtime.ts";

const adapter = (extra: Partial<HostAdapter> = {}): HostAdapter => ({
  kind: "headless", label: "audit-only memory adapter", ...extra,
});

describe("round11 HostRuntime synchronous in-memory lifecycle controls", () => {
  test("an empty runtime starts and stops its adapter once", () => {
    const events: string[] = [];
    const runtime = new HostRuntime(adapter({
      start: () => events.push("start"), stop: () => events.push("stop"),
    }));
    expect(runtime.capabilities()).toEqual([]);
    expect(runtime.supports("missing")).toBe(false);
    runtime.start(); runtime.start(); runtime.stop(); runtime.stop();
    expect(events).toEqual(["start", "stop"]);
    expect(runtime.supports("missing")).toBe(false);
  });

  test("returned capability arrays do not mutate the registered catalog", () => {
    const runtime = new HostRuntime(adapter(), [{ id: "ordinary", capabilities: ["data.view"] }]);
    const returned = runtime.capabilities(); returned.push("caller.extra"); returned.shift();
    expect(runtime.capabilities()).toEqual(["data.view"]);
    expect(runtime.supports("data.view")).toBe(false);
    runtime.start();
    expect(runtime.supports("data.view")).toBe(true);
    expect(runtime.supports("caller.extra")).toBe(false);
    runtime.stop();
    expect(runtime.supports("data.view")).toBe(false);
  });

  test("stop during adapter start is terminal and never starts services", () => {
    const events: string[] = [];
    let runtime: HostRuntime;
    runtime = new HostRuntime(adapter({
      start: () => { events.push("adapter:start"); runtime.stop(); },
      stop: () => events.push("adapter:stop"),
    }), [{ id: "never", capabilities: [], start: () => events.push("service:start") }]);
    expect(() => runtime.start()).toThrow("Host runtime stopped during start");
    expect(events).toEqual(["adapter:start", "adapter:stop"]);
    expect(() => runtime.start()).toThrow("Host runtime is stopped");
    runtime.stop();
    expect(events).toHaveLength(2);
  });

  test("stop during service start reverses only reached services once", () => {
    const events: string[] = [];
    let runtime: HostRuntime;
    runtime = new HostRuntime(adapter({ stop: () => events.push("adapter:stop") }), [
      { id: "first", capabilities: ["first"],
        start: () => events.push("first:start"), stop: () => events.push("first:stop") },
      { id: "second", capabilities: ["second"],
        start: () => { events.push("second:start"); runtime.stop(); },
        stop: () => events.push("second:stop") },
      { id: "never", capabilities: [],
        start: () => events.push("never:start"), stop: () => events.push("never:stop") },
    ]);
    expect(() => runtime.start()).toThrow("Host runtime stopped during start");
    expect(events).toEqual(["first:start", "second:start", "second:stop", "first:stop", "adapter:stop"]);
    expect(runtime.supports("first")).toBe(false);
    runtime.stop(); expect(events).toHaveLength(5);
  });

  test("reentrant stop callbacks do not double-stop the catalog or adapter", () => {
    const events: string[] = [];
    let runtime: HostRuntime;
    runtime = new HostRuntime(adapter({ stop: () => { events.push("adapter"); runtime.stop(); } }), [
      { id: "first", capabilities: [], stop: () => events.push("first") },
      { id: "second", capabilities: [], stop: () => { events.push("second"); runtime.stop(); } },
    ]);
    runtime.start(); runtime.stop(); runtime.stop();
    expect(events).toEqual(["second", "first", "adapter"]);
  });

  test("all synchronous shutdown failures are retained in reverse service order", () => {
    const a = new Error("a"); const b = new Error("b"); const c = new Error("c");
    const runtime = new HostRuntime(adapter({ stop: () => { throw a; } }), [
      { id: "first", capabilities: [], stop: () => { throw b; } },
      { id: "second", capabilities: [], stop: () => { throw c; } },
    ]);
    runtime.start(); let error: unknown;
    try { runtime.stop(); } catch (value) { error = value; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([c, b, a]);
    expect(() => runtime.stop()).not.toThrow();
    expect(() => runtime.start()).toThrow("Host runtime is stopped");
  });
});
