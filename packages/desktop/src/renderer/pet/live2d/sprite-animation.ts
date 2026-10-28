import type { MimiCompanionState } from "../../../shared/mimi-companion";

export const SPRITE_ANIMATIONS = {
  idle: { row: 0, frames: 6 },
  right: { row: 1, frames: 8 },
  left: { row: 2, frames: 8 },
  waving: { row: 3, frames: 4 },
  jumping: { row: 4, frames: 5 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 6 },
} as const;

export function spriteAnimation(
  state: MimiCompanionState,
  moving: "left" | "right" | null,
): keyof typeof SPRITE_ANIMATIONS {
  if (state.activity.action === "error") return "failed";
  if (moving) return moving;
  if (state.activity.action === "idle" && state.activity.phase === "end") return "waiting";
  switch (state.activity.action) {
    case "observe":
      return "review";
    case "click":
    case "key":
      return "waving";
    case "type":
    case "scroll":
    case "working":
      return "running";
    case "drag":
      return state.target && state.target.x < state.position.x ? "left" : "right";
    default:
      return "idle";
  }
}
