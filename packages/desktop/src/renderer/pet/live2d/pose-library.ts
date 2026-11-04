import { companionFeetOffset, type MimiCompanionState } from "../../../shared/mimi-companion";
import { packFacesLeft } from "./character-pack";

/**
 * Key poses: one large illustration per moment, held and swapped every few
 * hundred milliseconds instead of looping a small cycle. Each pose is drawn for
 * a surface (a window's top edge, a control's baseline, mid-air) and declares
 * where it touches that surface, so the stage model's feet line lands on it.
 */
export const POSE_NAMES = [
  "stand",
  "look",
  "point",
  "kick",
  "stomp",
  "dash",
  "sit-ledge",
  "lie-ledge",
  "cheer",
  "fail",
] as const;
export type PoseName = (typeof POSE_NAMES)[number];

/**
 * What makes one character feel like herself, beyond the shared moments: a
 * library may add its own poses (a piano, a snack) and name them here. Every
 * list is optional; a character without behaviors plays the shared moments.
 */
export interface PoseBehaviors {
  /** At rest, one of these now and then, held for a few seconds. */
  idle?: string[];
  /** While the pointer rests on her (not dragging). */
  hover?: string[];
  /** Alternatives to `cheer` when a run completes. */
  complete?: string[];
  /** Alternatives to `fail` on an error. */
  error?: string[];
}

export const POSE_BEHAVIOR_KEYS = ["idle", "hover", "complete", "error"] as const;

export interface Pose {
  file: string;
  width: number;
  height: number;
  /** Head height in image pixels; sizes every pose to the same head. */
  head: number;
  /** Image pixel that rests on the feet line: feet, seat or belly. */
  anchor: { x: number; y: number };
  /** "right" art is mirrored to face a target on the left. */
  facing: "front" | "right";
  /** Image pixel that strikes the target (a sole, a fingertip). While the
   * action lands, the pose is drawn so this pixel is on the target. */
  contact?: { x: number; y: number };
  /** Sound-effect word shown when the pose makes contact, or when a behavior pose appears. */
  sfx?: string;
}

export interface PoseLibrary {
  version: 1;
  /** Drawn head height as a fraction of the character box height. */
  head: number;
  /** On a control the stage model shrinks the box; key poses stay larger so a
   * kick or a pointing hand reaches the control. */
  surfaceScale: number;
  /** Shared moments by `PoseName`, plus the character's own behavior poses. */
  poses: Partial<Record<string, Pose>>;
  behaviors?: PoseBehaviors;
}

const positive = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;

/** Strict: a library that does not fit its own images is a build error. */
export function parsePoseLibrary(raw: unknown): PoseLibrary {
  const library = raw as PoseLibrary;
  if (!library || library.version !== 1) throw new Error("pose library: version 1 is required");
  if (!positive(library.head, 1) || !positive(library.surfaceScale, 3))
    throw new Error("pose library: invalid scale");
  const behaviors = library.behaviors ?? {};
  if (typeof behaviors !== "object") throw new Error("pose library: invalid behaviors");
  const named = new Set<string>(POSE_NAMES);
  for (const [key, list] of Object.entries(behaviors)) {
    if (!(POSE_BEHAVIOR_KEYS as readonly string[]).includes(key) || !Array.isArray(list))
      throw new Error(`pose library: invalid behavior ${key}`);
    for (const name of list as unknown[]) {
      if (typeof name !== "string" || !/^[a-z][a-z-]{0,23}$/.test(name) || !library.poses?.[name])
        throw new Error(`pose library: behavior ${key} names a missing pose`);
      named.add(name);
    }
  }
  const poses: PoseLibrary["poses"] = {};
  for (const [name, pose] of Object.entries(library.poses ?? {}) as Array<[string, Pose]>) {
    // A pose is either a shared moment or one the character's behaviors use.
    if (!named.has(name)) throw new Error(`pose library: unknown pose ${name}`);
    if (
      typeof pose.file !== "string" ||
      !positive(pose.width, 4096) ||
      !positive(pose.height, 4096) ||
      !positive(pose.head, pose.height) ||
      !(pose.anchor?.x >= 0 && pose.anchor.x <= pose.width) ||
      !(pose.anchor?.y >= 0 && pose.anchor.y <= pose.height) ||
      (pose.facing !== "front" && pose.facing !== "right") ||
      (pose.contact !== undefined &&
        !(
          pose.contact.x >= 0 &&
          pose.contact.x <= pose.width &&
          pose.contact.y >= 0 &&
          pose.contact.y <= pose.height
        )) ||
      (pose.sfx !== undefined && (typeof pose.sfx !== "string" || pose.sfx.length > 8))
    )
      throw new Error(`pose library: invalid pose ${name}`);
    poses[name] = pose;
  }
  return { ...library, poses };
}

/** One of the character's poses for `behavior`, chosen by `seed` (any number). */
export function poseBehavior(
  library: PoseLibrary,
  behavior: keyof PoseBehaviors,
  seed: number,
): string | undefined {
  const list = library.behaviors?.[behavior];
  if (!list?.length) return undefined;
  return list[Math.abs(Math.floor(seed)) % list.length];
}

/** A stable number for a string, so a beat keeps the variant it started with. */
export function poseSeed(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++)
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  return hash;
}

/** The pose for this moment, or undefined when the library has none for it. */
export function posePick(
  library: PoseLibrary,
  state: MimiCompanionState,
  cueActive: boolean,
  moving: "left" | "right" | null,
): string | undefined {
  const has = (name: PoseName) => (library.poses[name] ? name : undefined);
  // A variant for this beat: the shared pose counts as one of the choices.
  const variant = (behavior: "complete" | "error", shared: PoseName) => {
    const own = library.behaviors?.[behavior] ?? [];
    const choices = [...(has(shared) ? [shared] : []), ...own];
    return choices.length
      ? choices[Math.abs(poseSeed(state.activity.id)) % choices.length]
      : undefined;
  };
  if (moving) return has("dash");
  const ledge = state.perch === "title-bar" || state.perch === "on-field";
  if (!cueActive) {
    if (state.perch === "title-bar") return has("lie-ledge") ?? has("stand");
    if (state.perch === "on-field") return has("sit-ledge") ?? has("stand");
    return has("stand");
  }
  switch (state.activity.action) {
    case "type":
    case "key":
      return ledge ? (has("sit-ledge") ?? has("stand")) : (has("point") ?? has("stand"));
    case "click":
      if (state.perch === "on-field") return has("sit-ledge") ?? has("stomp");
      if (state.element === "link") return has("point") ?? has("stand");
      if (state.element === "button") return has("kick") ?? has("stomp");
      return has("stomp") ?? has("point");
    case "observe":
      return ledge ? (has("lie-ledge") ?? has("look")) : (has("look") ?? has("stand"));
    case "scroll":
    case "working":
      return has("look") ?? has("stand");
    case "drag":
      return has("dash") ?? has("point");
    case "complete":
      return variant("complete", "cheer") ?? has("stand");
    case "error":
      return variant("error", "fail") ?? has("stand");
    default:
      return state.perch === "title-bar" ? (has("lie-ledge") ?? has("stand")) : has("stand");
  }
}

/** Faces the target, or the direction of travel while moving. */
export function poseFacesLeft(state: MimiCompanionState, moving: "left" | "right" | null): boolean {
  return moving ? moving === "left" : packFacesLeft(state);
}

/**
 * Place `pose` so its anchor sits on the box's feet line, centred in the box.
 * While a striking pose lands (`striking`), its contact pixel is put on the
 * target instead: the sole meets the button, whatever that does to the feet.
 * `size` is the box height; the box is 0.7× as wide (see the stage model).
 */
export function poseLayout(
  library: PoseLibrary,
  pose: Pose,
  state: Pick<MimiCompanionState, "size" | "perch" | "position" | "target">,
  facesLeft: boolean,
  striking = false,
) {
  const { size } = state;
  const surface = state.perch === "on-field" || state.perch === "on-baseline";
  const k = (size * library.head * (surface ? library.surfaceScale : 1)) / pose.head;
  const flip = pose.facing === "right" && facesLeft;
  const mirror = (x: number) => (flip ? pose.width - x : x);
  const contact = striking && state.target ? pose.contact : undefined;
  const pin = contact ?? pose.anchor;
  const pinX = mirror(pin.x);
  const at =
    contact && state.target
      ? { x: state.target.x - state.position.x, y: state.target.y - state.position.y }
      : { x: (size * 0.7) / 2, y: size - companionFeetOffset(size) };
  return {
    width: pose.width * k,
    height: pose.height * k,
    left: at.x - pinX * k,
    bottom: size - at.y - (pose.height - pin.y) * k,
    flip,
    /** The pinned pixel inside the drawn image, for scaling about it. */
    origin: `${(pinX / pose.width) * 100}% ${(pin.y / pose.height) * 100}%`,
  };
}
