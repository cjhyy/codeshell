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
/** Key-pose characters fly: about twice the pace, so they reach farther in time. */
export const FLY_MIN_MS = 160;
export const FLY_MAX_MS = 420;
const FLY_MS_PER_POINT = 0.28;
const FLY_HOP_DISTANCE = 1800;

/** How the character travels between two host placements. Execution never
 * waits for it, so long trips hop rather than lag behind the real action. */
export function companionLocomotion(
  from: Point | undefined,
  to: Point,
  options: { reducedMotion: boolean; immediate: boolean; pace?: "walk" | "fly" },
): CompanionLocomotion {
  if (!from || options.reducedMotion || options.immediate) return { kind: "none" };
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance < 4) return { kind: "none" };
  const fly = options.pace === "fly";
  if (distance > (fly ? FLY_HOP_DISTANCE : HOP_DISTANCE)) return { kind: "hop", duration: HOP_MS };
  const [min, max, perPoint] = fly
    ? [FLY_MIN_MS, FLY_MAX_MS, FLY_MS_PER_POINT]
    : [WALK_MIN_MS, WALK_MAX_MS, WALK_MS_PER_POINT];
  return {
    kind: "walk",
    duration: Math.round(Math.min(max, Math.max(min, distance * perPoint))),
    facing: dx < 0 ? "left" : "right",
  };
}
