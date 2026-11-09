import { randomUUID } from "node:crypto";
import type { PetLongTaskCompletionTarget } from "@cjhyy/code-shell-pet";
import {
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

/** The IM origin a notice should go back to; same shape as a long task's completion target. */
export type PetChatRoute = PetLongTaskCompletionTarget;

export type NoticeRuleState = "active" | "paused" | "spent" | "completed" | "cancelled";
export type SystemNoticeRuleId = "all-sessions";

export interface NoticeRule {
  id: string;
  version: number;
  origin: "user" | "delegation" | "system";
  createdBy: NoticeRuleUpsert["createdBy"] | "system";
  when:
    | {
        kind: "session";
        sessionId: string;
        runtime: "native";
        events: NoticeEvent[];
        scope: "turn" | "goal";
        armedAtSeq: number;
      }
    | { kind: "all-sessions"; events: NoticeEvent[]; onlyWhenAway: true };
  then: { mode: "notify" };
  attention: NoticeAttention;
  channel: NoticeChannel;
  target: { kind: "route"; route: PetChatRoute } | { kind: "owner" };
  note?: string;
  state: NoticeRuleState;
  createdAt: number;
  updatedAt: number;
}

export type UpsertSessionNoticeRuleInput = NoticeRuleUpsert & {
  target: NoticeRule["target"];
  origin: NoticeRule["origin"];
  armedAtSeq: number;
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
  | "invalid_rule";

export class PetRuleStoreError extends Error {
  constructor(readonly code: PetRuleStoreErrorCode) {
    super(code);
    this.name = "PetRuleStoreError";
  }
}

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_RULES = 2_000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LOADED_ROWS = 10_000;
const SYSTEM_RULE_ID: SystemNoticeRuleId = "all-sessions";
const RULE_ID_PATTERN = /^rule-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const ALL_EVENTS: readonly NoticeEvent[] = ["done", "failed", "blocked"];
const ATTENTIONS: readonly NoticeAttention[] = ["always", "important", "digest", "muted"];
const STATES: readonly NoticeRuleState[] = ["active", "paused", "spent", "completed", "cancelled"];
const CREATORS: readonly NoticeRule["createdBy"][] = [
  "notify-me",
  "bell",
  "delegation",
  "watch-session",
  "system",
];
/** Terminal rules are history; only they may be evicted to make room. */
const EVICTABLE_STATES: ReadonlySet<NoticeRuleState> = new Set(["spent", "completed", "cancelled"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const CHANNEL_MAX_LENGTH = 40;
const NOTE_MAX_LENGTH = 500;

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
  return isText(value, CHANNEL_MAX_LENGTH) && value.trim() === value;
}

function isNote(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= NOTE_MAX_LENGTH &&
    value.trim() === value
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isEvents(value: unknown): value is NoticeEvent[] {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= ALL_EVENTS.length &&
    value.every((event) => (ALL_EVENTS as readonly unknown[]).includes(event)) &&
    new Set(value).size === value.length
  );
}

function isRoute(value: unknown): value is PetChatRoute {
  if (!isRecord(value)) return false;
  if (
    !hasOnlyKeys(value, [
      "kind",
      "channel",
      "target",
      "senderId",
      "isDirectMessage",
      "replyButton",
      "replyAttachmentKinds",
    ])
  )
    return false;
  const kinds = value.replyAttachmentKinds;
  return (
    value.kind === "im-gateway" &&
    isText(value.channel, 128) &&
    isText(value.target, 4_096) &&
    (value.senderId === undefined || isText(value.senderId, 512)) &&
    (value.isDirectMessage === undefined || typeof value.isDirectMessage === "boolean") &&
    (value.replyButton === undefined ||
      value.replyButton === "native" ||
      value.replyButton === "link") &&
    (kinds === undefined ||
      (Array.isArray(kinds) &&
        kinds.length <= 4 &&
        new Set(kinds).size === kinds.length &&
        kinds.every((kind) => ["image", "file", "audio", "video"].includes(kind as string))))
  );
}

function isTarget(value: unknown): value is NoticeRule["target"] {
  if (!isRecord(value)) return false;
  if (value.kind === "owner") return hasOnlyKeys(value, ["kind"]);
  return value.kind === "route" && hasOnlyKeys(value, ["kind", "route"]) && isRoute(value.route);
}

/** Identity of a target for "one active rule per session + target". Deep-equal, order-insensitive. */
function targetKey(target: NoticeRule["target"]): string {
  if (target.kind === "owner") return "owner";
  const route = target.route;
  return JSON.stringify([
    route.kind,
    route.channel,
    route.target,
    route.senderId ?? null,
    route.isDirectMessage ?? null,
    route.replyButton ?? null,
    [...(route.replyAttachmentKinds ?? [])].sort(),
  ]);
}

function parseWhen(value: unknown): NoticeRule["when"] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "session") {
    if (
      !hasOnlyKeys(value, ["kind", "sessionId", "runtime", "events", "scope", "armedAtSeq"]) ||
      !isText(value.sessionId, 256) ||
      value.runtime !== "native" ||
      !isEvents(value.events) ||
      (value.scope !== "turn" && value.scope !== "goal") ||
      !isTimestamp(value.armedAtSeq)
    )
      return undefined;
    return value as NoticeRule["when"];
  }
  if (value.kind === "all-sessions") {
    if (
      !hasOnlyKeys(value, ["kind", "events", "onlyWhenAway"]) ||
      !isEvents(value.events) ||
      value.onlyWhenAway !== true
    )
      return undefined;
    return value as NoticeRule["when"];
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
    ])
  )
    return undefined;
  const when = parseWhen(value.when);
  if (!when) return undefined;
  if (
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !(CREATORS as readonly unknown[]).includes(value.createdBy) ||
    !isRecord(value.then) ||
    value.then.mode !== "notify" ||
    !hasOnlyKeys(value.then, ["mode"]) ||
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
  if (when.kind === "session") {
    if (
      typeof value.id !== "string" ||
      !RULE_ID_PATTERN.test(value.id) ||
      (value.origin !== "user" && value.origin !== "delegation") ||
      value.createdBy === "system"
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
    when: { kind: "all-sessions", events: [...ALL_EVENTS], onlyWhenAway: true },
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
  return `${sessionId}\u0000${targetKey(target)}`;
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
  activeForSession(sessionId: string): NoticeRule[] {
    const result: NoticeRule[] = [];
    for (const rule of this.rules.values()) {
      if (rule.state !== "active") continue;
      if (rule.when.kind === "session" && rule.when.sessionId !== sessionId) continue;
      if (rule.when.kind === "all-sessions") continue;
      result.push(structuredClone(rule));
    }
    const system = this.rules.get(SYSTEM_RULE_ID);
    if (system?.state === "active") result.push(structuredClone(system));
    return result;
  }

  systemRule(id: SystemNoticeRuleId): NoticeRule {
    if (id !== SYSTEM_RULE_ID) throw new PetRuleStoreError("rule_not_found");
    const rule = this.rules.get(SYSTEM_RULE_ID);
    return rule ? structuredClone(rule) : defaultSystemRule();
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
   */
  upsertSessionRule(input: UpsertSessionNoticeRuleInput): Promise<NoticeRule> {
    const snapshot = structuredClone(input);
    return this.mutate((staged) => {
      const { target, origin, armedAtSeq, ...wire } = snapshot;
      const upsert = parseNoticeRuleUpsert(wire);
      if (
        !upsert ||
        !isTarget(target) ||
        (origin !== "user" && origin !== "delegation") ||
        !isTimestamp(armedAtSeq)
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
        armedAtSeq,
      };
      if (existing) {
        const next: NoticeRule = {
          ...existing,
          version: existing.version + 1,
          when,
          channel: upsert.channel,
          attention: upsert.attention,
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
        target: structuredClone(target),
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
      const next: NoticeRule = structuredClone(current);
      if (snapshot.state !== undefined) next.state = snapshot.state;
      if (snapshot.channel !== undefined) next.channel = snapshot.channel;
      if (snapshot.attention !== undefined) next.attention = snapshot.attention;
      if ("note" in snapshot) {
        if (snapshot.note === undefined) delete next.note;
        else next.note = snapshot.note;
      }
      if (snapshot.events !== undefined) {
        if (!isEvents(snapshot.events)) throw new PetRuleStoreError("invalid_rule");
        next.when = { ...next.when, events: [...snapshot.events] } as NoticeRule["when"];
      }
      next.version = current.version + 1;
      next.updatedAt = Math.max(this.timestamp(), current.updatedAt);
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

  private mutate<T extends NoticeRule>(apply: (staged: Map<string, NoticeRule>) => T): Promise<T> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.load())
      .then(() =>
        this.lock(async () => {
          if (this.unwritable) throw new PetRuleStoreError("rule_store_unwritable");
          const staged = new Map(
            [...this.rules].map(([id, rule]) => [id, structuredClone(rule)] as const),
          );
          const result = apply(staged);
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
          );
          this.rules = staged;
          return structuredClone(result);
        }),
      )
      .then((result) => {
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
   * Make room by evicting the oldest finished rules. Active and paused rules
   * (and the system rule) are live owner intent and are never evicted; if
   * there is still no room for a mutation that adds a rule, it is refused.
   */
  private enforceCap(staged: Map<string, NoticeRule>): void {
    if (staged.size <= this.maxRules) return;
    const evictable = [...staged.values()]
      .filter((rule) => EVICTABLE_STATES.has(rule.state))
      .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id));
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
    const quarantine: unknown[] = Array.isArray(parsed.quarantine) ? [...parsed.quarantine] : [];
    let rejected = 0;
    for (const row of parsed.rules) {
      const rule = parseRule(row);
      if (rule && !loaded.has(rule.id)) {
        loaded.set(rule.id, rule);
      } else {
        quarantine.push(row);
        rejected += 1;
      }
    }
    if (rejected > 0) dlog("main", "pet.rules.quarantined_rows", { rejected });
    this.rules = loaded;
    this.quarantine = quarantine;
    this.unwritable = false;
  }
}
