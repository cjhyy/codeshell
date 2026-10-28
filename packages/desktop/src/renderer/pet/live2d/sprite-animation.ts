import type { MimiCompanionState } from "../../../shared/mimi-companion";

export const SPRITE_ANIMATIONS = {
  idle: { row: 0, frames: 6 },
  right: { row: 1, frames: 8 },
  left: { row: 2, frames: 8 },
  waving: { row: 3, frames: 4 },
  typing: { row: 3, frames: 4 },
  jumping: { row: 4, frames: 5 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 6 },
} as const;

export function spriteAnimation(
  state: MimiCompanionState,
  moving: "left" | "right" | null,
  cueActive = true,
): keyof typeof SPRITE_ANIMATIONS {
  if (moving) return moving;
  if (!cueActive) return "idle";
  if (state.activity.action === "error") return "failed";
  switch (state.activity.action) {
    case "observe":
      return "review";
    case "click":
    case "key":
      return "waving";
    case "type":
      return "typing";
    case "scroll":
    case "working":
    case "drag":
      return "running";
    default:
      return "idle";
  }
}

/** One-shot gesture budget. Typing instead follows the operation's start/end. */
export function companionCueDuration(state: MimiCompanionState): number {
  return state.activity.action === "idle"
    ? 0
    : Math.min(800, SPRITE_ANIMATIONS[spriteAnimation(state, null)].frames * 100);
}
