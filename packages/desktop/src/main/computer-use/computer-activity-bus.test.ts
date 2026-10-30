import { describe, expect, test } from "bun:test";
import { ComputerActivityBus } from "./computer-activity-bus.js";
import type { CompanionOperation } from "./cua-activity-server.js";

const op = (
  id: string,
  phase: CompanionOperation["phase"],
  extra: Partial<CompanionOperation> = {},
): CompanionOperation => ({ id, action: "click", phase, capture: false, ...extra });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ComputerActivityBus", () => {
  test("publishing never waits for a slow character, except a capture start", async () => {
    const bus = new ComputerActivityBus();
    const seen: string[] = [];
    let release!: () => void;
    bus.subscribe({
      onOperation: async (event) => {
        seen.push(`${event.id}:${event.phase}`);
        if (event.id === "slow") await new Promise<void>((resolve) => (release = resolve));
      },
    });
    const at = Date.now();
    await bus.publish(op("slow", "start"));
    await bus.publish(op("next", "start"));
    expect(Date.now() - at).toBeLessThan(50);
    let hidden = false;
    const capture = bus.publish(op("cap", "start", { capture: true })).then(() => (hidden = true));
    await tick();
    expect(hidden).toBe(false);
    release();
    await capture;
    expect(seen).toEqual(["slow:start", "next:start", "cap:start"]);
  });

  test("updates coalesce, and an operation that ends before it was shown is dropped whole", async () => {
    const bus = new ComputerActivityBus();
    const seen: string[] = [];
    let release!: () => void;
    bus.subscribe({
      onOperation: async (event) => {
        seen.push(`${event.id}:${event.phase}:${event.target?.x ?? ""}`);
        if (event.id === "block") await new Promise<void>((resolve) => (release = resolve));
      },
    });
    void bus.publish(op("a", "start"));
    await tick();
    void bus.publish(op("block", "start"));
    await tick();
    void bus.publish(op("a", "update", { target: { x: 1, y: 1 } }));
    void bus.publish(op("a", "update", { target: { x: 2, y: 2 } }));
    void bus.publish(op("gone", "start"));
    void bus.publish(op("gone", "end"));
    void bus.publish(op("a", "end"));
    release();
    for (let i = 0; i < 5; i++) await tick();
    // "gone" never reached the character: neither its start nor its end is shown.
    expect(seen).toEqual(["a:start:", "block:start:", "a:update:2", "a:end:"]);
  });

  test("ends survive overflow and a throwing character does not stop delivery", async () => {
    const bus = new ComputerActivityBus();
    const seen: string[] = [];
    let release!: () => void;
    bus.subscribe({
      onOperation: async (event) => {
        if (event.id === "block" && event.phase === "start")
          await new Promise<void>((resolve) => (release = resolve));
        seen.push(`${event.id}:${event.phase}`);
        if (event.id === "boom") throw new Error("render failed");
      },
    });
    void bus.publish(op("block", "start"));
    await tick();
    void bus.publish(op("block", "end"));
    for (let i = 0; i < 100; i++) void bus.publish(op(`u${i}`, "start"));
    void bus.publish(op("boom", "start"));
    void bus.publish(op("after", "start"));
    release();
    for (let i = 0; i < 20; i++) await tick();
    expect(seen).toContain("block:end");
    expect(seen.length).toBeLessThanOrEqual(66);
    expect(seen.at(-1)).toBe("after:start");
  });

  test("run outcomes are presented only for Sessions that used the computer", () => {
    const bus = new ComputerActivityBus();
    const runs: string[] = [];
    bus.subscribe({
      onOperation: () => {},
      onRun: (run) => runs.push(`${run.sessionId}:${run.outcome}`),
    });
    bus.publishRun("idle-session", "completed");
    void bus.publish(op("x", "start", { sessionId: "worker" }));
    bus.publishRun("worker", "completed");
    bus.publishRun("worker", "failed");
    expect(runs).toEqual(["worker:completed"]);
  });
});
