import type { MimiAppearance } from "./mimi-companion.js";

/**
 * One Mimi on the desktop. The user has a single "show Mimi" switch; once shown,
 * Mimi is either docked (the compact pet widget) or moving (the full character
 * that walks to computer-use targets). Both forms are owned by one controller in
 * the Desktop main process and are never visible at the same time.
 *
 * "Moving" is the desktop companion character. It is unrelated to the phone UI.
 */
export type MimiPresenceMode = "docked" | "moving";

/** What a caller may change. Everything else is derived by the owner. */
export interface MimiPresencePatch {
  visible?: boolean;
  mode?: MimiPresenceMode;
  /** Moving character box height in DIP. */
  size?: number;
  /** Which character plays the moving form. */
  appearance?: MimiAppearance;
}

/** Actual state as published by the owner. UI must render this, not its own guess. */
export interface MimiPresenceSnapshot {
  /** The user's switch. Persisted; restored on next launch. */
  visible: boolean;
  /** The user's preferred form. Kept even while moving is unavailable. */
  mode: MimiPresenceMode;
  size: number;
  appearance: MimiAppearance;
  /** The form the owner is presenting given availability and failures. */
  effectiveMode: MimiPresenceMode;
  /** The form that is presented right now, or null while none is (or none yet). */
  shown: MimiPresenceMode | null;
  movingAvailable: boolean;
  /** Why moving cannot be used here (platform, gate or setup failure). */
  movingUnavailableReason?: string;
  /** The moving surface failed at runtime; Mimi fell back to docked until retried. */
  movingError?: string;
  /** The docked surface failed to load or crashed. */
  dockedError?: string;
  /** A settings preview of the moving character is running. */
  previewing: boolean;
}

export function isMimiPresenceMode(value: unknown): value is MimiPresenceMode {
  return value === "docked" || value === "moving";
}

/** The docked widget's panels, also offered beside moving Mimi as her bubble. */
export type MimiBubblePanel = "chat" | "activity";

/** What the moving form's bubble is asked to show; `null` closes it. */
export interface MimiBubbleOpenRequest {
  panel: MimiBubblePanel | null;
  /** Placed in the composer; sent at once only when `send` is set. */
  prompt?: string;
  /** The user already asked for this (e.g. accepted "look at this window"). */
  send?: boolean;
}
