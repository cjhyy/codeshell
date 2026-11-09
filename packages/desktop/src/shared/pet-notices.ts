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
}

export interface PetNoticesState {
  channels: PetNoticeChannel[];
  systemRule: PetNoticeSystemRule;
  settings: PetNotificationSettingsView;
}

/** The bell of one work Session: whether an owner or delegation rule watches it. */
export interface PetSessionBellState {
  on: boolean;
  ruleId?: string;
  /** The rule's channel ("auto", "desktop" or an IM id). */
  channel?: string;
  /** The IM the notice is predicted to use; absent → a desktop notification. */
  imLabel?: string;
  ready?: PetNoticeChannelReadiness;
}

/** Bounds of the editable settings; main's settings schema enforces the same. */
export const PET_NOTIFICATION_MAX_PER_HOUR_RANGE = { min: 1, max: 60 } as const;
