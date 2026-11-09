import type {
  NoticeAttention,
  NoticeChannel,
  NoticeChannelReadiness,
} from "@cjhyy/code-shell-pet/protocol";

/** Readiness of one bound IM gateway channel; same values as the rule protocol. */
export type ImReadiness = NoticeChannelReadiness;

export type NoticePriority = "P0" | "P1" | "P2";

export const DEFAULT_MAX_PER_HOUR = 6;
export const DEFAULT_MAX_P0_PER_HOUR = 12;

export interface RouteNotice {
  /** P0 needs the owner's decision, P1 is a result / follow-up, P2 a greeting / digest. */
  priority: NoticePriority;
  dedupeKey: string;
  attention: NoticeAttention;
  channel: NoticeChannel;
  /** Only the all-sessions system rule matched: notify only while the owner is away. */
  requiresAway?: boolean;
}

/** What the policy needs from the dedupe index; a `ReadonlySet<string>` satisfies it. */
export interface DedupeLookup {
  has(dedupeKey: string): boolean;
}

export interface RouteState {
  now: number;
  present: boolean;
  /**
   * Local wall-clock "HH:MM" window, half-open [start, end). May cross
   * midnight (start > end). start === end, null, or a malformed time disables it.
   */
  quietHours: { start: string; end: string } | null;
  /**
   * Minutes EAST of UTC for the owner's local time at `now` (UTC+8 → 480).
   * The caller passes `-new Date(now).getTimezoneOffset()` per decision, so
   * DST is handled by sampling the offset at the instant being routed.
   */
  timezoneOffsetMin: number;
  /** P1/P2 IM sends in the current local clock hour. */
  sentThisHour: number;
  /** P0 IM sends in the current local clock hour. */
  p0SentThisHour: number;
  maxPerHour: number;
  maxP0PerHour: number;
  seenDedupeKeys: DedupeLookup;
  /** Bound IM channels in display order (string keys; insertion order is the order). */
  imReady: Readonly<Record<string, ImReadiness>>;
  /** The channel the owner last used to message Mimi. */
  lastInboundChannel?: string;
}

/** Stable, machine-readable reasons; callers and logs may switch on these. */
export type RouteReason =
  | "duplicate"
  | "muted"
  | "digest-attention"
  | "p0-cap"
  | "quiet-hours"
  | "hourly-cap"
  /** Router-only: a P1 for a Session that already got an IM within the merge window. */
  | "merge-window"
  /** Router-only: the router was disposed; nothing was recorded or sent. */
  | "disposed"
  | "desktop-channel"
  | "named-im"
  | "im-unbound"
  | "im-unavailable-queued"
  | "present-desktop"
  | "requires-away-present"
  | "away-last-inbound"
  | "away-first-ready"
  | "no-im-available";

export interface RouteDecision {
  /**
   * - im: send to `im` only; both: send to `im` and show on the desktop;
   * - desktop: show on the desktop; digest: hold for the next digest;
   * - record: keep in the ledger only; drop: do nothing (already handled).
   */
  outlet: "im" | "desktop" | "both" | "digest" | "record" | "drop";
  im?: string;
  /** An IM send to `im` was wanted but is impossible now; the router queues it. */
  queued?: boolean;
  reason: RouteReason;
}

const MINUTES_PER_DAY = 24 * 60;
const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/u;

function parseClock(value: string): number | undefined {
  const match = HH_MM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
}

/** The host's offset east of UTC at that instant (DST-aware), in minutes. */
export function hostTimezoneOffsetMin(ms: number): number {
  return -new Date(ms).getTimezoneOffset() || 0;
}

/** Minutes since local midnight, in [0, 1440). */
export function localMinuteOfDay(now: number, timezoneOffsetMin: number): number {
  const minutes = Math.floor(now / 60_000) + Math.trunc(timezoneOffsetMin);
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Index of the local clock hour containing `ms`, using the same offset math
 * as quiet hours. Two instants with the same index are "the same hour" for
 * the hourly caps; across a DST fall-back the repeated wall-clock hour maps
 * to one index, so it shares one budget.
 */
export function localHourIndex(ms: number, timezoneOffsetMin: number): number {
  return Math.floor((ms + Math.trunc(timezoneOffsetMin) * 60_000) / 3_600_000);
}

export function isInQuietHours(
  window: RouteState["quietHours"],
  now: number,
  timezoneOffsetMin: number,
): boolean {
  if (!window) return false;
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (start === undefined || end === undefined || start === end) return false;
  const minute = localMinuteOfDay(now, timezoneOffsetMin);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

function usable(state: RouteState, channel: string | undefined): channel is string {
  if (channel === undefined || !Object.hasOwn(state.imReady, channel)) return false;
  return state.imReady[channel] !== "unavailable";
}

/**
 * Decide where one notice goes. Pure: the router gathers the state, calls
 * this, and records the decision in the ledger.
 *
 * Nothing is ever lost to throttling: over-cap and quiet-hours notices go to
 * the digest. Quiet-hours exemption depends only on the notice type (P0),
 * never on its text. `important` attention routes like `always`; any model
 * judgement about importance happens upstream.
 */
export function route(notice: RouteNotice, state: RouteState): RouteDecision {
  if (state.seenDedupeKeys.has(notice.dedupeKey)) return { outlet: "drop", reason: "duplicate" };
  if (notice.attention === "muted") return { outlet: "record", reason: "muted" };
  if (notice.attention === "digest") return { outlet: "digest", reason: "digest-attention" };
  if (notice.priority === "P0") {
    if (state.p0SentThisHour >= state.maxP0PerHour) return { outlet: "digest", reason: "p0-cap" };
  } else {
    if (isInQuietHours(state.quietHours, state.now, state.timezoneOffsetMin))
      return { outlet: "digest", reason: "quiet-hours" };
    if (state.sentThisHour >= state.maxPerHour) return { outlet: "digest", reason: "hourly-cap" };
  }
  // "Only while I'm away" holds whatever channel the rule names.
  if (notice.requiresAway && state.present)
    return { outlet: "record", reason: "requires-away-present" };

  if (notice.channel === "desktop") return { outlet: "desktop", reason: "desktop-channel" };
  if (notice.channel !== "auto") {
    // A channel the owner named wins over presence. An unbound channel will
    // not come back by itself, so it is not queued; a bound but unavailable
    // one is queued for when it reconnects.
    if (!Object.hasOwn(state.imReady, notice.channel))
      return { outlet: "desktop", reason: "im-unbound" };
    return usable(state, notice.channel)
      ? { outlet: "both", im: notice.channel, reason: "named-im" }
      : { outlet: "desktop", im: notice.channel, queued: true, reason: "im-unavailable-queued" };
  }

  if (state.present) return { outlet: "desktop", reason: "present-desktop" };
  if (usable(state, state.lastInboundChannel))
    return { outlet: "im", im: state.lastInboundChannel, reason: "away-last-inbound" };
  const first = Object.keys(state.imReady).find((channel) => usable(state, channel));
  if (first !== undefined) return { outlet: "im", im: first, reason: "away-first-ready" };
  return { outlet: "desktop", reason: "no-im-available" };
}
