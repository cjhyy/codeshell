import { describe, expect, test } from "bun:test";
import type { MimiCompanionState } from "../../../shared/mimi-companion";
import { companionPose } from "./companion-pose";
import { companionCueDuration, spriteAnimation } from "./sprite-animation";

const state: MimiCompanionState = {
  enabled: true,
  visible: true,
  size: 320,
  appearance: "mimi-sprite",
  position: { x: 100, y: 100 },
  target: { x: 1200, y: -1000 },
  activity: { id: "click-1", action: "click", phase: "start", startedAt: 0 },
  modelUrl: "csmimi://assets/Hiyori/Hiyori.model3.json",
  coreUrl: "csmimi://assets/Core/live2dcubismcore.min.js",
  preview: false,
};

describe("companion action presentation", () => {
  test("clamps gaze and retains a completed gesture until the host clears its dwell", () => {
    expect(companionPose(state, 180).gazeX).toBe(1);
    expect(companionPose(state, 180).gazeY).toBe(1);
    expect(companionPose(state, 180).reach).toBeGreaterThan(0);
    const ended = { ...state, activity: { ...state.activity, phase: "end" as const } };
    expect(companionPose(ended, 180).reach).toBeGreaterThan(0);
    expect(spriteAnimation(ended, null)).toBe("waving");
    const idle = { ...ended, activity: { ...ended.activity, action: "idle" as const } };
    expect(companionPose(idle, 180).reach).toBe(0);
    expect(companionPose(idle, 180).handPulse).toBe(0);
    expect(spriteAnimation(idle, null)).toBe("idle");
  });

  test("reduced motion keeps a static pose without limb pulses", () => {
    const pose = companionPose(state, 180, true);
    expect(pose.reach).toBe(0);
    expect(pose.handPulse).toBe(0);
    expect(pose.bodyLean).toBe(0);
    expect(Number.isFinite(companionPose(state, Number.NaN).handPulse)).toBe(true);
  });

  test("human dragging takes priority and suppressed cues return to idle", () => {
    expect(spriteAnimation(state, "left")).toBe("left");
    expect(spriteAnimation(state, "right")).toBe("right");
    expect(spriteAnimation(state, null)).toBe("waving");
    expect(
      spriteAnimation({ ...state, activity: { ...state.activity, action: "error" } }, "left"),
    ).toBe("left");
    expect(spriteAnimation(state, null, false)).toBe("idle");
    expect(
      spriteAnimation({ ...state, activity: { ...state.activity, action: "drag" } }, null),
    ).toBe("running");
    expect(companionCueDuration(state)).toBe(400);
    expect(
      companionCueDuration({ ...state, activity: { ...state.activity, action: "error" } }),
    ).toBeLessThanOrEqual(800);
  });
});
