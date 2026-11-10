/**
 * Notice-rule wire contract shared by the worker-side NotifyMe tool and the
 * Desktop host that persists and fires the rules.
 *
 * A Work Session asks the host to remember "tell the owner when this Session
 * is done / fails / gets blocked". The host stores the rule and detects those
 * events from the Session's own event stream, so the model never has to
 * remember to send anything at the end.
 *
 * Transport: `ProtocolObserverHost.requestHostAction(sessionId,
 * PET_RULE_UPSERT_ACTION, upsert)` with `upsert: NoticeRuleUpsert`.
 *
 * Reply contract ({@link NoticeRuleUpsertReply}):
 *   - `{ ok: true, status: "ok", effect }` — the rule is persisted; `effect`
 *     says what will actually happen so the tool can tell the owner exactly.
 *   - `{ ok: true, status: "unknown_channel", channels }` — `channel` named an
 *     id that is not a bound gateway channel; nothing was saved. This is a
 *     SUCCESSFUL loopback reply on purpose: a host `{ ok: false, error }`
 *     reply reaches the worker as a rejection carrying only the error string,
 *     which would lose the structured `channels` list the model needs.
 *   - Throwing in the host handler (→ `{ ok: false, error }` → rejection) is
 *     reserved for real failures (storage, unknown Session, malformed args).
 */

export type NoticeEvent = "done" | "failed" | "blocked";
export type NoticeAttention = "always" | "important" | "digest" | "muted";
/** `"auto"`, `"desktop"`, or a bound IM gateway channel id (wechat, lark, telegram, …). */
export type NoticeChannel = "auto" | "desktop" | string;
export type NoticeChannelReadiness = "ready" | "unknown" | "unavailable";

export interface NoticeRuleUpsert {
  sessionId: string;
  createdBy: "notify-me" | "bell" | "delegation" | "watch-session";
  events: NoticeEvent[];
  scope: "turn" | "goal";
  channel: NoticeChannel;
  attention: "always" | "important";
  /** Owner's extra ask, recorded as data only; never instructions for the host. */
  note?: string;
}

export interface RuleEffect {
  ruleId: string;
  /** Human-readable description of when the rule fires, e.g. "when this turn ends". */
  fires: string;
  channel: NoticeChannel;
  /** The IM channel that will actually be used (named, or predicted for auto). Absent → desktop. */
  im?: { channel: string; label: string; ready: NoticeChannelReadiness };
  quietHours?: string;
}

export interface BoundChannel {
  id: string;
  label: string;
  ready: NoticeChannelReadiness;
}

export const PET_RULE_UPSERT_ACTION = "pet.rule.upsert";

export const NOTICE_EVENTS: readonly NoticeEvent[] = ["done", "failed", "blocked"];
export const NOTICE_RULE_CREATORS: readonly NoticeRuleUpsert["createdBy"][] = [
  "notify-me",
  "bell",
  "delegation",
  "watch-session",
];
export const NOTICE_CHANNEL_MAX_LENGTH = 40;
export const NOTICE_NOTE_MAX_LENGTH = 500;

export type NoticeRuleUpsertReply =
  | { ok: true; status: "ok"; effect: RuleEffect }
  | { ok: true; status: "unknown_channel"; channels: BoundChannel[] };

const READINESS = new Set<string>(["ready", "unknown", "unavailable"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isBoundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !CONTROL_CHARS.test(value)
  );
}

function parseImEffect(value: unknown): RuleEffect["im"] | null {
  if (!isRecord(value)) return null;
  if (!isBoundedText(value.channel, NOTICE_CHANNEL_MAX_LENGTH)) return null;
  if (!isBoundedText(value.label, 80)) return null;
  if (typeof value.ready !== "string" || !READINESS.has(value.ready)) return null;
  return {
    channel: value.channel,
    label: value.label,
    ready: value.ready as NoticeChannelReadiness,
  };
}

function parseBoundChannel(value: unknown): BoundChannel | null {
  if (!isRecord(value)) return null;
  if (!isBoundedText(value.id, NOTICE_CHANNEL_MAX_LENGTH)) return null;
  if (!isBoundedText(value.label, 80)) return null;
  if (typeof value.ready !== "string" || !READINESS.has(value.ready)) return null;
  return { id: value.id, label: value.label, ready: value.ready as NoticeChannelReadiness };
}

/** Validate a host reply to {@link PET_RULE_UPSERT_ACTION}; null when malformed. */
export function parseNoticeRuleUpsertReply(value: unknown): NoticeRuleUpsertReply | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.status === "unknown_channel") {
    if (!Array.isArray(value.channels) || value.channels.length > 32) return null;
    const channels = value.channels.map(parseBoundChannel);
    if (channels.some((channel) => channel === null)) return null;
    return { ok: true, status: "unknown_channel", channels: channels as BoundChannel[] };
  }
  if (value.status !== "ok" || !isRecord(value.effect)) return null;
  const effect = value.effect;
  if (!isBoundedText(effect.ruleId, 128)) return null;
  if (!isBoundedText(effect.fires, 200)) return null;
  if (!isBoundedText(effect.channel, NOTICE_CHANNEL_MAX_LENGTH)) return null;
  const im = effect.im === undefined ? undefined : parseImEffect(effect.im);
  if (im === null) return null;
  if (effect.quietHours !== undefined && !isBoundedText(effect.quietHours, 80)) return null;
  return {
    ok: true,
    status: "ok",
    effect: {
      ruleId: effect.ruleId,
      fires: effect.fires,
      channel: effect.channel,
      ...(im ? { im } : {}),
      ...(effect.quietHours !== undefined ? { quietHours: effect.quietHours as string } : {}),
    },
  };
}

/**
 * Host-side validation of {@link NoticeRuleUpsert} args received over the
 * loopback. Returns null for anything the NotifyMe tool would never send.
 * Channel existence is NOT checked here; that needs the host's gateway.
 */
export function parseNoticeRuleUpsert(value: unknown): NoticeRuleUpsert | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "sessionId",
    "createdBy",
    "events",
    "scope",
    "channel",
    "attention",
    "note",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  if (!isBoundedText(value.sessionId, 256)) return null;
  if (
    typeof value.createdBy !== "string" ||
    !(NOTICE_RULE_CREATORS as readonly string[]).includes(value.createdBy)
  ) {
    return null;
  }
  const events = parseNoticeEvents(value.events);
  if (!events) return null;
  if (value.scope !== "turn" && value.scope !== "goal") return null;
  if (!isBoundedText(value.channel, NOTICE_CHANNEL_MAX_LENGTH)) return null;
  if (value.attention !== "always" && value.attention !== "important") return null;
  if (value.note !== undefined && !isBoundedNote(value.note)) return null;
  return {
    sessionId: value.sessionId,
    createdBy: value.createdBy as NoticeRuleUpsert["createdBy"],
    events,
    scope: value.scope,
    channel: value.channel,
    attention: value.attention,
    ...(value.note !== undefined ? { note: value.note as string } : {}),
  };
}

/** Non-empty, duplicate-free subset of {@link NOTICE_EVENTS}; null otherwise. */
export function parseNoticeEvents(value: unknown): NoticeEvent[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > NOTICE_EVENTS.length) {
    return null;
  }
  if (!value.every((event) => (NOTICE_EVENTS as readonly unknown[]).includes(event))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value] as NoticeEvent[];
}

function isBoundedNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= NOTICE_NOTE_MAX_LENGTH &&
    value.trim() === value
  );
}
