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
export type MimiCompanionPerch = "title-bar" | "beside-target" | "screen-corner";
/** Category of the control an action lands on; never its label or value. */
export type MimiCompanionElement =
  | "text"
  | "button"
  | "link"
  | "menu"
  | "list"
  | "scroll"
  | "other";

export interface MimiCompanionSettings {
  enabled: boolean;
  size: number;
  available: boolean;
  appearance: "mimi-sprite" | "live2d";
  error?: string;
}

export interface MimiCompanionState {
  enabled: boolean;
  visible: boolean;
  size: number;
  appearance: "mimi-sprite" | "live2d";
  modelUrl: string;
  coreUrl: string;
  position: { x: number; y: number };
  windowOrigin?: { x: number; y: number };
  humanActive?: boolean;
  /** Relocate immediately instead of easing across a field receiving input. */
  avoidInput?: boolean;
  pinned?: boolean;
  target?: { x: number; y: number };
  perch?: MimiCompanionPerch;
  /** Control category under the current gesture, for an apt motion. */
  element?: MimiCompanionElement;
  activity: {
    id: string;
    action: MimiCompanionAction;
    phase: "start" | "end";
    startedAt: number;
  };
  preview: boolean;
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
  resumeFollowing(): void;
  /** Ask the execution side to refuse all computer input until resumed. */
  stopComputer(): void;
  resumeComputer(): void;
}

export const MIMI_COMPANION_SCHEME = "csmimi";
export const MIMI_COMPANION_DEFAULT_SIZE = 320;

export function companionSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return MIMI_COMPANION_DEFAULT_SIZE;
  return Math.max(200, Math.min(480, Math.round(value)));
}
