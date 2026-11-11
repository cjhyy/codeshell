/**
 * Renderer-facing shapes for Mimi's notice rules: the Session bell, the
 * "every Session" system rule and the `pet.notifications` settings view.
 * Main validates every request; these are the payloads it returns.
 */

export type PetNoticeEvent = "done" | "failed" | "blocked";
/** An IM gateway channel's readiness, as the gateway reports it. */
export type PetNoticeChannelReadiness = "ready" | "unknown" | "unavailable";

export interface PetNoticeChannel {
  id: string;
  label: string;
  ready: PetNoticeChannelReadiness;
}

export interface PetNoticeSystemRule {
  state: "active" | "paused";
  /** "auto", "desktop", or an IM channel id. */
  channel: string;
  events: PetNoticeEvent[];
}

export type PetNoticeSystemRulePatch = Partial<PetNoticeSystemRule>;

/**
 * `settings.pet.notifications` with host defaults applied. `quietHours` keeps
 * its times while switched off so the form can switch it back on unchanged.
 */
export interface PetNotificationSettingsView {
  quietHours: { enabled: boolean; start: string; end: string };
  maxPerHour: number;
  maxP0PerHour: number;
  mergeWindowSec: number;
  presenceIdleSec: number;
  delegatedFromDesktop: "auto" | "desktop";
  /** Morning brief and evening wrap-up: each on/off and its local "HH:MM" (always filled by main). */
  briefs?: { morning: PetBriefSetting; evening: PetBriefSetting };
  /** Mimi's heartbeat: every 30 min within active hours, never in quiet hours. */
  heartbeat?: { enabled: boolean; activeHours: { start: string; end: string } };
  /** Fixed local times the digest goes out at, sorted; empty: as soon as allowed. */
  digestSlots?: string[];
}

export interface PetBriefSetting {
  enabled: boolean;
  time: string;
}

/** Where the briefs and the heartbeat stand today (read-only; counts reset at local midnight). */
export interface PetProactiveStatus {
  briefs: Record<"morning" | "evening", { lastSentDay?: string }>;
  heartbeat: {
    judgedToday: number;
    saidToday: number;
    judgeCap: number;
    sayCap: number;
    atJudgeCap: boolean;
    atSayCap: boolean;
  };
}

export interface PetNoticesState {
  channels: PetNoticeChannel[];
  systemRule: PetNoticeSystemRule;
  settings: PetNotificationSettingsView;
  /** Present once main's proactive rules are running. */
  proactive?: PetProactiveStatus;
}

/**
 * The bell of one work Session. `available: false` means main does not watch
 * this Session (Mimi's own, an external runtime, unknown): the bell is hidden.
 * `origin` says whose rule the bell shows: the owner's own ("user") can be
 * switched off; Mimi's delegation rule alone ("delegation") is read-only.
 */
export interface PetSessionBellState {
  available: boolean;
  on: boolean;
  origin?: "user" | "delegation";
  /** A delegation rule from Mimi also watches this Session (it stays after the bell is off). */
  delegated: boolean;
  ruleId?: string;
  /** The rule's channel ("auto", "desktop" or an IM id). */
  channel?: string;
  /** The IM the notice is predicted to use; absent → a desktop notification. */
  imLabel?: string;
  ready?: PetNoticeChannelReadiness;
  /**
   * An active rule of this Session asks for its "done" outcome: main's notice
   * router reports a finished turn, so the renderer adds no notification.
   * Absent when the rules only watch failures or blocks.
   */
  watchesDone?: boolean;
  /**
   * A rule of this Session fired within the last minute: main is already
   * telling the owner about that outcome (the renderer adds no notification).
   */
  firedRecently?: boolean;
}

/** Bounds of the editable settings; main's settings schema enforces the same. */
export const PET_NOTIFICATION_MAX_PER_HOUR_RANGE = { min: 1, max: 60 } as const;
export const PET_NOTIFICATION_MAX_P0_PER_HOUR_RANGE = { min: 1, max: 120 } as const;
export const PET_NOTIFICATION_MERGE_WINDOW_SEC_RANGE = { min: 0, max: 3_600 } as const;
export const PET_NOTIFICATION_PRESENCE_IDLE_SEC_RANGE = { min: 30, max: 1_800 } as const;
