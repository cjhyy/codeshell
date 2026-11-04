import { describe, expect, test } from "bun:test";
import type { MimiCompanionState } from "../../../shared/mimi-companion";
import { companionActionLabel, companionYields } from "./companion-pose";
import { companionCueDuration, spriteAnimation } from "./sprite-animation";
import { effectAction, SPRITE_EFFECTS, type EffectSet } from "./character-renderer";

const state: MimiCompanionState = {
  enabled: true,
  visible: true,
  size: 320,
  appearance: "mimi-sprite",
  position: { x: 100, y: 100 },
  target: { x: 1200, y: -1000 },
  activity: { id: "click-1", action: "click", phase: "start", startedAt: 0 },
  preview: false,
};

describe("companion action presentation", () => {
  test("retains a completed gesture until the host clears its dwell", () => {
    const ended = { ...state, activity: { ...state.activity, phase: "end" as const } };
    expect(spriteAnimation(ended, null)).toBe("waving");
    const idle = { ...ended, activity: { ...ended.activity, action: "idle" as const } };
    expect(spriteAnimation(idle, null)).toBe("idle");
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
      spriteAnimation({ ...state, activity: { ...state.activity, action: "key" } }, null),
    ).toBe("typing");
    expect(
      spriteAnimation({ ...state, activity: { ...state.activity, action: "drag" } }, null),
    ).toBe("running");
    expect(companionCueDuration(state)).toBe(400);
    expect(
      companionCueDuration({ ...state, activity: { ...state.activity, action: "error" } }),
    ).toBeLessThanOrEqual(800);
  });

  test("an appearance degrades missing actions through its fallbacks, then to idle", () => {
    expect(effectAction(SPRITE_EFFECTS, "complete")).toBe("complete");
    const partial: EffectSet = {
      kind: "sprite",
      supports: new Set(["idle", "observe", "type"]),
      fallback: { key: "type", working: "observe" },
      loop: new Set(["type"]),
    };
    expect(effectAction(partial, "key")).toBe("type");
    expect(effectAction(partial, "working")).toBe("observe");
    expect(effectAction(partial, "complete")).toBe("idle");
    expect(effectAction({ ...partial, fallback: { key: "working", working: "key" } }, "key")).toBe(
      "idle",
    );
    expect(
      spriteAnimation({ ...state, activity: { ...state.activity, action: "complete" } }, null),
    ).toBe("jumping");
  });

  test("a click lands as a tap on controls and as settling in to type on a field", () => {
    expect(spriteAnimation({ ...state, element: "button" }, null)).toBe("waving");
    expect(spriteAnimation({ ...state, element: "text" }, null)).toBe("typing");
    expect(companionActionLabel({ ...state, element: "text" })).toBe("点进输入框");
    expect(companionActionLabel({ ...state, element: "link" })).toBe("打开链接");
    expect(companionActionLabel({ ...state, element: "other" })).toBe("点击");
    expect(companionActionLabel(state)).toBe("点击");
  });

  test("steps back for the human only while computer use is under way", () => {
    const control = { stopped: false, foregroundHeld: false, userActive: true };
    const at = (action: MimiCompanionState["activity"]["action"]) => ({
      ...state,
      control,
      activity: { ...state.activity, action },
    });
    expect(companionYields(at("click"), false)).toBe(true);
    expect(companionYields(at("type"), false)).toBe(true);
    // Ordinary typing with no run, or a finished run, never fades her.
    expect(companionYields(at("idle"), false)).toBe(false);
    expect(companionYields(at("complete"), false)).toBe(false);
    expect(companionYields(at("error"), false)).toBe(false);
    // The human is on the character itself, or not active at all.
    expect(companionYields(at("click"), true)).toBe(false);
    expect(
      companionYields({ ...at("click"), control: { ...control, userActive: false } }, false),
    ).toBe(false);
  });
});
