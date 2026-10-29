type Point = { x: number; y: number };

export type CompanionLocomotion =
  | { kind: "none" }
  /** Walk there, facing the direction of travel, in `duration` ms. */
  | { kind: "walk"; duration: number; facing: "left" | "right" }
  /** Too far to walk legibly before the action lands: vanish and reappear. */
  | { kind: "hop"; duration: number };

/** Walking pace and limits, in logical points and milliseconds. */
export const WALK_MIN_MS = 280;
export const WALK_MAX_MS = 760;
const WALK_MS_PER_POINT = 0.55;
/** Beyond this the walk would still be under way when the action lands. */
export const HOP_DISTANCE = 900;
export const HOP_MS = 220;

/** How the character travels between two host placements. Execution never
 * waits for it, so long trips hop rather than lag behind the real action. */
export function companionLocomotion(
  from: Point | undefined,
  to: Point,
  options: { reducedMotion: boolean; immediate: boolean },
): CompanionLocomotion {
  if (!from || options.reducedMotion || options.immediate) return { kind: "none" };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 4) return { kind: "none" };
  if (distance > HOP_DISTANCE) return { kind: "hop", duration: HOP_MS };
  return {
    kind: "walk",
    duration: Math.round(
      Math.min(WALK_MAX_MS, Math.max(WALK_MIN_MS, distance * WALK_MS_PER_POINT)),
    ),
    facing: dx < 0 ? "left" : "right",
  };
}
