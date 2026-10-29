import type { ComponentType } from "react";
import type { MimiCompanionAction, MimiCompanionState } from "../../../shared/mimi-companion";

/** One presentation contract for sprite, Live2D and future authored effect sets. */
export interface CharacterActorProps {
  state: MimiCompanionState;
  reducedMotion: boolean;
  moving: "left" | "right" | null;
  cueActive: boolean;
  onReady(): void;
  onError(message: string): void;
}

/** What an appearance can actually perform. CUA never depends on it: a
 * missing action degrades through `fallback`, then to idle. */
export interface EffectSet {
  kind: "sprite" | "live2d";
  supports: ReadonlySet<MimiCompanionAction>;
  fallback: Partial<Record<MimiCompanionAction, MimiCompanionAction>>;
  /** Actions that loop while their operation runs; the rest play once. */
  loop: ReadonlySet<MimiCompanionAction>;
}

export interface CharacterRenderer {
  id: MimiCompanionState["appearance"];
  label: string;
  Actor: ComponentType<CharacterActorProps>;
  effects: EffectSet;
}

/** Resolve an action to one the effect set supports, never inventing motion. */
export function effectAction(set: EffectSet, action: MimiCompanionAction): MimiCompanionAction {
  let current = action;
  for (let hops = 0; hops < 4; hops++) {
    if (set.supports.has(current)) return current;
    const next = set.fallback[current];
    if (!next) break;
    current = next;
  }
  return "idle";
}

const ALL_ACTIONS: readonly MimiCompanionAction[] = [
  "idle",
  "observe",
  "click",
  "type",
  "scroll",
  "drag",
  "key",
  "working",
  "complete",
  "error",
];

/** The bundled sprite atlas has a row for every action (see sprite-animation). */
export const SPRITE_EFFECTS: EffectSet = {
  kind: "sprite",
  supports: new Set(ALL_ACTIONS),
  fallback: {},
  loop: new Set(["type", "key", "working", "scroll", "drag"]),
};

/** The sample Live2D model is driven by authored parameters (companion-pose):
 * gaze, reach, hand pulse, lean and concern. Other actions fall back. */
export const LIVE2D_EFFECTS: EffectSet = {
  kind: "live2d",
  supports: new Set(["idle", "observe", "click", "type", "scroll", "drag", "error"]),
  fallback: { key: "type", working: "observe", complete: "idle" },
  loop: new Set(["type", "scroll", "drag"]),
};
