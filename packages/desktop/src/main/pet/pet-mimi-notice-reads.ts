import {
  PET_NOTICE_TEXT_MAX,
  parsePetNoticesQuery,
  type PetNoticesQuery,
} from "@cjhyy/code-shell-pet/protocol";
import type {
  PetNoticeChannel,
  PetNoticeRuleSummary,
  PetNotificationSettingsView,
} from "../../shared/pet-notices.js";
import { composeNoticeBody, noticeLine } from "./pet-notice-compose.js";
import type { NoticeRecord, PetNoticeLedger } from "./pet-notice-ledger.js";
import { hostTimezoneOffsetMin, isSnoozed } from "./pet-notice-policy.js";
import { localIsoTime } from "./pet-notice-reply-interpreter.js";
import { unpackFacts } from "./pet-notice-types.js";

/**
 * What Mimi's read-only notice tools see (design §4.7): the ledger of what
 * was sent to the owner, the rule list, the pacing settings, and the briefs
 * and heartbeat messages she sent the conversation she is answering. Built
 * only from structured fields; no conversation, sender or platform id, no
 * reply code and no media path ever leaves main. Times are owner-local ISO.
 */

/** Mimi's own messages to the owner that her next turn there should know about. */
const PROACTIVE_KINDS: ReadonlySet<string> = new Set([
  "brief.morning",
  "brief.evening",
  "heartbeat",
]);
export const RECENT_PROACTIVE_WINDOW_MS = 12 * 60 * 60_000;
export const RECENT_PROACTIVE_MAX = 3;
const REFS_PER_NOTICE = 8;
const REF_TITLE_MAX = 80;
const SYSTEM_TRIGGER_ACTIONS: Readonly<Record<string, readonly string[]>> = {
  "all-sessions": [],
  "system-brief-morning": ["set_time"],
  "system-brief-evening": ["set_time"],
  "system-heartbeat": ["set_active_hours"],
};
const ENDED: ReadonlySet<string> = new Set(["spent", "completed", "cancelled"]);

export interface MimiNoticeReadsDeps {
  ledger: Pick<PetNoticeLedger, "load" | "newest">;
  /** The rule list exactly as the settings page gets it (`pet:notices:get-state`). */
  rules(): Promise<readonly PetNoticeRuleSummary[]>;
  settingsView(): PetNotificationSettingsView;
  channels(): readonly PetNoticeChannel[];
  sessionTitle(sessionId: string): string | undefined;
  /** Whether an IM conversation is one of the owner's allowlisted targets. */
  isOwnerConversation(channel: string, target: string): boolean;
  now?: () => number;
  timezoneOffsetMin?: (ms: number) => number;
}

/** The conversation a Mimi turn answers, as the host knows it (never from the model). */
export type MimiTurnOrigin =
  | { kind: "desktop" }
  | { kind: "im"; channel: string; target: string; isDirectMessage?: boolean };

export interface PetRecentProactiveNotice {
  kind: string;
  sentAt: string;
  text: string;
  refs?: Array<{ type: string; status: string; title: string }>;
}

function cut(text: string, max = PET_NOTICE_TEXT_MAX): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** A brief's record references as stored on its notice (refs, types, labels, titles). */
function briefRefs(facts: Record<string, unknown>) {
  const raw = Array.isArray(facts.refs) ? facts.refs : [];
  return raw.slice(0, REFS_PER_NOTICE).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const title = noticeLine(entry.title, REF_TITLE_MAX);
    const type = noticeLine(entry.type, 16);
    const status = noticeLine(entry.status, 16);
    if (!title || !type || !status) return [];
    const sessionId =
      typeof entry.sessionId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(entry.sessionId)
        ? entry.sessionId
        : undefined;
    return [{ type, status, title, ...(sessionId ? { sessionId } : {}) }];
  });
}

function deliveryOf(record: NoticeRecord): string {
  const status = record.delivery?.status;
  if (status === "accepted") return "sent";
  if (status === "claimed" || status === "enqueued") return "sending";
  if (status === "unknown") return "maybe-sent";
  if (status === "revoked") {
    const why = record.delivery?.error;
    return why === "digested" ? "folded-into-digest" : why === "resent" ? "resent" : "withdrawn";
  }
  if (status) return status;
  const outlet = record.decision?.outlet;
  if (outlet === "desktop") return "shown-on-desktop";
  if (outlet === "record") return "recorded-only";
  if (outlet === "digest") return "held";
  return "unknown";
}

function wasDelivered(record: NoticeRecord): boolean {
  const outlet = record.decision?.outlet;
  if (outlet !== "desktop" && outlet !== "both" && outlet !== "im") return false;
  const status = record.delivery?.status;
  if (outlet !== "im") return true;
  return (
    status === "accepted" || status === "enqueued" || status === "claimed" || status === "unknown"
  );
}

export function createMimiNoticeReads(deps: MimiNoticeReadsDeps) {
  const now = deps.now ?? Date.now;
  const offset = deps.timezoneOffsetMin ?? hostTimezoneOffsetMin;
  const iso = (ms: number) => localIsoTime(ms, offset(ms));
  const channelLabel = (id: string | undefined) =>
    id === undefined ? "IM" : (deps.channels().find((channel) => channel.id === id)?.label ?? id);

  /** Where a notice went, as a label: desktop, an IM (by name), the digest, or nowhere. */
  const whereOf = (record: NoticeRecord): string => {
    const decision = record.decision;
    const im = channelLabel(record.delivery?.channel ?? decision?.im);
    switch (decision?.outlet) {
      case "desktop":
        return "desktop";
      case "im":
        return im;
      case "both":
        return `${im} + desktop`;
      case "digest":
        return "digest";
      case "record":
        return "record-only";
      default:
        return "unknown";
    }
  };

  function noticeRow(record: NoticeRecord): Record<string, unknown> {
    const { facts, target } = unpackFacts(record.facts);
    const raw = isRecord(record.facts) ? record.facts : {};
    const title = noticeLine(facts.title);
    const sessionTitle = record.sessionId ? deps.sessionTitle(record.sessionId) : undefined;
    const taskId =
      typeof raw.taskId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(raw.taskId)
        ? raw.taskId
        : undefined;
    const refs = briefRefs(raw);
    return {
      id: record.id,
      kind: record.kind,
      ...(title ? { title } : {}),
      text: cut(composeNoticeBody(record.kind, facts, record.body)),
      createdAt: iso(record.createdAt),
      to:
        target.kind === "owner"
          ? "owner"
          : target.route.isDirectMessage === true
            ? "private-chat"
            : "group-chat",
      channel: whereOf(record),
      delivery: deliveryOf(record),
      ...(record.sessionId
        ? {
            session: {
              id: record.sessionId,
              ...(sessionTitle ? { title: noticeLine(sessionTitle) } : {}),
            },
          }
        : {}),
      ...(taskId ? { taskId } : {}),
      ...(refs.length > 0 ? { refs } : {}),
    };
  }

  async function notices(query: PetNoticesQuery) {
    await deps.ledger.load();
    const kinds = query.kinds ? new Set<string>(query.kinds) : undefined;
    const match = (record: Readonly<NoticeRecord>) =>
      (!kinds || kinds.has(record.kind)) &&
      (query.sessionId === undefined || record.sessionId === query.sessionId) &&
      (query.since === undefined || record.createdAt >= query.since) &&
      (query.until === undefined || record.createdAt <= query.until) &&
      record.decision?.outlet !== "drop";
    const found = deps.ledger.newest(match, query.limit + 1);
    return {
      ok: true,
      notices: found.slice(0, query.limit).map(noticeRow),
      ...(found.length > query.limit ? { more: true } : {}),
      now: iso(now()),
    };
  }

  function triggerRow(rule: PetNoticeRuleSummary): Record<string, unknown> {
    const when: Record<string, unknown> = {
      ...(rule.dailyAt ? { dailyAt: rule.dailyAt } : {}),
      ...(rule.activeHours ? { activeHours: rule.activeHours } : {}),
      ...(rule.events ? { events: rule.events } : {}),
      ...(rule.scope ? { scope: rule.scope } : {}),
      ...(rule.schedule?.at !== undefined ? { at: iso(rule.schedule.at) } : {}),
      ...(rule.schedule?.label ? { label: noticeLine(rule.schedule.label, 64) } : {}),
      ...(rule.schedule?.cron ? { cron: rule.schedule.cron } : {}),
      ...(rule.schedule?.nextAt !== undefined ? { next: iso(rule.schedule.nextAt) } : {}),
    };
    const extra = SYSTEM_TRIGGER_ACTIONS[rule.id];
    const actions = extra
      ? [...rule.actions, rule.state === "active" ? "disable" : "enable", ...extra]
      : [...rule.actions];
    const title = noticeLine(rule.title);
    const sessionTitle = noticeLine(rule.sessionTitle);
    return {
      id: rule.id,
      version: rule.version,
      kind: rule.kind,
      ...(rule.brief ? { brief: rule.brief } : {}),
      state: rule.state,
      source: rule.source,
      ...(title ? { title } : {}),
      ...(rule.followUp ? { followUp: rule.followUp } : {}),
      ...(rule.sessionId
        ? { session: { id: rule.sessionId, ...(sessionTitle ? { title: sessionTitle } : {}) } }
        : {}),
      when,
      target: rule.target,
      ...(rule.lastFiredAt !== undefined ? { lastFiredAt: iso(rule.lastFiredAt) } : {}),
      ...(rule.lastOutcome ? { lastOutcome: rule.lastOutcome } : {}),
      ...(rule.overdue ? { overdue: rule.overdue } : {}),
      actions,
    };
  }

  async function triggers(includeEnded: boolean) {
    const rows = await deps.rules();
    return {
      ok: true,
      triggers: rows.filter((rule) => includeEnded || !ENDED.has(rule.state)).map(triggerRow),
      now: iso(now()),
    };
  }

  function settings() {
    const { snoozeUntil, ...view } = deps.settingsView();
    const at = now();
    const snoozed = isSnoozed({ now: at, snoozedUntil: snoozeUntil ?? null });
    return {
      ok: true,
      settings: view,
      ...(snoozed ? { snooze: { until: iso(snoozeUntil!) } } : {}),
      now: iso(at),
    };
  }

  /**
   * Briefs and heartbeat messages Mimi sent this conversation in the last
   * 12 hours (at most three, newest first): an IM conversation sees those
   * that reached its channel when it is the owner's private chat; the desktop
   * sees every one that went out to the owner.
   */
  async function recentProactive(origin: MimiTurnOrigin): Promise<PetRecentProactiveNotice[]> {
    if (
      origin.kind === "im" &&
      (origin.isDirectMessage !== true || !deps.isOwnerConversation(origin.channel, origin.target))
    )
      return [];
    await deps.ledger.load();
    const since = now() - RECENT_PROACTIVE_WINDOW_MS;
    const found = deps.ledger.newest((record) => {
      if (!PROACTIVE_KINDS.has(record.kind) || record.createdAt < since) return false;
      if (
        unpackFacts(record.facts).target.kind !== "owner" ||
        !wasDelivered(record as NoticeRecord)
      )
        return false;
      if (origin.kind === "desktop") return true;
      const im = record.delivery?.channel ?? record.decision?.im;
      return (
        (record.decision?.outlet === "im" || record.decision?.outlet === "both") &&
        im === origin.channel
      );
    }, RECENT_PROACTIVE_MAX);
    return found.map((record) => {
      const { facts } = unpackFacts(record.facts);
      const refs = briefRefs(isRecord(record.facts) ? record.facts : {}).map(
        ({ type, status, title }) => ({ type, status, title }),
      );
      return {
        kind: record.kind,
        sentAt: iso(record.createdAt),
        text: cut(composeNoticeBody(record.kind, facts, record.body)),
        ...(refs.length > 0 ? { refs } : {}),
      };
    });
  }

  return {
    /** `PET_NOTICES_QUERY_ACTION`: args already shaped by the tool, re-validated here. */
    async noticesQuery(args: Record<string, unknown>) {
      const query = parsePetNoticesQuery(args);
      if (!query) throw new Error("invalid notices query");
      return notices(query);
    },
    async triggersQuery(args: Record<string, unknown>) {
      if (
        Object.keys(args).some((key) => key !== "includeEnded") ||
        (args.includeEnded !== undefined && typeof args.includeEnded !== "boolean")
      )
        throw new Error("invalid triggers query");
      return triggers(args.includeEnded === true);
    },
    async settingsQuery(args: Record<string, unknown>) {
      if (Object.keys(args).length > 0) throw new Error("invalid settings query");
      return settings();
    },
    recentProactive,
  };
}

export type MimiNoticeReads = ReturnType<typeof createMimiNoticeReads>;
