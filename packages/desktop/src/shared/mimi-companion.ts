/** Presentation only. Neither this state nor the companion renderer can issue computer input. */
export type MimiCompanionAction =
  | "idle"
  | "observe"
  | "click"
  | "type"
  | "scroll"
  | "drag"
  | "key"
  | "working"
  /** The whole run that used the computer completed. Never per tool call. */
  | "complete"
  | "error";

/** Where the character stands relative to the window it is working in. */
export type MimiCompanionPerch =
  | "title-bar"
  | "beside-target"
  | "screen-corner"
  /** Sitting on the top edge of the field receiving text. */
  | "on-field"
  /** Standing beside a control, feet on its bottom edge. */
  | "on-baseline";
/** Category of the control an action lands on; never its label or value. */
export type MimiCompanionElement =
  | "text"
  | "button"
  | "link"
  | "menu"
  | "list"
  | "scroll"
  | "other";

/** Work Mimi is keeping track of, as counts only: a badge over the moving character. */
export interface MimiCompanionAttention {
  running: number;
  needsAction: number;
  unread: number;
}

/** The character box in global DIP, so the shared bubble can open beside it. */
export interface MimiCompanionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MimiCompanionSettings {
  enabled: boolean;
  size: number;
  available: boolean;
  appearance: MimiAppearance;
  error?: string;
}

export interface MimiCompanionState {
  enabled: boolean;
  visible: boolean;
  size: number;
  /** The size the user chose; `size` can be smaller while she works on a control. */
  chosenSize?: number;
  appearance: MimiAppearance;
  position: { x: number; y: number };
  windowOrigin?: { x: number; y: number };
  humanActive?: boolean;
  /** Relocate immediately instead of easing across a field receiving input. */
  avoidInput?: boolean;
  pinned?: boolean;
  target?: { x: number; y: number };
  perch?: MimiCompanionPerch;
  /** Mimi was dropped on this app's window: offer to look at it in the chat. */
  handoff?: { app: string };
  /** Control category under the current gesture, for an apt motion. */
  element?: MimiCompanionElement;
  activity: {
    id: string;
    action: MimiCompanionAction;
    phase: "start" | "end";
    startedAt: number;
  };
  preview: boolean;
  attention?: MimiCompanionAttention;
  /** Execution gate as the user should see it. The character cannot enforce it. */
  control?: {
    stopped: boolean;
    foregroundHeld: boolean;
    userActive: boolean;
  };
}

export interface MimiCompanionApi {
  getState(): Promise<MimiCompanionState>;
  onState(listener: (state: MimiCompanionState) => void): () => void;
  ready(result?: { error?: string }): void;
  interaction(phase: "hover" | "leave" | "begin" | "end"): void;
  move(position: { x: number; y: number }): void;
  openChat(): Promise<void>;
  /** Open the shared bubble on its work list (the badge was clicked). */
  openActivity(): Promise<void>;
  /** Answer the drop offer; acceptance opens the chat with a draft, unsent. */
  handoff(accept: boolean): Promise<void>;
  resumeFollowing(): void;
  /** Ask the single Mimi presence owner to dock the character or close Mimi. */
  presence(action: "dock" | "close"): void;
  /** Ask the presence owner to resize the character (persisted like the settings page). */
  resize(size: number): void;
  /** Ask the execution side to refuse all computer input until resumed. */
  stopComputer(): void;
  resumeComputer(): void;
}

/**
 * Which character plays the moving form. Sprite characters share the stage
 * model and the move set (see the character pack guideline).
 */
export const MIMI_APPEARANCES = ["mimi-sprite", "shiro-sprite", "maki-sprite"] as const;
export type MimiAppearance = (typeof MIMI_APPEARANCES)[number];
export const MIMI_DEFAULT_APPEARANCE: MimiAppearance = "mimi-sprite";

export function isMimiAppearance(value: unknown): value is MimiAppearance {
  return (MIMI_APPEARANCES as readonly unknown[]).includes(value);
}

/** Character box height in DIP (logical pixels); the box is 0.7× as wide. */
export const MIMI_COMPANION_DEFAULT_SIZE = 200;
export const MIMI_COMPANION_MIN_SIZE = 160;
export const MIMI_COMPANION_MAX_SIZE = 480;
export const MIMI_COMPANION_SIZE_OPTIONS = [160, 200, 240, 320, 400, 480] as const;
/** The default before 2026-11: a saved 320 cannot be told apart from "never changed". */
export const MIMI_COMPANION_LEGACY_DEFAULT_SIZE = 320;
/** Named sizes: the same name means the same height in the menu and in settings. */
export type MimiCompanionSizeName = "small" | "default" | "large" | "largest";
export const MIMI_COMPANION_SIZE_NAMES: Readonly<Record<number, MimiCompanionSizeName>> = {
  160: "small",
  [MIMI_COMPANION_DEFAULT_SIZE]: "default",
  320: "large",
  [MIMI_COMPANION_MAX_SIZE]: "largest",
};
/** The character menu's quick sizes, a subset of the settings list (which keeps all). */
export const MIMI_COMPANION_QUICK_SIZES = [
  { name: "small", size: 160 },
  { name: "default", size: MIMI_COMPANION_DEFAULT_SIZE },
  { name: "large", size: 320 },
] as const satisfies ReadonlyArray<{ name: MimiCompanionSizeName; size: number }>;
/** Drawn height of the working (scaled-down) character never goes below this. */
export const MIMI_COMPANION_MIN_WORKING_SIZE = 96;

/** The sprite is drawn this far above the bottom of the character box, which
 * leaves room for the action label underneath. */
export const COMPANION_SPRITE_BOTTOM = 25;
/** Atlas cells are 192x208 with the feet on y=203. */
export const COMPANION_CELL = { width: 192, height: 208, feetY: 203 } as const;

/** Distance from the bottom of a character box `height` tall to the feet:
 * the sprite is 70% of the box wide, so the cell's own margin scales with it. */
export function companionFeetOffset(height: number): number {
  const sprite = (height * 0.7 * COMPANION_CELL.height) / COMPANION_CELL.width;
  return (
    COMPANION_SPRITE_BOTTOM +
    (sprite * (COMPANION_CELL.height - COMPANION_CELL.feetY)) / COMPANION_CELL.height
  );
}

export function companionSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MIMI_COMPANION_DEFAULT_SIZE;
  return Math.max(MIMI_COMPANION_MIN_SIZE, Math.min(MIMI_COMPANION_MAX_SIZE, Math.round(value)));
}
