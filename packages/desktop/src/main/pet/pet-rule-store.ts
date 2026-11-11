import { randomUUID } from "node:crypto";
import {
  normalizePetLongTaskCompletionTarget,
  type PetLongTaskCompletionTarget,
} from "@cjhyy/code-shell-pet";
import {
  NOTICE_CHANNEL_MAX_LENGTH,
  NOTICE_EVENTS,
  NOTICE_NOTE_MAX_LENGTH,
  NOTICE_RULE_CREATORS,
  parseNoticeEvents,
  parseNoticeRuleUpsert,
  type NoticeAttention,
  type NoticeChannel,
  type NoticeEvent,
  type NoticeRuleUpsert,
} from "@cjhyy/code-shell-pet/protocol";
import { dlog } from "../desktop-logger.js";
import {
  quarantineCorruptJson,
  readBoundedJson,
  writeOwnerJsonAtomic,
} from "./bounded-json-store.js";
import {
  dueAt,
  firstOccurrence,
  isSystemScheduleThen,
  staggerFor,
  nextOccurrence,
  parseRuleWake,
  parseScheduleThen,
  parseScheduleWhen,
  WAKE_DETAIL_MAX,
  type RuleWake,
  type RuleWakeOutcome,
  type ScheduleThen,
  type ScheduleWhen,
  type SystemScheduleThen,
} from "./pet-schedule-rule.js";
import { imConversationRouteKey } from "./session-turn-scheduler.js";

/** The IM origin a notice should go back to; same shape as a long task's completion target. */
export type PetChatRoute = PetLongTaskCompletionTarget;

export type NoticeRuleState = "active" | "paused" | "spent" | "completed" | "cancelled";
export type SystemNoticeRuleId = "all-sessions";

export type { ScheduleThen, ScheduleWhen, RuleWake } from "./pet-schedule-rule.js";

/**
 * Mimi's own schedule rules (design §10.1, §10.2): fixed ids, each with a
 * fixed `then`. They are created on first switch-on and only paused after
 * that; their timing follows the owner's settings.
 */
export type SystemScheduleRuleId =
  | "system-brief-morning"
  | "system-brief-evening"
  | "system-heartbeat"
  /** The heartbeat's one extra look ("recheck in N minutes"): a one-shot. */
  | "system-heartbeat-recheck";

export const SYSTEM_SCHEDULE_THEN: Readonly<Record<SystemScheduleRuleId, SystemScheduleThen>> = {
  "system-brief-morning": { mode: "compose", brief: "morning" },
  "system-brief-evening": { mode: "compose", brief: "evening" },
  "system-heartbeat": { mode: "judge", kind: "heartbeat" },
  "system-heartbeat-recheck": { mode: "judge", kind: "heartbeat" },
};

function systemScheduleThen(id: unknown): SystemScheduleThen | undefined {
  return typeof id === "string" && Object.hasOwn(SYSTEM_SCHEDULE_THEN, id)
    ? SYSTEM_SCHEDULE_THEN[id as SystemScheduleRuleId]
    : undefined;
}

/** What the owner's settings ask of one system schedule rule. */
export interface SystemScheduleInput {
  when: ScheduleWhen;
  state: "active" | "paused";
}

export interface SessionRuleWhen {
  kind: "session";
  sessionId: string;
  runtime: "native";
  events: NoticeEvent[];
  scope: "turn" | "goal";
  /** Epoch ms; only turns that complete at/after this instant can fire the rule. */
  armedAt: number;
}

export interface AllSessionsRuleWhen {
  kind: "all-sessions";
  events: NoticeEvent[];
  onlyWhenAway: true;
}

export interface NoticeRule {
  id: string;
  /**
   * Owner-intent revision: bumped by edits, not by a schedule's wake progress,
   * so a follow-up's revision stays put while its occurrences come and go.
   */
  version: number;
  origin: "user" | "delegation" | "system";
  createdBy: NoticeRuleUpsert["createdBy"] | "follow-up" | "system";
  when: SessionRuleWhen | AllSessionsRuleWhen | ScheduleWhen;
  then: { mode: "notify" } | ScheduleThen;
  /** Schedule rules only: the current occurrence's durable state. */
  wake?: RuleWake;
  attention: NoticeAttention;
  channel: NoticeChannel;
  target: { kind: "route"; route: PetChatRoute } | { kind: "owner" };
  note?: string;
  state: NoticeRuleState;
  createdAt: number;
  updatedAt: number;
}

/** A rule that fires on Session events (what the delivery plan and watcher read). */
export type EventNoticeRule = NoticeRule & {
  when: SessionRuleWhen | AllSessionsRuleWhen;
  then: { mode: "notify" };
};

/** A time-triggered rule: an owner's follow-up, or Mimi's brief / heartbeat. */
export type ScheduleNoticeRule = NoticeRule & {
  when: ScheduleWhen;
  then: ScheduleThen;
  wake: RuleWake;
};

/** One of Mimi's own schedule rules. */
export type SystemScheduleNoticeRule = ScheduleNoticeRule & {
  id: SystemScheduleRuleId;
  then: SystemScheduleThen;
};

export function isSystemScheduleRule(rule: NoticeRule): rule is SystemScheduleNoticeRule {
  return isScheduleRule(rule) && systemScheduleThen(rule.id) !== undefined;
}

export function isScheduleRule(rule: NoticeRule): rule is ScheduleNoticeRule {
  return rule.when.kind === "schedule";
}

export interface CreateScheduleRuleInput {
  /** Host-derived and deterministic (from the turn's operation), so a replay finds it. */
  id: string;
  when: ScheduleWhen;
  then: ScheduleThen;
  channel: NoticeChannel;
  target: NoticeRule["target"];
}

export type UpsertSessionNoticeRuleInput = NoticeRuleUpsert & {
  target: NoticeRule["target"];
  origin: NoticeRule["origin"];
  armedAt: number;
};

export type NoticeRulePatch = Partial<
  Pick<NoticeRule, "state" | "channel" | "attention" | "note">
> & { events?: NoticeEvent[] };

export interface SystemNoticeRulePatch {
  state?: "active" | "paused";
  channel?: NoticeChannel;
  events?: NoticeEvent[];
}

/**
 * Wraps every read-modify-write critical section. The default is a pass-through
 * because the store already serialises its own writes in-process.
 */
export type PetRuleStoreLock = <T>(critical: () => Promise<T>) => Promise<T>;

export interface PetRuleStoreOptions {
  path: string;
  now?: () => number;
  lock?: PetRuleStoreLock;
  maxRules?: number;
}

export type PetRuleStoreErrorCode =
  | "version_conflict"
  | "rule_not_found"
  | "duplicate_active_rule"
  | "rule_store_full"
  | "rule_store_unwritable"
  | "invalid_rule"
  | "schedule_in_past"
  | "schedule_never_fires";

export class PetRuleStoreError extends Error {
  constructor(readonly code: PetRuleStoreErrorCode) {
    super(code);
    this.name = "PetRuleStoreError";
  }
}

const SCHEMA_VERSION = 1;
/** An `apply` result that changed nothing: nothing is written and no listener runs. */
const UNCHANGED = Symbol("unchanged");
interface Unchanged<T> {
  [UNCHANGED]: true;
  value: T;
}
function unchanged<T>(value: T): Unchanged<T> {
  return { [UNCHANGED]: true, value };
}
function isUnchanged<T>(value: T | Unchanged<T>): value is Unchanged<T> {
  return typeof value === "object" && value !== null && UNCHANGED in value;
}
const DEFAULT_MAX_RULES = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LOADED_ROWS = 10_000;
const SYSTEM_RULE_ID: SystemNoticeRuleId = "all-sessions";
const RULE_ID_PATTERN = /^rule-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ATTENTIONS: readonly NoticeAttention[] = ["always", "important", "digest", "muted"];
const STATES: readonly NoticeRuleState[] = ["active", "paused", "spent", "completed", "cancelled"];
const CREATORS: readonly NoticeRule["createdBy"][] = [
  ...NOTICE_RULE_CREATORS,
  "follow-up",
  "system",
];
/** Terminal rules are history; only they may be evicted to make room. */
const EVICTABLE_STATES: ReadonlySet<NoticeRuleState> = new Set(["spent", "completed", "cancelled"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

interface PetRuleFile {
  version: typeof SCHEMA_VERSION;
  rules: NoticeRule[];
  /** Rows this build could not understand, carried forward byte-for-byte in JSON terms. */
  quarantine: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Plain object with only the allowed keys; deliberately not a type guard. */
function isPatchShape(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && hasOnlyKeys(value, keys);
}

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !CONTROL_CHARS.test(value)
  );
}

function isChannel(value: unknown): value is NoticeChannel {
  return isText(value, NOTICE_CHANNEL_MAX_LENGTH) && value.trim() === value;
}

function isNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= NOTICE_NOTE_MAX_LENGTH &&
    value.trim() === value
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEvents(value: unknown): value is NoticeEvent[] {
  return parseNoticeEvents(value) !== null;
}

/** JSON with object keys sorted, so equality ignores key order from hand-edited files. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    isRecord(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
}

/**
 * Normalise an incoming target with the long-task route normaliser, so field
 * limits live in one place. Undefined when the route is not addressable.
 */
function normalizeTarget(value: unknown): NoticeRule["target"] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "owner") return hasOnlyKeys(value, ["kind"]) ? { kind: "owner" } : undefined;
  if (value.kind !== "route" || !hasOnlyKeys(value, ["kind", "route"])) return undefined;
  const route = normalizePetLongTaskCompletionTarget(value.route);
  return route ? { kind: "route", route } : undefined;
}

/** A stored target must already be in canonical (normalised) form. */
function isTarget(value: unknown): value is NoticeRule["target"] {
  const normalized = normalizeTarget(value);
  return normalized !== undefined && canonicalJson(normalized) === canonicalJson(value);
}

/**
 * Conversation identity of a target for "one active rule per Session +
 * target". Capabilities (reply button, attachment kinds) are deliberately not
 * part of it: the same chat with updated capabilities is the same target.
 * Delivery plans dedupe conversations with the same key.
 */
export function noticeTargetKey(target: NoticeRule["target"]): string {
  if (target.kind === "owner") return "owner";
  const route = target.route;
  return imConversationRouteKey(route) ?? JSON.stringify(["im", route.channel, route.target, null]);
}

/**
 * Pre-release builds armed rules by an in-memory turn sequence (`armedAtSeq`),
 * which does not survive a restart. Such rows are read as armed at their last
 * update, since a refreshing upsert re-arms a rule in place.
 */
function migrateLegacyRow(row: unknown): unknown {
  if (!isRecord(row) || !isRecord(row.when) || row.when.kind !== "session") return row;
  if (!("armedAtSeq" in row.when) || "armedAt" in row.when) return row;
  const { armedAtSeq: _legacy, ...when } = row.when;
  return { ...row, when: { ...when, armedAt: row.updatedAt } };
}

function parseWhen(value: unknown, id: unknown): NoticeRule["when"] | undefined {
  if (!isRecord(value)) return undefined;
  // Only the heartbeat, whose cron the host writes, may fire twice an hour.
  if (value.kind === "schedule")
    return parseScheduleWhen(value, { halfHourly: id === "system-heartbeat" });
  if (value.kind === "session") {
    if (
      !hasOnlyKeys(value, ["kind", "sessionId", "runtime", "events", "scope", "armedAt"]) ||
      !isText(value.sessionId, 256) ||
      value.runtime !== "native" ||
      !isEvents(value.events) ||
      (value.scope !== "turn" && value.scope !== "goal") ||
      !isTimestamp(value.armedAt)
    )
      return undefined;
    return value as unknown as NoticeRule["when"];
  }
  if (value.kind === "all-sessions") {
    if (
      !hasOnlyKeys(value, ["kind", "events", "onlyWhenAway"]) ||
      !isEvents(value.events) ||
      value.onlyWhenAway !== true
    )
      return undefined;
    return value as unknown as NoticeRule["when"];
  }
  return undefined;
}

/** Strict row validator; anything it rejects is quarantined, never dropped. */
function parseRule(value: unknown): NoticeRule | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !hasOnlyKeys(value, [
      "id",
      "version",
      "origin",
      "createdBy",
      "when",
      "then",
      "attention",
      "channel",
      "target",
      "note",
      "state",
      "createdAt",
      "updatedAt",
      "wake",
    ])
  )
    return undefined;
  const when = parseWhen(value.when, value.id);
  if (!when) return undefined;
  const scheduled = when.kind === "schedule";
  if (
    scheduled
      ? !parseScheduleThen(value.then) || !parseRuleWake(value.wake)
      : !isRecord(value.then) ||
        value.then.mode !== "notify" ||
        !hasOnlyKeys(value.then, ["mode"]) ||
        value.wake !== undefined
  )
    return undefined;
  if (
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !(CREATORS as readonly unknown[]).includes(value.createdBy) ||
    !(ATTENTIONS as readonly unknown[]).includes(value.attention) ||
    !isChannel(value.channel) ||
    !isTarget(value.target) ||
    (value.note !== undefined && !isNote(value.note)) ||
    !(STATES as readonly unknown[]).includes(value.state) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    value.updatedAt < value.createdAt
  )
    return undefined;
  const system = scheduled ? systemScheduleThen(value.id) : undefined;
  if (system) {
    // Mimi's own: owner-addressed, auto channel, the id's own `then`; never finished.
    if (
      value.origin !== "system" ||
      value.createdBy !== "system" ||
      value.target.kind !== "owner" ||
      value.channel !== "auto" ||
      value.attention !== "always" ||
      canonicalJson(value.then) !== canonicalJson(system) ||
      (value.state !== "active" && value.state !== "paused") ||
      (value.id === "system-heartbeat-recheck") !== ((when as ScheduleWhen).at !== undefined)
    )
      return undefined;
  } else if (scheduled) {
    // Owner-asked follow-ups.
    if (
      typeof value.id !== "string" ||
      !RULE_ID_PATTERN.test(value.id) ||
      value.origin !== "user" ||
      value.createdBy !== "follow-up" ||
      isSystemScheduleThen(value.then as ScheduleThen)
    )
      return undefined;
  } else if (when.kind === "session") {
    if (
      typeof value.id !== "string" ||
      !RULE_ID_PATTERN.test(value.id) ||
      (value.origin !== "user" && value.origin !== "delegation") ||
      value.createdBy === "system" ||
      value.createdBy === "follow-up"
    )
      return undefined;
  } else if (
    value.id !== SYSTEM_RULE_ID ||
    value.origin !== "system" ||
    value.createdBy !== "system" ||
    value.target.kind !== "owner" ||
    (value.state !== "active" && value.state !== "paused")
  ) {
    return undefined;
  }
  return value as unknown as NoticeRule;
}

function defaultSystemRule(): NoticeRule {
  return {
    id: SYSTEM_RULE_ID,
    // Version 0 marks a rule that has never been persisted.
    version: 0,
    origin: "system",
    createdBy: "system",
    when: { kind: "all-sessions", events: [...NOTICE_EVENTS], onlyWhenAway: true },
    then: { mode: "notify" },
    attention: "always",
    channel: "auto",
    target: { kind: "owner" },
    // Off by default: the owner opts in to "tell me about every Session".
    state: "paused",
    createdAt: 0,
    updatedAt: 0,
  };
}

function sessionKey(sessionId: string, target: NoticeRule["target"]): string {
  return `${sessionId}\u0000${noticeTargetKey(target)}`;
}

function ruleSessionKey(rule: NoticeRule): string | undefined {
  return rule.when.kind === "session" ? sessionKey(rule.when.sessionId, rule.target) : undefined;
}

/**
 * Durable notice rules ("tell me when Session X is done / failed / blocked"),
 * owned exclusively by the Electron main process.
 *
 * Single writer: workers and the chat CLI reach these rules through host
 * actions and IPC, never the file, so writes are serialised by an in-process
 * promise queue. Each mutation stages a copy, validates every row, commits it
 * atomically to disk, and only then swaps in-memory state and notifies
 * listeners. Rows this build cannot understand are carried in `quarantine`
 * and written back unchanged; a file from a newer schema is never overwritten.
 */
export class PetRuleStore {
  private rules = new Map<string, NoticeRule>();
  private quarantine: unknown[] = [];
  private unwritable = false;
  private loadPromise: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly path: string;
  private readonly now: () => number;
  private readonly lock: PetRuleStoreLock;
  private readonly maxRules: number;

  constructor(options: PetRuleStoreOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.lock = options.lock ?? ((critical) => critical());
    const maxRules = options.maxRules ?? DEFAULT_MAX_RULES;
    if (!Number.isSafeInteger(maxRules) || maxRules < 1) throw new Error("invalid maxRules");
    this.maxRules = maxRules;
  }

  /** Resolves once every write queued so far has settled (for shutdown). */
  async flush(): Promise<void> {
    let current: Promise<unknown>;
    do {
      current = this.queue;
      await current.catch(() => undefined);
    } while (current !== this.queue);
  }

  load(): Promise<void> {
    if (!this.loadPromise) {
      const attempt = this.loadFromDisk().catch((error) => {
        // A transient read/quarantine failure must stay retryable.
        if (this.loadPromise === attempt) this.loadPromise = undefined;
        throw error;
      });
      this.loadPromise = attempt;
    }
    return this.loadPromise;
  }

  list(): NoticeRule[] {
    return [...this.rules.values()].map((rule) => structuredClone(rule));
  }

  get(id: string): NoticeRule | undefined {
    const rule = this.rules.get(id);
    return rule ? structuredClone(rule) : undefined;
  }

  /** Active rules that watch this Session, plus the all-sessions system rule when it is on. */
  activeForSession(sessionId: string): EventNoticeRule[] {
    const result: EventNoticeRule[] = [];
    for (const rule of this.rules.values()) {
      if (rule.state !== "active") continue;
      if (rule.when.kind !== "session" || rule.when.sessionId !== sessionId) continue;
      result.push(structuredClone(rule) as EventNoticeRule);
    }
    const system = this.rules.get(SYSTEM_RULE_ID);
    if (system?.state === "active") result.push(structuredClone(system) as EventNoticeRule);
    return result;
  }

  systemRule(id: SystemNoticeRuleId): EventNoticeRule {
    if (id !== SYSTEM_RULE_ID) throw new PetRuleStoreError("rule_not_found");
    const rule = this.rules.get(SYSTEM_RULE_ID);
    return (rule ? structuredClone(rule) : defaultSystemRule()) as EventNoticeRule;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Create, or refresh, the one active rule for this Session + target. A
   * repeat ask updates the existing rule in place (same id, createdAt) so the
   * owner is never notified twice for the same event.
   *
   * Only ACTIVE rules are matched. A paused rule for the same Session + target
   * stays paused (the owner muted it on purpose) and a new active rule is
   * created beside it; finished rules are history and never revived.
   *
   * Owner intent wins over Mimi's: an owner upsert onto Mimi's delegation
   * rule takes it over (origin "user", the owner's channel and attention), so
   * the task's end never spends it and the bell can switch it off; a
   * delegation upsert onto an owner rule leaves that rule exactly as it is.
   */
  upsertSessionRule(input: UpsertSessionNoticeRuleInput): Promise<NoticeRule> {
    const snapshot = structuredClone(input);
    return this.mutate((staged) => {
      const { target: rawTarget, origin, armedAt, ...wire } = snapshot;
      const upsert = parseNoticeRuleUpsert(wire);
      const target = normalizeTarget(rawTarget);
      if (
        !upsert ||
        !target ||
        (origin !== "user" && origin !== "delegation") ||
        !isTimestamp(armedAt)
      )
        throw new PetRuleStoreError("invalid_rule");
      const key = sessionKey(upsert.sessionId, target);
      const at = this.timestamp();
      const existing = [...staged.values()].find(
        (rule) => rule.state === "active" && ruleSessionKey(rule) === key,
      );
      const when: NoticeRule["when"] = {
        kind: "session",
        sessionId: upsert.sessionId,
        runtime: "native",
        events: upsert.events,
        scope: upsert.scope,
        armedAt,
      };
      if (existing?.origin === "user" && origin === "delegation") return unchanged(existing);
      if (existing) {
        const next: NoticeRule = {
          ...existing,
          ...(existing.origin === "delegation" && origin === "user"
            ? { origin, createdBy: upsert.createdBy }
            : {}),
          version: existing.version + 1,
          when,
          channel: upsert.channel,
          attention: upsert.attention,
          // Same conversation, possibly with refreshed reply capabilities.
          target: structuredClone(target),
          updatedAt: Math.max(at, existing.updatedAt),
        };
        delete next.note;
        if (upsert.note !== undefined) next.note = upsert.note;
        staged.set(next.id, next);
        return next;
      }
      const rule: NoticeRule = {
        id: `rule-${randomUUID()}`,
        version: 1,
        origin,
        createdBy: upsert.createdBy,
        when,
        then: { mode: "notify" },
        attention: upsert.attention,
        channel: upsert.channel,
        target,
        ...(upsert.note !== undefined ? { note: upsert.note } : {}),
        state: "active",
        createdAt: at,
        updatedAt: at,
      };
      staged.set(rule.id, rule);
      return rule;
    });
  }

  /** Optimistic update; a stale `expectedVersion` throws `version_conflict`. */
  update(id: string, expectedVersion: number, patch: NoticeRulePatch): Promise<NoticeRule> {
    const snapshot = structuredClone(patch);
    return this.mutate((staged) => {
      const current = staged.get(id);
      if (!current) throw new PetRuleStoreError("rule_not_found");
      if (current.version !== expectedVersion) throw new PetRuleStoreError("version_conflict");
      if (!isPatchShape(snapshot, ["state", "channel", "attention", "note", "events"]))
        throw new PetRuleStoreError("invalid_rule");
      if (
        EVICTABLE_STATES.has(current.state) &&
        snapshot.state !== undefined &&
        snapshot.state !== current.state
      )
        // Finished rules are history; a new ask creates a fresh rule instead.
        throw new PetRuleStoreError("invalid_rule");
      const next: NoticeRule = structuredClone(current);
      if (snapshot.state !== undefined) next.state = snapshot.state;
      if (snapshot.channel !== undefined) next.channel = snapshot.channel;
      if (snapshot.attention !== undefined) next.attention = snapshot.attention;
      if ("note" in snapshot) {
        if (snapshot.note === undefined) delete next.note;
        else next.note = snapshot.note;
      }
      if (snapshot.events !== undefined) {
        if (!isEvents(snapshot.events) || next.when.kind === "schedule")
          throw new PetRuleStoreError("invalid_rule");
        next.when = { ...next.when, events: [...snapshot.events] } as NoticeRule["when"];
      }
      next.version = current.version + 1;
      next.updatedAt = Math.max(this.timestamp(), current.updatedAt);
      if (isScheduleRule(next) && current.state === "paused" && next.state === "active")
        this.renewOnResume(staged, next);
      if (!parseRule(next)) throw new PetRuleStoreError("invalid_rule");
      const key = ruleSessionKey(next);
      if (
        next.state === "active" &&
        key !== undefined &&
        [...staged.values()].some(
          (rule) => rule.id !== id && rule.state === "active" && ruleSessionKey(rule) === key,
        )
      )
        throw new PetRuleStoreError("duplicate_active_rule");
      staged.set(id, next);
      return next;
    });
  }

  /**
   * Create a schedule rule (an owner-asked follow-up). The id is derived by
   * the host from the turn that asked, so a replayed request returns the rule
   * as it is now (even edited or finished) instead of creating a second one.
   */
  createScheduleRule(input: CreateScheduleRuleInput): Promise<ScheduleNoticeRule> {
    const snapshot = structuredClone(input);
    return this.mutate((staged) => {
      const existing = staged.get(snapshot.id);
      if (existing) {
        if (!isScheduleRule(existing)) throw new PetRuleStoreError("invalid_rule");
        return unchanged(existing);
      }
      const target = normalizeTarget(snapshot.target);
      if (!target || !isChannel(snapshot.channel)) throw new PetRuleStoreError("invalid_rule");
      const at = this.timestamp();
      const rule = {
        id: snapshot.id,
        version: 1,
        origin: "user",
        createdBy: "follow-up",
        when: snapshot.when,
        then: snapshot.then,
        wake: this.scheduledWake(staged, snapshot.id, this.firstOccurrenceOf(snapshot.when, at)),
        attention: "always",
        channel: snapshot.channel,
        target,
        state: "active",
        createdAt: at,
        updatedAt: at,
      } satisfies NoticeRule;
      if (!parseRule(rule)) throw new PetRuleStoreError("invalid_rule");
      staged.set(rule.id, rule);
      return rule as ScheduleNoticeRule;
    });
  }

  /**
   * New timing for a live schedule rule: a new version and a fresh first
   * occurrence. Allowed while an occurrence is claimed: that occurrence's
   * effect is then superseded (its settle finds nothing to record) and a
   * woken Mimi turn is fenced by the version change.
   */
  rescheduleRule(id: string, expectedVersion: number, when: ScheduleWhen): Promise<NoticeRule> {
    const snapshot = structuredClone(when);
    return this.mutate((staged) => {
      const current = staged.get(id);
      if (!current) throw new PetRuleStoreError("rule_not_found");
      if (current.version !== expectedVersion) throw new PetRuleStoreError("version_conflict");
      if (!isScheduleRule(current) || EVICTABLE_STATES.has(current.state))
        throw new PetRuleStoreError("invalid_rule");
      const at = this.timestamp();
      const next: NoticeRule = {
        ...current,
        version: current.version + 1,
        when: snapshot,
        wake: this.scheduledWake(staged, id, this.firstOccurrenceOf(snapshot, at)),
        updatedAt: Math.max(at, current.updatedAt),
      };
      if (!parseRule(next)) throw new PetRuleStoreError("invalid_rule");
      staged.set(id, next);
      return next;
    });
  }

  /**
   * Durable claim of a due occurrence, taken before any effect. Undefined
   * (and nothing written) when it is not this rule's current, due, unclaimed
   * occurrence of this version: a stale or duplicate trigger is a no-op.
   */
  claimOccurrence(
    id: string,
    version: number,
    occurrence: number,
  ): Promise<ScheduleNoticeRule | undefined> {
    return this.mutate((staged) => {
      const rule = staged.get(id);
      const at = this.timestamp();
      if (
        !rule ||
        !isScheduleRule(rule) ||
        rule.state !== "active" ||
        rule.version !== version ||
        rule.wake.occurrence !== occurrence ||
        rule.wake.status !== "scheduled" ||
        dueAt(rule.wake) > at
      )
        return unchanged(undefined);
      rule.wake = {
        occurrence,
        ...(rule.wake.stagger !== undefined ? { stagger: rule.wake.stagger } : {}),
        status: "claimed",
        claimedAt: at,
        ...(rule.wake.previous ? { previous: rule.wake.previous } : {}),
      };
      rule.updatedAt = Math.max(at, rule.updatedAt);
      return rule;
    });
  }

  /**
   * Record what a claimed occurrence did. A repeating rule then moves on to
   * its next occurrence after now (never replaying the ones slept through),
   * keeping this outcome as `detail`; one that never fires again is spent.
   * `nextAfter` lets a missed occurrence hand over to the latest one that is
   * still inside its own catch-up window (the scheduler's one catch-up).
   *
   * Matched by the claim (occurrence + claimed), not the version: the owner
   * may cancel or finish the rule while its occurrence runs, and the outcome
   * is still recorded; a finished rule does not move on.
   */
  settleOccurrence(
    id: string,
    occurrence: number,
    outcome: RuleWakeOutcome,
    options: { nextAfter?: number } = {},
  ): Promise<ScheduleNoticeRule | undefined> {
    const snapshot = structuredClone(outcome);
    return this.mutate((staged) => {
      if (
        !isPatchShape(snapshot, ["status", "detail", "taskId"]) ||
        !["notified", "launched", "failed", "unknown"].includes(snapshot.status)
      )
        throw new PetRuleStoreError("invalid_rule");
      const rule = staged.get(id);
      if (
        !rule ||
        !isScheduleRule(rule) ||
        rule.wake.occurrence !== occurrence ||
        rule.wake.status !== "claimed"
      )
        return unchanged(undefined);
      this.settle(staged, rule, snapshot, options.nextAfter);
      return rule;
    });
  }

  /**
   * Startup: a claim that outlived its process may have had its effect, so it
   * is recorded `unknown` and never retried; a repeating rule moves on.
   */
  recoverClaims(): Promise<number> {
    return this.mutate((staged) => {
      let count = 0;
      for (const rule of staged.values()) {
        if (!isScheduleRule(rule) || rule.wake.status !== "claimed") continue;
        this.settle(staged, rule, {
          status: "unknown",
          detail: "上次唤醒已开始但结果未记录；未自动重试。",
        });
        count += 1;
      }
      return count === 0 ? unchanged(0) : count;
    });
  }

  private settle(
    staged: Map<string, NoticeRule>,
    rule: ScheduleNoticeRule,
    outcome: RuleWakeOutcome,
    nextAfter?: number,
  ): void {
    const at = this.timestamp();
    const detail = outcome.detail?.slice(0, WAKE_DETAIL_MAX);
    rule.updatedAt = Math.max(at, rule.updatedAt);
    const settled: RuleWake = {
      ...rule.wake,
      status: outcome.status,
      completedAt: at,
      ...(detail !== undefined ? { detail } : {}),
      ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
    };
    // A one-shot, or a rule finished while this occurrence ran, stops here.
    if (rule.when.cron === undefined || EVICTABLE_STATES.has(rule.state)) {
      rule.wake = settled;
      return;
    }
    const next = nextOccurrence(rule.when, Math.max(nextAfter ?? at, rule.wake.occurrence));
    if (next === null) {
      rule.state = "spent";
      rule.wake = settled;
      return;
    }
    rule.wake = {
      ...this.scheduledWake(staged, rule.id, next),
      ...(detail !== undefined ? { detail } : {}),
      ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
      previous: { occurrence: rule.wake.occurrence, status: outcome.status, completedAt: at },
    };
  }

  /**
   * A repeating rule switched back on counts from now (like Mimi's own rules):
   * an occurrence that came and went while it was paused is not sent late. A
   * one-shot keeps its instant and its catch-up window; a claimed occurrence
   * is left to settle.
   */
  private renewOnResume(staged: Map<string, NoticeRule>, rule: ScheduleNoticeRule): void {
    if (rule.when.cron === undefined || rule.wake.status === "claimed") return;
    const at = this.timestamp();
    if (rule.wake.status === "scheduled" && dueAt(rule.wake) > at) return;
    const { detail, taskId, previous } = rule.wake;
    rule.wake = {
      ...this.scheduledWake(staged, rule.id, this.firstOccurrenceOf(rule.when, at, rule.id)),
      ...(detail !== undefined ? { detail } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(previous ? { previous } : {}),
    };
  }

  /** A fresh occurrence, staggered behind other live schedule rules due that minute. */
  private scheduledWake(staged: Map<string, NoticeRule>, id: string, occurrence: number): RuleWake {
    const others = [...staged.values()]
      .filter((rule) => rule.id !== id && !EVICTABLE_STATES.has(rule.state) && rule.wake)
      .map((rule) => rule.wake!.occurrence);
    const stagger = staggerFor(occurrence, others);
    return { occurrence, ...(stagger > 0 ? { stagger } : {}), status: "scheduled" };
  }

  private firstOccurrenceOf(when: ScheduleWhen, at: number, id?: string): number {
    if (!parseScheduleWhen(when, { halfHourly: id === "system-heartbeat" }))
      throw new PetRuleStoreError("invalid_rule");
    // The one date search a registration does (a yearly cron scans ~a year of minutes).
    const first = firstOccurrence(when, at);
    if (first === null) throw new PetRuleStoreError("schedule_never_fires");
    if (first <= at) throw new PetRuleStoreError("schedule_in_past");
    return first;
  }

  /**
   * Bring one of Mimi's schedule rules in line with the owner's settings.
   * Absent until first switched on; then only paused. A new timing, or
   * switching back on, is a new version with a fresh first occurrence after
   * now, so an occurrence slept through while it was off never fires late.
   */
  setSystemSchedule(
    id: SystemScheduleRuleId,
    input: SystemScheduleInput,
  ): Promise<ScheduleNoticeRule | undefined> {
    const snapshot = structuredClone(input);
    return this.mutate((staged) => {
      const then = systemScheduleThen(id);
      if (!then || (snapshot.state !== "active" && snapshot.state !== "paused"))
        throw new PetRuleStoreError("invalid_rule");
      const current = staged.get(id);
      if (current && !isScheduleRule(current)) throw new PetRuleStoreError("invalid_rule");
      if (!current && snapshot.state === "paused") return unchanged(undefined);
      const retimed = !current || canonicalJson(current.when) !== canonicalJson(snapshot.when);
      if (current && !retimed && current.state === snapshot.state) return unchanged(current);
      const at = this.timestamp();
      const fresh = snapshot.state === "active" && (retimed || current?.state !== "active");
      const rule = {
        id,
        version: (current?.version ?? 0) + 1,
        origin: "system",
        createdBy: "system",
        when: snapshot.when,
        then: structuredClone(then),
        // A paused rule keeps its (stale) occurrence; it is renewed when switched back on.
        wake:
          fresh || !current
            ? this.scheduledWake(staged, id, this.firstOccurrenceOf(snapshot.when, at, id))
            : current.wake,
        attention: "always",
        channel: "auto",
        target: { kind: "owner" },
        state: snapshot.state,
        createdAt: current?.createdAt ?? at,
        updatedAt: Math.max(at, current?.updatedAt ?? at),
      } satisfies NoticeRule;
      if (!parseRule(rule)) throw new PetRuleStoreError("invalid_rule");
      staged.set(id, rule);
      return rule as ScheduleNoticeRule;
    });
  }

  /** Toggle / tune the "every Session" rule; creates it from the default on first use. */
  setSystemRule(id: SystemNoticeRuleId, patch: SystemNoticeRulePatch): Promise<NoticeRule> {
    const snapshot = structuredClone(patch);
    return this.mutate((staged) => {
      if (id !== SYSTEM_RULE_ID) throw new PetRuleStoreError("rule_not_found");
      if (!isPatchShape(snapshot, ["state", "channel", "events"]))
        throw new PetRuleStoreError("invalid_rule");
      if (snapshot.events !== undefined && !isEvents(snapshot.events))
        throw new PetRuleStoreError("invalid_rule");
      const at = this.timestamp();
      const current = staged.get(SYSTEM_RULE_ID);
      const base = current ?? { ...defaultSystemRule(), createdAt: at };
      const next: NoticeRule = {
        ...structuredClone(base),
        version: base.version + 1,
        ...(snapshot.state !== undefined ? { state: snapshot.state } : {}),
        ...(snapshot.channel !== undefined ? { channel: snapshot.channel } : {}),
        updatedAt: Math.max(at, base.updatedAt),
      };
      if (snapshot.events !== undefined) {
        next.when = { kind: "all-sessions", events: [...snapshot.events], onlyWhenAway: true };
      }
      if (!parseRule(next)) throw new PetRuleStoreError("invalid_rule");
      staged.set(SYSTEM_RULE_ID, next);
      return next;
    });
  }

  private timestamp(): number {
    const at = this.now();
    if (!isTimestamp(at)) throw new Error("invalid rule store clock");
    return at;
  }

  private mutate<T>(apply: (staged: Map<string, NoticeRule>) => T | Unchanged<T>): Promise<T> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.load())
      .then(() =>
        this.lock(async () => {
          const staged = new Map(
            [...this.rules].map(([id, rule]) => [id, structuredClone(rule)] as const),
          );
          const outcome = apply(staged);
          // A no-op (a stale trigger, a replay, nothing to recover) writes
          // nothing and tells no one: it works even on a read-only file.
          if (isUnchanged(outcome)) return { result: outcome.value, changed: false };
          if (this.unwritable) throw new PetRuleStoreError("rule_store_unwritable");
          const result = outcome;
          this.enforceCap(staged);
          for (const rule of staged.values()) {
            if (!parseRule(rule)) throw new PetRuleStoreError("invalid_rule");
          }
          await writeOwnerJsonAtomic(
            this.path,
            {
              version: SCHEMA_VERSION,
              rules: [...staged.values()],
              quarantine: this.quarantine,
            } satisfies PetRuleFile,
            MAX_FILE_BYTES,
            // Rewritten on every rule change: no indentation.
            { compact: true },
          );
          this.rules = staged;
          return { result: structuredClone(result), changed: true };
        }),
      )
      .then(({ result, changed }) => {
        if (!changed) return result;
        for (const listener of this.listeners) {
          try {
            listener();
          } catch {
            /* observers cannot roll back a committed mutation */
          }
        }
        return result;
      });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Make room by evicting the oldest finished rules, then the oldest one-shot
   * follow-ups that already fired. Other active and paused rules (and the
   * system rule) are live owner intent and are never evicted; if
   * there is still no room for a mutation that adds a rule, it is refused.
   */
  private enforceCap(staged: Map<string, NoticeRule>): void {
    if (staged.size <= this.maxRules) return;
    const byAge = (a: NoticeRule, b: NoticeRule) =>
      a.updatedAt - b.updatedAt || a.id.localeCompare(b.id);
    // Then one-shot follow-ups that already reached the owner: kept on the
    // list until handled, but they will never fire again. A failed or
    // unknown one still needs the owner's attention and is kept.
    const fired = (rule: NoticeRule) =>
      isScheduleRule(rule) &&
      rule.origin !== "system" &&
      rule.when.at !== undefined &&
      (rule.wake.status === "notified" || rule.wake.status === "launched");
    const evictable = [
      ...[...staged.values()].filter((rule) => EVICTABLE_STATES.has(rule.state)).sort(byAge),
      ...[...staged.values()]
        .filter((rule) => !EVICTABLE_STATES.has(rule.state) && fired(rule))
        .sort(byAge),
    ];
    for (const rule of evictable) {
      if (staged.size <= this.maxRules) break;
      staged.delete(rule.id);
    }
    // A file already over the cap (e.g. a lowered maxRules) must still accept
    // mutations that do not grow it, such as cancelling a rule.
    if (staged.size > this.maxRules && staged.size > this.rules.size) {
      throw new PetRuleStoreError("rule_store_full");
    }
  }

  private reset(): void {
    this.rules = new Map();
    this.quarantine = [];
    this.unwritable = false;
  }

  private async quarantineFile(event: string, detail: Record<string, unknown>): Promise<void> {
    const quarantinePath = await quarantineCorruptJson(this.path);
    dlog("main", event, { ...detail, ...(quarantinePath ? { quarantinePath } : {}) });
    this.reset();
  }

  private async loadFromDisk(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = await readBoundedJson(this.path, MAX_FILE_BYTES);
    } catch (error) {
      // Unreadable state must not disable notices forever, but the bytes are
      // moved aside for diagnosis rather than overwritten in place.
      await this.quarantineFile("pet.rules.unreadable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (parsed === undefined) {
      this.reset();
      return;
    }
    if (!isRecord(parsed) || typeof parsed.version !== "number") {
      await this.quarantineFile("pet.rules.invalid", {});
      return;
    }
    if (Number.isSafeInteger(parsed.version) && parsed.version > SCHEMA_VERSION) {
      // Written by a newer build: leave it exactly where it is so that build
      // can still read it, and refuse to write over it from here.
      this.reset();
      this.unwritable = true;
      dlog("main", "pet.rules.newer_schema", { version: parsed.version });
      return;
    }
    if (
      parsed.version !== SCHEMA_VERSION ||
      !Array.isArray(parsed.rules) ||
      parsed.rules.length > MAX_LOADED_ROWS ||
      (parsed.quarantine !== undefined && !Array.isArray(parsed.quarantine))
    ) {
      await this.quarantineFile("pet.rules.invalid", { version: parsed.version });
      return;
    }
    const loaded = new Map<string, NoticeRule>();
    const quarantine: unknown[] = [];
    let rejected = 0;
    let restored = 0;
    // Quarantined rows are read again: an older build quarantines the rows it
    // does not know (schedule rules) on its first write, and they come back
    // here. Live rows first, so on a tie the live copy wins; else newest wins.
    const live = parsed.rules.length;
    const held: unknown[] = Array.isArray(parsed.quarantine) ? parsed.quarantine : [];
    for (const [index, stored] of [...parsed.rules, ...held].entries()) {
      const fromQuarantine = index >= live;
      const row = migrateLegacyRow(stored);
      const rule = parseRule(row);
      const seen = rule ? loaded.get(rule.id) : undefined;
      if (rule && !seen) {
        loaded.set(rule.id, rule);
        if (fromQuarantine) restored += 1;
        continue;
      }
      if (rule && seen && rule.version > seen.version) {
        // Keep the newer copy of a duplicated id; the older one is kept aside.
        loaded.set(rule.id, rule);
        quarantine.push(seen);
        if (fromQuarantine) restored += 1;
      } else {
        // Quarantine exactly what was on disk, not the migrated view.
        quarantine.push(stored);
      }
      if (!fromQuarantine) rejected += 1;
    }
    if (rejected > 0) dlog("main", "pet.rules.quarantined_rows", { rejected });
    if (restored > 0) dlog("main", "pet.rules.restored_rows", { restored });
    this.rules = loaded;
    this.quarantine = quarantine;
    this.unwritable = false;
  }
}
