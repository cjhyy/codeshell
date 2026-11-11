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
  /**
   * Every trigger that can fire (design §4): the owner's and Mimi's Session
   * rules, follow-ups, and Mimi's own system rules, plus the most recently
   * ended ones. Absent from builds before the rule list.
   */
  rules?: PetNoticeRuleSummary[];
}

/** What kind of trigger a rule is, as the rule list groups it. */
export type PetNoticeRuleKind =
  | "session"
  | "all-sessions"
  | "schedule"
  | "system-brief"
  | "system-heartbeat";

/**
 * Who set the rule up (structured, from the rule's `createdBy`; never read
 * from prose): the owner in a Session (bell / "tell me when done"), Mimi's
 * delegation, an IM chat watching the Session, an owner-asked follow-up, or
 * Mimi's own system rule.
 */
export type PetNoticeRuleSource = "owner" | "delegation" | "watch" | "follow-up" | "system";

export type PetNoticeRuleState = "active" | "paused" | "spent" | "completed" | "cancelled";

export type PetNoticeRuleAction = "pause" | "resume" | "cancel";

/** Where a rule's notice goes. Never carries a raw conversation or sender id. */
export type PetNoticeRuleTarget =
  /** Desktop only. */
  | { kind: "desktop" }
  /** At the computer: desktop; away: the IM predicted by `label` (absent: desktop only). */
  | { kind: "auto"; label?: string; ready?: PetNoticeChannelReadiness }
  /** An IM channel the owner named. */
  | { kind: "channel"; label: string; ready?: PetNoticeChannelReadiness }
  /** Back to the IM conversation that asked (a chat watching, an IM delegation). */
  | { kind: "chat"; label: string; direct: boolean };

export interface PetNoticeRuleSchedule {
  /** One-shot instant (epoch ms). */
  at?: number;
  /** Recurring 5-field cron (shown as a tooltip only). */
  cron?: string;
  /** Mimi's words for a recurring schedule ("工作日 09:00"): untrusted display text. */
  label?: string;
  timezone: string;
  /** When it fires next (epoch ms); absent when paused, ended or already fired. */
  nextAt?: number;
}

/** One row of the rule list. Display data only; main decides what each action does. */
export interface PetNoticeRuleSummary {
  id: string;
  /** Optimistic-concurrency token for `updateNoticeRule` (0: never stored). */
  version: number;
  kind: PetNoticeRuleKind;
  state: PetNoticeRuleState;
  source: PetNoticeRuleSource;
  /** The watched Session (Session rules), or the one a follow-up continues. */
  sessionId?: string;
  sessionTitle?: string;
  /** Follow-up: the title Mimi wrote for it (untrusted display text). */
  title?: string;
  /** Follow-up: only remind, or continue the Session first. */
  followUp?: "remind" | "continue";
  brief?: "morning" | "evening";
  /** Brief: its local "HH:MM", every day. */
  dailyAt?: string;
  events?: PetNoticeEvent[];
  scope?: "turn" | "goal";
  schedule?: PetNoticeRuleSchedule;
  /** Heartbeat: the local window it looks in. */
  activeHours?: { start: string; end: string };
  target: PetNoticeRuleTarget;
  lastFiredAt?: number;
  lastOutcome?: "notified" | "launched" | "failed" | "unknown";
  /**
   * A paused one-shot whose time passed while paused: resuming it fires at
   * once (`catch-up`), or it is past its catch-up window (`expired`: delete only).
   */
  overdue?: "catch-up" | "expired";
  /** What the owner may do with it now. */
  actions: PetNoticeRuleAction[];
  updatedAt: number;
}

export interface PetNoticeRuleUpdate {
  ruleId: string;
  expectedVersion: number;
  action: PetNoticeRuleAction;
}

export type PetNoticeRuleUpdateResult =
  | { ok: true; rule?: PetNoticeRuleSummary }
  | {
      ok: false;
      /**
       * `version_conflict`: changed meanwhile (the list refreshes);
       * `not_found`: gone; `not_allowed`: this action does not apply to it now
       * (an ended rule, a second active rule for the same Session and target).
       */
      reason: "version_conflict" | "not_found" | "not_allowed";
      rule?: PetNoticeRuleSummary;
    };

/** At most this many recently ended rules are listed (newest first). */
export const PET_NOTICE_ENDED_RULES_LIMIT = 20;
/** At most this many digest slots (`pet.notifications.digestSlots`). */
export const PET_NOTIFICATION_DIGEST_SLOTS_MAX = 6;

/**
 * The bell of one work Session. `available: false` means main does not watch
 * this Session (Mimi's own, an external runtime, unknown): the bell is hidden.
 * `origin` says whose rule the bell shows: the owner's own ("user") can be
 * switched off; Mimi's delegation rule alone ("delegation") or an IM chat
 * watching it alone ("watch") is read-only.
 */
export interface PetSessionBellState {
  available: boolean;
  on: boolean;
  origin?: "user" | "delegation" | "watch";
  /**
   * Who set up this Session's active rules, owner first: the bell's tooltip
   * says each, so a chat's watch never reads as the owner's own.
   */
  sources?: Array<"owner" | "delegation" | "watch">;
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
