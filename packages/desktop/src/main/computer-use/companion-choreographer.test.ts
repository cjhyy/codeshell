import { describe, expect, test } from "bun:test";
import {
  COMPLETE_DWELL_MS,
  CompanionChoreographer,
  ERROR_DWELL_MS,
  GESTURE_DWELL_MS,
} from "./companion-choreographer.js";
import type { CompanionOperation } from "./cua-activity-server.js";

function fixture() {
  let clock = 1_000;
  let suppressed = false;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 0;
  const placed: Array<[{ x: number; y: number } | undefined, unknown]> = [];
  const log: string[] = [];
  let releaseCapture: () => void = () => {};
  const choreographer = new CompanionChoreographer({
    now: () => clock,
    setTimer: (run, ms) => {
      timers.set(++nextTimer, { at: clock + ms, run });
      return nextTimer;
    },
    clearTimer: (handle) => timers.delete(handle as number),
    suppressed: () => suppressed,
    place: (point, reserved) => placed.push([point, reserved]),
    beginGesture: () => log.push("begin"),
    hideForCapture: () =>
      new Promise<void>((resolve) => {
        log.push("hide");
        releaseCapture = resolve;
      }),
    publish: () => log.push("publish"),
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > clock) continue;
      timers.delete(id);
      timer.run();
    }
  };
  return {
    choreographer,
    placed,
    log,
    advance,
    timers,
    suppress: (value: boolean) => (suppressed = value),
    releaseCapture: () => releaseCapture(),
  };
}

const op = (patch: Partial<CompanionOperation> & Pick<CompanionOperation, "id">) =>
  ({ action: "click", phase: "start", capture: false, ...patch }) as CompanionOperation;

describe("CompanionChoreographer", () => {
  test("a pointer gesture is placed at its trusted target and dwells before idle", async () => {
    const f = fixture();
    await f.choreographer.receive(
      op({ id: "c1", target: { x: 10, y: 20 }, targetSource: "native-cursor" }),
    );
    expect(f.log).toEqual(["begin", "publish"]);
    expect(f.placed).toEqual([[{ x: 10, y: 20 }, undefined]]);
    expect(f.choreographer.activity).toMatchObject({ id: "c1", action: "click", phase: "start" });
    await f.choreographer.receive(op({ id: "c1", phase: "end" }));
    expect(f.choreographer.activity).toMatchObject({ id: "c1", phase: "end" });
    f.advance(GESTURE_DWELL_MS - 1);
    expect(f.choreographer.activity.id).toBe("c1");
    f.advance(1);
    expect(f.choreographer.activity).toMatchObject({ id: "idle", action: "idle" });
  });

  test("untrusted coordinates are never a placement; keys wait for the cursor", async () => {
    const f = fixture();
    await f.choreographer.receive(op({ id: "c1", target: { x: 1, y: 2 } }));
    expect(f.placed).toEqual([[undefined, undefined]]);
    await f.choreographer.receive(op({ id: "k1", action: "key", target: { x: 1, y: 2 } }));
    expect(f.placed).toHaveLength(1);
    expect(f.choreographer.activity.action).toBe("key");
  });

  test("a value write keeps its element frame clear", async () => {
    const f = fixture();
    const avoidRect = { x: 0, y: 0, width: 50, height: 20 };
    await f.choreographer.receive(
      op({ id: "v1", action: "type", target: { x: 5, y: 5 }, targetSource: "element", avoidRect }),
    );
    expect(f.placed).toEqual([[{ x: 5, y: 5 }, avoidRect]]);
  });

  test("observation never interrupts the gesture in progress", async () => {
    const f = fixture();
    await f.choreographer.receive(op({ id: "c1" }));
    await f.choreographer.receive(op({ id: "o1", action: "observe" }));
    expect(f.choreographer.activity.id).toBe("c1");
    expect(f.log.filter((entry) => entry === "begin")).toHaveLength(1);
  });

  test("a capture hides the character until the host confirms", async () => {
    const f = fixture();
    let settled = false;
    const pending = f.choreographer
      .receive(op({ id: "s1", action: "observe", capture: true }))
      .then(() => (settled = true));
    expect(f.choreographer.capturing).toBe(true);
    expect(f.log).toEqual(["hide"]);
    await Promise.resolve();
    expect(settled).toBe(false);
    f.releaseCapture();
    await pending;
    await f.choreographer.receive(op({ id: "s1", phase: "end" }));
    expect(f.choreographer.capturing).toBe(false);
  });

  test("updates refine only the current gesture and keep a key's input frame", async () => {
    const f = fixture();
    const avoidRect = { x: 0, y: 0, width: 50, height: 20 };
    await f.choreographer.receive(
      op({ id: "v1", action: "type", target: { x: 5, y: 5 }, targetSource: "element", avoidRect }),
    );
    await f.choreographer.receive(op({ id: "k1", action: "key" }));
    await f.choreographer.receive(
      op({ id: "k1", action: "key", phase: "update", target: { x: 5, y: 5 } }),
    );
    expect(f.placed.at(-1)).toEqual([{ x: 5, y: 5 }, avoidRect]);
    await f.choreographer.receive(
      op({ id: "v1", action: "type", phase: "update", target: { x: 9, y: 9 } }),
    );
    expect(f.placed.at(-1)).toEqual([{ x: 5, y: 5 }, avoidRect]);
  });

  test("after a dwell the newest unfinished gesture resumes", async () => {
    const f = fixture();
    await f.choreographer.receive(
      op({ id: "a", target: { x: 1, y: 1 }, targetSource: "native-cursor" }),
    );
    await f.choreographer.receive(
      op({ id: "b", action: "scroll", target: { x: 2, y: 2 }, targetSource: "native-cursor" }),
    );
    await f.choreographer.receive(op({ id: "b", phase: "end" }));
    f.advance(GESTURE_DWELL_MS);
    expect(f.choreographer.activity).toMatchObject({ id: "a", action: "click", phase: "start" });
    expect(f.placed.at(-1)).toEqual([{ x: 1, y: 1 }, undefined]);
  });

  test("run outcomes show only when nothing is in flight; cancel shows nothing", async () => {
    const f = fixture();
    f.choreographer.run({ sessionId: "s", outcome: "cancelled" });
    expect(f.choreographer.activity.action).toBe("idle");
    await f.choreographer.receive(op({ id: "c1" }));
    f.choreographer.run({ sessionId: "s", outcome: "completed" });
    expect(f.choreographer.activity.action).toBe("click");
    await f.choreographer.receive(op({ id: "c1", phase: "end" }));
    f.choreographer.run({ sessionId: "s", outcome: "completed" });
    expect(f.choreographer.activity.action).toBe("complete");
    f.advance(COMPLETE_DWELL_MS);
    expect(f.choreographer.activity.action).toBe("idle");
    f.choreographer.run({ sessionId: "s", outcome: "failed" });
    expect(f.choreographer.activity.action).toBe("error");
    f.advance(ERROR_DWELL_MS);
    expect(f.choreographer.activity.action).toBe("idle");
  });

  test("while the human is present nothing new is shown, and interrupt clears all", async () => {
    const f = fixture();
    f.suppress(true);
    await f.choreographer.receive(op({ id: "c1" }));
    expect(f.choreographer.activity.action).toBe("idle");
    f.choreographer.run({ sessionId: "s", outcome: "completed" });
    expect(f.choreographer.activity.action).toBe("idle");
    f.suppress(false);
    await f.choreographer.receive(op({ id: "c2" }));
    await f.choreographer.receive(op({ id: "c2", phase: "end" }));
    f.choreographer.interrupt();
    expect(f.choreographer.activity).toMatchObject({ id: "human", action: "idle" });
    expect(f.timers.size).toBe(0);
  });

  test("dispose stops every pending presentation", async () => {
    const f = fixture();
    await f.choreographer.receive(op({ id: "c1" }));
    await f.choreographer.receive(op({ id: "c1", phase: "end" }));
    f.choreographer.dispose();
    expect(f.timers.size).toBe(0);
    await f.choreographer.receive(op({ id: "c2" }));
    expect(f.choreographer.activity.id).toBe("c1");
  });
});
