import { describe, expect, test } from "bun:test";
import { InputGate, UserActivityMonitor } from "./input-gate.js";
import {
  gateDecision,
  gateFullyOpen,
  inputLane,
  parseInputGateState,
} from "./input-gate-policy.js";

const call = (name: string, args: Record<string, unknown> = {}, sessionIds: string[] = []) => ({
  name,
  args,
  sessionIds,
});

describe("input gate policy", () => {
  test("classifies reads, background input and foreground input; unknown fails closed", () => {
    expect(inputLane("get_window_state", {})).toBe("read");
    expect(inputLane("type_text", {})).toBe("background");
    expect(inputLane("set_value", {})).toBe("background");
    expect(inputLane("click", { delivery_mode: "foreground" })).toBe("foreground");
    expect(inputLane("click", { scope: "desktop" })).toBe("foreground");
    expect(inputLane("move_cursor", { target: { kind: "desktop" } })).toBe("foreground");
    expect(inputLane("launch_app", {})).toBe("foreground");
    expect(inputLane("run_script", {})).toBe("foreground");
    expect(inputLane("page", {})).toBe("foreground");
  });

  test("decisions: reads always pass; cancel and stop refuse every input lane", () => {
    const open = { version: 1, userActive: false, cancelledSessions: [] };
    expect(gateDecision(undefined, call("list_apps"))).toEqual({ allow: true, lane: "read" });
    expect(gateDecision(undefined, call("click"))).toMatchObject({ reason: "host-unavailable" });
    expect(gateDecision(open, call("click"))).toEqual({ allow: true, lane: "background" });
    expect(
      gateDecision({ ...open, cancelledSessions: ["root"] }, call("click", {}, ["child", "root"])),
    ).toMatchObject({ allow: false, reason: "session-cancelled" });
    expect(gateDecision({ ...open, holdAll: "user-stop" }, call("set_value"))).toMatchObject({
      reason: "user-stop",
    });
    expect(gateDecision({ ...open, holdForeground: "chat-open" }, call("type_text"))).toMatchObject(
      { allow: true },
    );
    expect(
      gateDecision({ ...open, holdForeground: "chat-open" }, call("launch_app")),
    ).toMatchObject({ allow: false, reason: "chat-open" });
    expect(
      gateDecision({ ...open, userActive: true }, call("click", { delivery_mode: "foreground" })),
    ).toMatchObject({ allow: false, reason: "user-active" });
    expect(gateFullyOpen(open)).toBe(true);
    expect(gateFullyOpen({ ...open, userActive: true })).toBe(false);
    expect(gateFullyOpen(undefined)).toBe(false);
  });

  test("parsing rejects unknown hold reasons and malformed Session ids", () => {
    expect(parseInputGateState({ version: 1, userActive: false, cancelledSessions: [] })).toEqual({
      version: 1,
      userActive: false,
      cancelledSessions: [],
    });
    expect(
      parseInputGateState({ version: 1, userActive: false, cancelledSessions: [], holdAll: "x" }),
    ).toBeUndefined();
    expect(
      parseInputGateState({
        version: 2,
        userActive: true,
        cancelledSessions: ["ok-1", "bad id", 3],
      })?.cancelledSessions,
    ).toEqual(["ok-1"]);
  });
});

describe("InputGate", () => {
  test("stop, chat hold, resume and Session cancels publish versioned snapshots", () => {
    const gate = new InputGate();
    const seen: number[] = [];
    gate.subscribe((state) => seen.push(state.version));
    gate.stopAll();
    gate.stopAll();
    expect(gate.status()).toEqual({ stopped: true, foregroundHeld: false, userActive: false });
    gate.holdForegroundForChat();
    gate.resume();
    expect(gate.snapshot()).toEqual({ version: 3, userActive: false, cancelledSessions: [] });
    gate.cancelSession("s1");
    gate.cancelSession("s1");
    expect(gate.snapshot().cancelledSessions).toEqual(["s1"]);
    gate.clearSession("s1");
    expect(gate.snapshot().cancelledSessions).toEqual([]);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });

  test("the cancelled-Session list stays bounded", () => {
    const gate = new InputGate();
    for (let i = 0; i < 80; i++) gate.cancelSession(`s${i}`);
    const cancelled = gate.snapshot().cancelledSessions;
    expect(cancelled).toHaveLength(64);
    expect(cancelled[0]).toBe("s16");
  });

  test("resuming does not clear a Session the user cancelled", () => {
    const gate = new InputGate();
    gate.cancelSession("s1");
    gate.stopAll();
    gate.resume();
    expect(gate.snapshot().cancelledSessions).toEqual(["s1"]);
  });
});

describe("UserActivityMonitor", () => {
  test("recent human input marks the user active; our own foreground input does not", () => {
    const gate = new InputGate();
    let idle = 30;
    let now = 1_000;
    const monitor = new UserActivityMonitor({ gate, idleSeconds: () => idle, now: () => now });
    monitor.sample();
    expect(gate.status().userActive).toBe(false);
    idle = 0;
    monitor.sample();
    expect(gate.status().userActive).toBe(true);
    idle = 5;
    monitor.sample();
    expect(gate.status().userActive).toBe(false);

    // Our foreground click resets the system idle clock; keep the prior verdict.
    monitor.observe({ id: "a", phase: "start", lane: "foreground" });
    idle = 0;
    monitor.sample();
    expect(gate.status().userActive).toBe(false);
    monitor.observe({ id: "a", phase: "end" });
    now += 1_000;
    monitor.sample();
    expect(gate.status().userActive).toBe(false);
    // After the grace period a fresh reset is the human again.
    now += 2_000;
    monitor.sample();
    expect(gate.status().userActive).toBe(true);

    // Background input never suppresses detection.
    idle = 9;
    monitor.sample();
    monitor.observe({ id: "b", phase: "start", lane: "background" });
    idle = 0;
    monitor.sample();
    expect(gate.status().userActive).toBe(true);
  });

  test("an idle-time failure keeps the current verdict, and stop clears it", () => {
    const gate = new InputGate();
    gate.setUserActive(true);
    const monitor = new UserActivityMonitor({
      gate,
      idleSeconds: () => {
        throw new Error("unavailable");
      },
    });
    monitor.sample();
    expect(gate.status().userActive).toBe(true);
    monitor.stop();
    expect(gate.status().userActive).toBe(false);
  });
});
