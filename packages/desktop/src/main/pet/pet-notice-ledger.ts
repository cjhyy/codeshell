import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dlog } from "../desktop-logger.js";
import {
  quarantineCorruptJson,
  readBoundedJson,
  serializeOwnerJson,
  writeOwnerJsonAtomic,
} from "./bounded-json-store.js";

/** Rewritten on every notice: no indentation. */
const COMPACT = { compact: true } as const;
import {
  hostTimezoneOffsetMin,
  localHourIndex,
  type DedupeLookup,
  type NoticePriority,
  type RouteDecision,
} from "./pet-notice-policy.js";

export type NoticeDeliveryStatus =
  | "claimed"
  | "accepted"
  | "failed"
  | "queued"
  | "held"
  | "unknown"
  | "revoked";

/** Everything but `claimed`, which only {@link PetNoticeLedger.claim} sets. */
export type NoticeSettleStatus = Exclude<NoticeDeliveryStatus, "claimed">;

export interface NoticeDelivery {
  /**
   * Gateway idempotency key: sha256(record id), first 24 hex chars. Resends
   * reuse the record and so the key; a notice re-emitted as a new record
   * (a later digest, a dedupe key seen again after retention) gets a new one.
   */
  key: string;
  channel?: string;
  status: NoticeDeliveryStatus;
  /** Number of claims (send attempts). */
  attempts: number;
  /** Epoch ms of the last status change (claim or settle). */
  at: number;
  /** Epoch ms of the latest claim; the hourly caps bucket sends by this. */
  claimedAt?: number;
  error?: string;
}

/**
 * Where a decision prompt stands. Grace is not a phase: until the first
 * prompt is submitted there is no record, and the grace end is derived from
 * the pending decision's own `createdAt`.
 *
 *   desktop    submitted; no IM conversation can answer it (yet): kept on the
 *              desktop, queued, held, or sent as the generic group text
 *   escalated  the one "owner left" copy (`:away`) was submitted, not (yet)
 *              answerable either
 *   im         a copy reached the conversation that may answer it (`channel`)
 *   answered / expired / revoked   the decision ended: resolved, timed out,
 *              or gone without an answer (cancelled, worker lost)
 */
export type NoticePromptPhase = "desktop" | "escalated" | "im" | "answered" | "expired" | "revoked";

/** The lifecycle of one decision prompt, kept on its first `session.blocked` record. */
export interface NoticeDecisionPrompt {
  /** The 12-hex reply code (upper case). */
  code: string;
  phase: NoticePromptPhase;
  /** The decision's deadline; absent: it waits until answered. */
  deadline?: number;
  /** A model question: Core applies its timeout, so no expiry notice. */
  skippable?: true;
  /** Bare replies that address this prompt (option labels, 拒绝 …), for late short replies. */
  replies?: string[];
  /** The IM channel of the copy an answering conversation accepted. */
  channel?: string;
  /** When it reached that conversation. */
  imAt?: number;
  /** When the "owner left" copy was submitted. */
  escalatedAt?: number;
  endedAt?: number;
  /** Expired after reaching IM: the "已超时" notice owed there, and whether the router took it. */
  expiryNotice?: { channel: string; sent: boolean };
}

/** What a prompt update may change; the code never changes. */
export type NoticeDecisionPromptPatch = Partial<Omit<NoticeDecisionPrompt, "code" | "replies">>;

export interface NoticeRecord {
  id: string;
  kind: string;
  priority: NoticePriority;
  dedupeKey: string;
  sessionId?: string;
  requestId?: string;
  /** Queued notices default to {@link NOTICE_QUEUED_TTL_MS} after they are queued. */
  expiresAt?: number;
  ruleIds: string[];
  facts: unknown;
  /** Frozen by the first claim, so every resend carries the same text. */
  body?: string;
  decision?: RouteDecision;
  delivery?: NoticeDelivery;
  /** Decision prompts only: where the prompt stands (see {@link NoticeDecisionPrompt}). */
  prompt?: NoticeDecisionPrompt;
  createdAt: number;
}

/**
 * A new notice. Its delivery, when given, may only start as `held` (waiting
 * for the digest) or `queued` (waiting for an IM channel); the ledger fills
 * in the key and counters. Without one, a `digest` decision starts `held`
 * and a `queued` decision starts `queued` (channel = `decision.im`).
 */
export type NoticeRecordInput = Omit<NoticeRecord, "id" | "createdAt" | "delivery" | "prompt"> & {
  delivery?: { status: "held" | "queued"; channel?: string };
  /** A decision prompt starts in phase `desktop`; replies that are not plain text are dropped. */
  prompt?: Pick<NoticeDecisionPrompt, "code" | "deadline" | "skippable" | "replies">;
};

export interface PetNoticeLedgerOptions {
  path: string;
  now?: () => number;
  /**
   * Maps an instant to its local clock hour; two instants with the same key
   * are in the same hour for the hourly caps. Defaults to
   * `localHourIndex(ms, hostTimezoneOffsetMin(ms))`, the policy's own math
   * with the offset sampled at that instant (DST-aware).
   */
  localHourKey?: (ms: number) => string;
  /** Soft cap on records; only terminal records are evicted to honour it. */
  maxRecords?: number;
  /** Hard cap on the file size. */
  maxBytes?: number;
  /** Cap on dedupe index entries (default 20 000); hashes of kept records are exempt. */
  maxDedupeEntries?: number;
}

export type PetNoticeLedgerErrorCode =
  | "notice_not_found"
  | "notice_already_settled"
  | "invalid_transition"
  | "notice_ledger_unwritable"
  | "notice_ledger_full"
  | "invalid_notice";

export class PetNoticeLedgerError extends Error {
  constructor(readonly code: PetNoticeLedgerErrorCode) {
    super(code);
    this.name = "PetNoticeLedgerError";
  }
}

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_RECORDS = 5_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const RECORD_ID = /^notice-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** A fresh ledger record id (`notice-<uuid>`). */
export function newNoticeRecordId(): string {
  return `notice-${randomUUID()}`;
}

export function isNoticeRecordId(value: string): boolean {
  return RECORD_ID.test(value);
}

/** A key seen within this window is a duplicate, even after its record was evicted. */
export const NOTICE_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A claim younger than this at startup is resent; older ones are marked unknown. */
export const NOTICE_RESEND_WINDOW_MS = 10 * 60_000;
/** Default lifetime of a queued notice that has no `expiresAt` of its own. */
export const NOTICE_QUEUED_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_DEDUPE_ENTRIES = 20_000;
/** Overflow quarantine sidecars kept next to the ledger; older ones are deleted. */
export const NOTICE_QUARANTINE_SIDECARS_KEPT = 5;
const MAX_TEXT = 1_024;
const MAX_BODY = 32_000;
const MAX_ERROR = 2_000;
const MAX_RULE_IDS = 100;
const HEX24 = /^[0-9a-f]{24}$/u;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;
const PRIORITIES: readonly NoticePriority[] = ["P0", "P1", "P2"];
const OUTLETS: readonly RouteDecision["outlet"][] = [
  "im",
  "desktop",
  "both",
  "digest",
  "record",
  "drop",
];
const STATUSES: readonly NoticeDeliveryStatus[] = [
  "claimed",
  "accepted",
  "failed",
  "queued",
  "held",
  "unknown",
  "revoked",
];
const SETTLE_STATUSES: readonly NoticeDeliveryStatus[] = STATUSES.filter(
  (status) => status !== "claimed",
);
const PROMPT_CODE = /^[0-9A-F]{12}$/u;
const MAX_PROMPT_REPLIES = 32;
const PROMPT_PHASES: readonly NoticePromptPhase[] = [
  "desktop",
  "escalated",
  "im",
  "answered",
  "expired",
  "revoked",
];
const ENDED_PHASES: ReadonlySet<NoticePromptPhase> = new Set(["answered", "expired", "revoked"]);
/**
 * Prompt phases only move forward; an ended prompt keeps its phase (its
 * expiry notice may still be updated).
 */
const PROMPT_TRANSITIONS: Readonly<Record<NoticePromptPhase, ReadonlySet<NoticePromptPhase>>> = {
  desktop: new Set(["desktop", "escalated", "im", "answered", "expired", "revoked"]),
  escalated: new Set(["escalated", "im", "answered", "expired", "revoked"]),
  im: new Set(["im", "answered", "expired", "revoked"]),
  answered: new Set(["answered"]),
  expired: new Set(["expired"]),
  revoked: new Set(["revoked"]),
};

/** The decision ended (answered, expired or revoked). */
export function isPromptEnded(phase: NoticePromptPhase): boolean {
  return ENDED_PHASES.has(phase);
}

/** Work still owed to the owner; these records are never evicted. */
const LIVE_STATUSES: ReadonlySet<NoticeDeliveryStatus> = new Set(["claimed", "queued", "held"]);

/**
 * Delivery state machine. Rows are the current status ("none" = no delivery
 * yet); columns are the target (`claimed` via claim(), the rest via settle()).
 *
 *              claimed accepted failed unknown queued held revoked
 *   none         ok      -        -      -       ok    ok    ok
 *   held         ok      -        -      -       ok    ok    ok
 *   queued       ok      -        -      -       ok    ok    ok
 *   failed       ok      -        -      -       ok    ok    ok
 *   claimed      ok     ok       ok     ok       ok    -     ok
 *   unknown      m       -        -      -       -     -     ok
 *   accepted     x       x        x      x       x     x     x
 *   revoked      x       x        x      x       x     x     x
 *
 * `-` throws invalid_transition; `x` throws notice_already_settled; `m` is
 * allowed only with `claim(..., { manualRetry: true })`.
 * claimed → claimed is a resend after a restart; claimed → queued is "send
 * failed, retry when the channel is back". An `unknown` notice may already
 * have reached the owner, so it is never retried automatically: only an
 * explicit owner action resends it (same idempotency key, so a gateway that
 * honours it can still collapse the duplicate).
 */
const TRANSITIONS: Readonly<
  Record<NoticeDeliveryStatus | "none", ReadonlySet<NoticeDeliveryStatus>>
> = {
  none: new Set(["claimed", "queued", "held", "revoked"]),
  held: new Set(["claimed", "queued", "held", "revoked"]),
  queued: new Set(["claimed", "queued", "held", "revoked"]),
  failed: new Set(["claimed", "queued", "held", "revoked"]),
  claimed: new Set(["claimed", "accepted", "failed", "unknown", "queued", "revoked"]),
  unknown: new Set(["revoked"]),
  accepted: new Set(),
  revoked: new Set(),
};
const FINAL_STATUSES: ReadonlySet<NoticeDeliveryStatus> = new Set(["accepted", "revoked"]);

function assertTransition(
  from: NoticeDelivery | undefined,
  to: NoticeDeliveryStatus,
  manualRetry = false,
): void {
  const status = from?.status ?? "none";
  if (status !== "none" && FINAL_STATUSES.has(status))
    throw new PetNoticeLedgerError("notice_already_settled");
  if (status === "unknown" && to === "claimed" && manualRetry) return;
  if (!TRANSITIONS[status].has(to)) throw new PetNoticeLedgerError("invalid_transition");
}

interface PetNoticeFile {
  version: typeof SCHEMA_VERSION;
  records: NoticeRecord[];
  /**
   * sha256(dedupeKey)[0..24] → createdAt of the first record with that key
   * inside the retention window. Kept after the record is evicted.
   */
  dedupe: Array<[string, number]>;
  /** Rows this build could not understand, carried forward unchanged. */
  quarantine: unknown[];
}

interface LedgerState {
  records: Map<string, NoticeRecord>;
  dedupe: Map<string, number>;
  quarantine: unknown[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isText(value: unknown, max = MAX_TEXT): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !CONTROL_CHARS.test(value)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T>(values: readonly T[], value: unknown): value is T {
  return (values as readonly unknown[]).includes(value);
}

function parseDecision(value: unknown): RouteDecision | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["outlet", "im", "queued", "reason"]))
    return undefined;
  if (
    !isOneOf(OUTLETS, value.outlet) ||
    !isText(value.reason, 64) ||
    (value.im !== undefined && !isText(value.im, 64)) ||
    (value.queued !== undefined && typeof value.queued !== "boolean")
  )
    return undefined;
  return value as unknown as RouteDecision;
}

function parseDelivery(value: unknown): NoticeDelivery | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["key", "channel", "status", "attempts", "at", "claimedAt", "error"])
  )
    return undefined;
  if (
    typeof value.key !== "string" ||
    !HEX24.test(value.key) ||
    (value.channel !== undefined && !isText(value.channel, 64)) ||
    !isOneOf(STATUSES, value.status) ||
    !isTimestamp(value.attempts) ||
    !isTimestamp(value.at) ||
    (value.claimedAt !== undefined && !isTimestamp(value.claimedAt)) ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || value.error.length > MAX_ERROR))
  )
    return undefined;
  return value as unknown as NoticeDelivery;
}

const PROMPT_KEYS = [
  "code",
  "phase",
  "deadline",
  "skippable",
  "replies",
  "channel",
  "imAt",
  "escalatedAt",
  "endedAt",
  "expiryNotice",
] as const;

function parsePrompt(value: unknown): NoticeDecisionPrompt | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, PROMPT_KEYS)) return undefined;
  const notice = value.expiryNotice;
  if (
    typeof value.code !== "string" ||
    !PROMPT_CODE.test(value.code) ||
    !isOneOf(PROMPT_PHASES, value.phase) ||
    (value.deadline !== undefined && !isTimestamp(value.deadline)) ||
    (value.skippable !== undefined && value.skippable !== true) ||
    (value.replies !== undefined &&
      (!Array.isArray(value.replies) ||
        value.replies.length > MAX_PROMPT_REPLIES ||
        !value.replies.every((reply) => isText(reply)))) ||
    (value.channel !== undefined && !isText(value.channel, 64)) ||
    (value.imAt !== undefined && !isTimestamp(value.imAt)) ||
    (value.escalatedAt !== undefined && !isTimestamp(value.escalatedAt)) ||
    (value.endedAt !== undefined && !isTimestamp(value.endedAt)) ||
    (notice !== undefined &&
      (!isRecord(notice) ||
        !hasOnlyKeys(notice, ["channel", "sent"]) ||
        !isText(notice.channel, 64) ||
        typeof notice.sent !== "boolean"))
  )
    return undefined;
  return value as unknown as NoticeDecisionPrompt;
}

/**
 * Loading is tolerant of a prompt this build cannot read (a newer phase, a
 * malformed field): the record is kept as an ordinary notice without it.
 */
function parseStoredRecord(value: unknown): NoticeRecord | undefined {
  if (isRecord(value) && "prompt" in value && !parsePrompt(value.prompt)) {
    const { prompt: _unreadable, ...rest } = value;
    return parseNoticeRecord(rest);
  }
  return parseNoticeRecord(value);
}

/** Strict row validator; anything it rejects is quarantined, never dropped. */
function parseNoticeRecord(value: unknown): NoticeRecord | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "kind",
      "priority",
      "dedupeKey",
      "sessionId",
      "requestId",
      "expiresAt",
      "ruleIds",
      "facts",
      "body",
      "decision",
      "delivery",
      "prompt",
      "createdAt",
    ])
  )
    return undefined;
  if (
    !isText(value.id, 128) ||
    !isText(value.kind, 64) ||
    !isOneOf(PRIORITIES, value.priority) ||
    !isText(value.dedupeKey) ||
    (value.sessionId !== undefined && !isText(value.sessionId, 256)) ||
    (value.requestId !== undefined && !isText(value.requestId, 256)) ||
    (value.expiresAt !== undefined && !isTimestamp(value.expiresAt)) ||
    !Array.isArray(value.ruleIds) ||
    value.ruleIds.length > MAX_RULE_IDS ||
    !value.ruleIds.every((id) => isText(id, 256)) ||
    !("facts" in value) ||
    value.facts === undefined ||
    (value.body !== undefined &&
      (typeof value.body !== "string" || value.body.length > MAX_BODY)) ||
    (value.decision !== undefined && !parseDecision(value.decision)) ||
    (value.delivery !== undefined && !parseDelivery(value.delivery)) ||
    (value.prompt !== undefined && !parsePrompt(value.prompt)) ||
    !isTimestamp(value.createdAt)
  )
    return undefined;
  return value as unknown as NoticeRecord;
}

function hex24(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

/** Dedupe hashes of every record still in the ledger. */
function recordHashes(staged: LedgerState): Set<string> {
  return new Set([...staged.records.values()].map((record) => hex24(record.dedupeKey)));
}

/** A decision prompt still open is live work too: its record is never evicted. */
function isEvictable(record: NoticeRecord): boolean {
  if (record.prompt && !isPromptEnded(record.prompt.phase)) return false;
  return !record.delivery || !LIVE_STATUSES.has(record.delivery.status);
}

function initialPrompt(input: NoticeRecordInput["prompt"]): NoticeDecisionPrompt | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new PetNoticeLedgerError("invalid_notice");
  const replies = Array.isArray(input.replies)
    ? [...new Set(input.replies.filter((reply) => isText(reply)))].slice(0, MAX_PROMPT_REPLIES)
    : [];
  return {
    code: input.code,
    phase: "desktop",
    ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    ...(input.skippable === true ? { skippable: true } : {}),
    ...(replies.length > 0 ? { replies } : {}),
  };
}

function defaultLocalHourKey(ms: number): string {
  return String(localHourIndex(ms, hostTimezoneOffsetMin(ms)));
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Rebuild an input with only known fields, dropping `undefined` and non-JSON values. */
function normalizeInput(input: NoticeRecordInput, id: string, createdAt: number): NoticeRecord {
  const initial = input.delivery ?? impliedDelivery(input.decision);
  if (
    initial !== undefined &&
    (!isRecord(initial) ||
      !hasOnlyKeys(initial, ["status", "channel"]) ||
      (initial.status !== "held" && initial.status !== "queued") ||
      (initial.channel !== undefined && !isText(initial.channel, 64)))
  )
    throw new PetNoticeLedgerError("invalid_notice");
  const expiresAt =
    input.expiresAt ??
    (initial?.status === "queued" ? createdAt + NOTICE_QUEUED_TTL_MS : undefined);
  const prompt = initialPrompt(input.prompt);
  const record: NoticeRecord = {
    id,
    kind: input.kind,
    priority: input.priority,
    dedupeKey: input.dedupeKey,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ruleIds: Array.isArray(input.ruleIds) ? [...input.ruleIds] : input.ruleIds,
    facts: input.facts,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    ...(prompt !== undefined ? { prompt } : {}),
    ...(initial !== undefined
      ? {
          delivery: {
            key: hex24(id),
            ...(initial.channel !== undefined ? { channel: initial.channel } : {}),
            status: initial.status,
            attempts: 0,
            at: createdAt,
          },
        }
      : {}),
    createdAt,
  };
  let json: string | undefined;
  try {
    json = JSON.stringify(record);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw new PetNoticeLedgerError("invalid_notice");
  // The in-memory copy is exactly what a reload would see.
  const parsed = parseNoticeRecord(JSON.parse(json));
  if (!parsed) throw new PetNoticeLedgerError("invalid_notice");
  return parsed;
}

function impliedDelivery(decision: RouteDecision | undefined): NoticeRecordInput["delivery"] {
  if (decision?.queued)
    return { status: "queued", ...(decision.im ? { channel: decision.im } : {}) };
  if (decision?.outlet === "digest") return { status: "held" };
  return undefined;
}

/**
 * Durable record of every notice Mimi decided on and how its delivery went,
 * owned by the Electron main process (`<userData>/pet/notices.json`).
 *
 * Every mutation is serialised in-process, staged on a copy, validated,
 * committed atomically, and only then becomes visible; a promise resolves
 * after its write is on disk. Rows this build cannot read are carried in
 * `quarantine` (or moved to a sidecar file under byte pressure), and a file
 * from a newer schema is never overwritten.
 *
 * A write can still fail (disk, `notice_ledger_full`). The router must not
 * let that swallow a notice: a P0 still has to reach the desktop surface
 * even when its ledger record could not be written.
 */
export class PetNoticeLedger {
  private state: LedgerState = { records: new Map(), dedupe: new Map(), quarantine: [] };
  private unwritable = false;
  private loadPromise: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly now: () => number;
  private readonly localHourKey: (ms: number) => string;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly maxDedupeEntries: number;
  private lastSidecarAt = 0;

  constructor(options: PetNoticeLedgerOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.localHourKey = options.localHourKey ?? defaultLocalHourKey;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxDedupeEntries = options.maxDedupeEntries ?? DEFAULT_MAX_DEDUPE_ENTRIES;
    if (!Number.isSafeInteger(this.maxDedupeEntries) || this.maxDedupeEntries < 0)
      throw new Error("invalid maxDedupeEntries");
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1)
      throw new Error("invalid maxRecords");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
      throw new Error("invalid maxBytes");
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
        if (this.loadPromise === attempt) this.loadPromise = undefined;
        throw error;
      });
      this.loadPromise = attempt;
    }
    return this.loadPromise;
  }

  get(id: string): NoticeRecord | undefined {
    const record = this.state.records.get(id);
    return record ? structuredClone(record) : undefined;
  }

  /** The newest retained record with this dedupe key (evicted records are gone). */
  byDedupeKey(dedupeKey: string): NoticeRecord | undefined {
    let found: NoticeRecord | undefined;
    for (const record of this.state.records.values()) {
      if (record.dedupeKey !== dedupeKey) continue;
      if (!found || record.createdAt >= found.createdAt) found = record;
    }
    return found ? structuredClone(found) : undefined;
  }

  /** The first record carrying the decision prompt with this reply code. */
  byPromptCode(code: string): NoticeRecord | undefined {
    let found: NoticeRecord | undefined;
    for (const record of this.state.records.values()) {
      if (record.prompt?.code !== code) continue;
      if (!found || record.createdAt < found.createdAt) found = record;
    }
    return found ? structuredClone(found) : undefined;
  }

  /** Records that carry a decision prompt (`only` picks them by prompt), oldest first. */
  prompts(only?: (prompt: NoticeDecisionPrompt) => boolean): NoticeRecord[] {
    return [...this.state.records.values()]
      .filter((record) => record.prompt !== undefined && (!only || only(record.prompt)))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => structuredClone(record));
  }

  /** Notices about one decision request (its prompt and the prompt's copies), oldest first. */
  forRequest(sessionId: string, requestId: string): NoticeRecord[] {
    return [...this.state.records.values()]
      .filter((record) => record.sessionId === sessionId && record.requestId === requestId)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((record) => structuredClone(record));
  }

  /**
   * Give a record written before prompts were recorded (an older build) its
   * prompt, in `phase`. A record that already has one is returned unchanged.
   */
  adoptPrompt(
    id: string,
    input: NonNullable<NoticeRecordInput["prompt"]>,
    phase: Extract<NoticePromptPhase, "desktop" | "escalated">,
  ): Promise<NoticeRecord> {
    const snapshot = structuredClone(input);
    return this.mutate((staged, touched) => {
      const current = staged.records.get(id);
      if (!current) throw new PetNoticeLedgerError("notice_not_found");
      if (current.prompt) return current;
      const prompt = parsePrompt(JSON.parse(JSON.stringify({ ...initialPrompt(snapshot), phase })));
      if (!prompt) throw new PetNoticeLedgerError("invalid_notice");
      const record = { ...current, prompt };
      staged.records.set(id, record);
      touched.add(id);
      return record;
    });
  }

  /**
   * Move a decision prompt along its lifecycle (see `PROMPT_TRANSITIONS`):
   * phases only go forward and an ended prompt keeps its phase.
   */
  updatePrompt(id: string, patch: NoticeDecisionPromptPatch): Promise<NoticeRecord> {
    const changes = structuredClone(patch);
    return this.mutate((staged, touched) => {
      const current = staged.records.get(id);
      if (!current?.prompt) throw new PetNoticeLedgerError("notice_not_found");
      if (!isRecord(changes) || "code" in changes || "replies" in changes)
        throw new PetNoticeLedgerError("invalid_notice");
      const phase = changes.phase ?? current.prompt.phase;
      if (!isOneOf(PROMPT_PHASES, phase)) throw new PetNoticeLedgerError("invalid_notice");
      if (!PROMPT_TRANSITIONS[current.prompt.phase].has(phase))
        throw new PetNoticeLedgerError("invalid_transition");
      const prompt = { ...current.prompt } as Record<string, unknown>;
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined) delete prompt[key];
        else prompt[key] = value;
      }
      const next = parsePrompt(JSON.parse(JSON.stringify(prompt)));
      if (!next) throw new PetNoticeLedgerError("invalid_notice");
      const record = { ...current, prompt: next };
      staged.records.set(id, record);
      touched.add(id);
      return record;
    });
  }

  /**
   * Dedupe keys first recorded within the last 7 days, including evicted
   * records. The index stores hashes, so this is a lookup, not a listing.
   */
  seenDedupeKeys(): DedupeLookup {
    const index = this.state.dedupe;
    const cutoff = this.now() - NOTICE_DEDUPE_RETENTION_MS;
    return {
      has: (dedupeKey: string) => {
        const at = index.get(hex24(dedupeKey));
        return at !== undefined && at > cutoff;
      },
    };
  }

  /** Records waiting for an IM channel to come back, oldest first. */
  queued(): NoticeRecord[] {
    return (
      [...this.state.records.values()]
        .filter((record) => record.delivery?.status === "queued")
        // Stable sort over insertion (arrival) order; ids are random, so never a tiebreak.
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((record) => structuredClone(record))
    );
  }

  /** Records held for the next digest, oldest first. */
  held(): NoticeRecord[] {
    return (
      [...this.state.records.values()]
        .filter((record) => record.delivery?.status === "held")
        // Stable sort over insertion (arrival) order; ids are random, so never a tiebreak.
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((record) => structuredClone(record))
    );
  }

  /**
   * IM sends (claimed or accepted, any channel but "desktop") whose latest
   * claim falls in the same local clock hour as `now`; P0 separately.
   */
  countsThisHour(now: number): { sent: number; p0Sent: number } {
    const hour = this.localHourKey(now);
    let sent = 0;
    let p0Sent = 0;
    for (const record of this.state.records.values()) {
      const delivery = record.delivery;
      if (!delivery?.channel || delivery.channel === "desktop") continue;
      if (delivery.status !== "claimed" && delivery.status !== "accepted") continue;
      if (this.localHourKey(delivery.claimedAt ?? delivery.at) !== hour) continue;
      if (record.priority === "P0") p0Sent += 1;
      else sent += 1;
    }
    return { sent, p0Sent };
  }

  /**
   * Persist a new notice. A `drop` decision never touches the dedupe index,
   * and an existing index entry keeps its first time, so a key repeated
   * every day still ages out 7 days after it was first seen.
   */
  record(notice: NoticeRecordInput, options: { id?: string } = {}): Promise<NoticeRecord> {
    const snapshot = structuredClone(notice);
    const id = options.id;
    return this.mutate((staged, touched) => {
      // A caller-chosen id (from newNoticeRecordId) lets files be frozen under it first.
      if (id !== undefined && (!isNoticeRecordId(id) || staged.records.has(id)))
        throw new PetNoticeLedgerError("invalid_notice");
      const createdAt = this.timestamp();
      const record = normalizeInput(snapshot, id ?? newNoticeRecordId(), createdAt);
      staged.records.set(record.id, record);
      if (record.decision?.outlet !== "drop") {
        const hash = hex24(record.dedupeKey);
        const seen = staged.dedupe.get(hash);
        if (seen === undefined || seen <= createdAt - NOTICE_DEDUPE_RETENTION_MS)
          staged.dedupe.set(hash, createdAt);
      }
      touched.add(record.id);
      return record;
    });
  }

  /**
   * Take the send slot for one attempt: freezes the body on the first claim
   * (later bodies are ignored so a resend is identical), status `claimed`,
   * attempts + 1. Persisted before resolving, so a crash mid-send is visible
   * to {@link recoverOnStartup}.
   *
   * An `unknown` delivery can only be claimed with `manualRetry: true`, for
   * an explicit owner "send again"; automatic paths must never pass it.
   */
  claim(
    id: string,
    channel: string,
    body: string,
    options: { manualRetry?: boolean } = {},
  ): Promise<{ key: string }> {
    const manualRetry = options.manualRetry === true;
    return this.mutate((staged, touched) => {
      const current = staged.records.get(id);
      if (!current) throw new PetNoticeLedgerError("notice_not_found");
      assertTransition(current.delivery, "claimed", manualRetry);
      if (!isText(channel, 64) || typeof body !== "string" || body.length > MAX_BODY)
        throw new PetNoticeLedgerError("invalid_notice");
      const at = this.timestamp();
      const key = current.delivery?.key ?? hex24(current.id);
      staged.records.set(id, {
        ...current,
        body: current.body ?? body,
        delivery: {
          key,
          channel,
          status: "claimed",
          attempts: (current.delivery?.attempts ?? 0) + 1,
          at,
          claimedAt: at,
        },
      });
      touched.add(id);
      return { key };
    });
  }

  /** Record a delivery outcome; see the transition table at the top of this file. */
  settle(id: string, status: NoticeSettleStatus, error?: string): Promise<void> {
    return this.mutate((staged, touched) => {
      const current = staged.records.get(id);
      if (!current) throw new PetNoticeLedgerError("notice_not_found");
      // Runtime guard for untyped callers; "claimed" is only set by claim().
      if (!isOneOf(SETTLE_STATUSES, status)) throw new PetNoticeLedgerError("invalid_notice");
      assertTransition(current.delivery, status);
      const at = this.timestamp();
      const channel = current.delivery?.channel ?? current.decision?.im;
      const claimedAt = current.delivery?.claimedAt;
      const next: NoticeRecord = {
        ...current,
        delivery: {
          key: current.delivery?.key ?? hex24(current.id),
          ...(channel !== undefined ? { channel } : {}),
          status,
          attempts: current.delivery?.attempts ?? 0,
          at,
          ...(claimedAt !== undefined ? { claimedAt } : {}),
          ...(typeof error === "string" && error ? { error: error.slice(0, MAX_ERROR) } : {}),
        },
      };
      if (status === "queued" && next.expiresAt === undefined)
        next.expiresAt = at + NOTICE_QUEUED_TTL_MS;
      staged.records.set(id, next);
      touched.add(id);
      return undefined;
    });
  }

  /**
   * Revoke queued notices whose `expiresAt` has passed; returns them. Held
   * (digest) notices are left for the digest consumer.
   */
  expireQueued(now: number): Promise<NoticeRecord[]> {
    return this.mutate((staged, touched) => this.applyExpiry(staged, touched, now));
  }

  /**
   * After a restart, in one serialised step: expire queued notices, return
   * claims younger than {@link NOTICE_RESEND_WINDOW_MS} unchanged for the
   * caller to resend (same key, same body), and mark older claims `unknown`
   * (they may or may not have reached the owner).
   */
  recoverOnStartup(now: number): Promise<NoticeRecord[]> {
    return this.mutate((staged, touched) => {
      this.applyExpiry(staged, touched, now);
      const resend: NoticeRecord[] = [];
      for (const record of staged.records.values()) {
        const delivery = record.delivery;
        if (delivery?.status !== "claimed") continue;
        if (now - delivery.at < NOTICE_RESEND_WINDOW_MS) {
          resend.push(record);
          continue;
        }
        staged.records.set(record.id, {
          ...record,
          delivery: { ...delivery, status: "unknown", at: now },
        });
        touched.add(record.id);
      }
      return resend.sort((a, b) => a.delivery!.at - b.delivery!.at || a.id.localeCompare(b.id));
    });
  }

  private applyExpiry(staged: LedgerState, touched: Set<string>, now: number): NoticeRecord[] {
    const expired: NoticeRecord[] = [];
    for (const record of staged.records.values()) {
      if (record.delivery?.status !== "queued") continue;
      if (record.expiresAt === undefined || record.expiresAt > now) continue;
      const next: NoticeRecord = {
        ...record,
        delivery: { ...record.delivery, status: "revoked", at: now, error: "expired" },
      };
      staged.records.set(record.id, next);
      touched.add(record.id);
      expired.push(next);
    }
    return expired;
  }

  private timestamp(): number {
    const at = this.now();
    if (!isTimestamp(at)) throw new Error("invalid notice ledger clock");
    return at;
  }

  /** A mutation that touches no record is a read and never writes. */
  private mutate<T>(apply: (staged: LedgerState, touched: Set<string>) => T): Promise<T> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        const staged: LedgerState = {
          records: new Map(
            [...this.state.records].map(([id, record]) => [id, structuredClone(record)] as const),
          ),
          dedupe: new Map(this.state.dedupe),
          quarantine: [...this.state.quarantine],
        };
        const touched = new Set<string>();
        const result = apply(staged, touched);
        if (touched.size === 0) return structuredClone(result);
        if (this.unwritable) throw new PetNoticeLedgerError("notice_ledger_unwritable");
        for (const record of staged.records.values()) {
          if (!parseNoticeRecord(record)) throw new PetNoticeLedgerError("invalid_notice");
        }
        this.pruneDedupe(staged);
        this.enforceCount(staged, touched);
        const { file, movedQuarantine } = this.fitBytes(staged, touched);
        if (movedQuarantine.length > 0) await this.writeQuarantineSidecar(movedQuarantine);
        await writeOwnerJsonAtomic(this.path, file, this.maxBytes, COMPACT);
        this.state = staged;
        if (movedQuarantine.length > 0) await this.pruneQuarantineSidecars();
        return structuredClone(result);
      });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Drop entries past retention, then the oldest entries beyond the count
   * cap. Hashes of records still in the ledger are never dropped by the cap,
   * so a kept record can always be recognised as a duplicate.
   */
  private pruneDedupe(staged: LedgerState): void {
    const cutoff = this.now() - NOTICE_DEDUPE_RETENTION_MS;
    for (const [hash, at] of staged.dedupe) if (at <= cutoff) staged.dedupe.delete(hash);
    if (staged.dedupe.size <= this.maxDedupeEntries) return;
    const keep = recordHashes(staged);
    const oldest = [...staged.dedupe]
      .filter(([hash]) => !keep.has(hash))
      .sort((a, b) => a[1] - b[1]);
    for (const [hash] of oldest) {
      if (staged.dedupe.size <= this.maxDedupeEntries) break;
      staged.dedupe.delete(hash);
    }
  }

  /** Oldest terminal records that this mutation did not just write. */
  private evictionOrder(staged: LedgerState, touched: ReadonlySet<string>): NoticeRecord[] {
    return [...staged.records.values()]
      .filter((record) => isEvictable(record) && !touched.has(record.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /**
   * Soft count cap: evict the oldest terminal records. Live work (claimed /
   * queued / held) and the records this mutation wrote are never evicted,
   * so the ledger may sit above the cap rather than lose a notice.
   */
  private enforceCount(staged: LedgerState, touched: ReadonlySet<string>): void {
    if (staged.records.size <= this.maxRecords) return;
    for (const record of this.evictionOrder(staged, touched)) {
      if (staged.records.size <= this.maxRecords) break;
      staged.records.delete(record.id);
    }
  }

  /**
   * Hard byte cap. Shed, in order: the oldest terminal records; the oldest
   * dedupe entries whose record is gone; the oldest quarantine rows (moved
   * to a sidecar file, not dropped). Only live records plus this mutation's
   * own writes that still do not fit throw `notice_ledger_full`.
   */
  private fitBytes(
    staged: LedgerState,
    touched: ReadonlySet<string>,
  ): { file: PetNoticeFile; movedQuarantine: unknown[] } {
    const movedQuarantine: unknown[] = [];
    for (;;) {
      const file: PetNoticeFile = {
        version: SCHEMA_VERSION,
        records: [...staged.records.values()],
        dedupe: [...staged.dedupe],
        quarantine: staged.quarantine,
      };
      const size = Buffer.byteLength(serializeOwnerJson(file, COMPACT), "utf8");
      if (size <= this.maxBytes) return { file, movedQuarantine };
      // Separators make rows a little larger than these estimates; the loop re-measures.
      let excess = size - this.maxBytes;

      const records = this.evictionOrder(staged, touched);
      if (records.length > 0) {
        for (const record of records) {
          staged.records.delete(record.id);
          excess -= jsonBytes(record);
          if (excess <= 0) break;
        }
        continue;
      }

      const keep = recordHashes(staged);
      const entries = [...staged.dedupe]
        .filter(([hash]) => !keep.has(hash))
        .sort((a, b) => a[1] - b[1]);
      if (entries.length > 0) {
        for (const entry of entries) {
          staged.dedupe.delete(entry[0]);
          excess -= jsonBytes(entry) + 8;
          if (excess <= 0) break;
        }
        continue;
      }

      if (staged.quarantine.length > 0) {
        while (staged.quarantine.length > 0 && excess > 0) {
          const row = staged.quarantine.shift();
          movedQuarantine.push(row);
          excess -= jsonBytes(row ?? null);
        }
        continue;
      }

      throw new PetNoticeLedgerError("notice_ledger_full");
    }
  }

  /** Quarantine rows pushed out of the ledger, kept byte-for-byte in JSON terms. */
  private async writeQuarantineSidecar(rows: unknown[]): Promise<void> {
    // Monotonic per instance so the newest sidecar always sorts last.
    this.lastSidecarAt = Math.max(Date.now(), this.lastSidecarAt + 1);
    const sidecar = `${this.sidecarBase()}.quarantine.${this.lastSidecarAt}.${randomUUID()}.json`;
    await writeOwnerJsonAtomic(sidecar, { version: SCHEMA_VERSION, rows }, this.maxBytes, COMPACT);
    dlog("main", "pet.notices.quarantine_moved", { rows: rows.length, sidecar });
  }

  private sidecarBase(): string {
    return this.path.endsWith(".json") ? this.path.slice(0, -".json".length) : this.path;
  }

  /**
   * Keep the newest {@link NOTICE_QUARANTINE_SIDECARS_KEPT} sidecars. Runs
   * only after the ledger write succeeded and is best effort: a failure here
   * leaves extra files behind but never fails the committed mutation.
   */
  private async pruneQuarantineSidecars(): Promise<void> {
    const folder = dirname(this.path);
    const prefix = `${basename(this.sidecarBase())}.quarantine.`;
    try {
      const sidecars = (await readdir(folder))
        .flatMap((name) => {
          if (!name.startsWith(prefix)) return [];
          const match = /^(\d+)\.[0-9a-f-]{36}\.json$/u.exec(name.slice(prefix.length));
          return match ? [{ name, at: Number(match[1]) }] : [];
        })
        .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
      for (const old of sidecars.slice(0, -NOTICE_QUARANTINE_SIDECARS_KEPT)) {
        await rm(join(folder, old.name), { force: true });
      }
    } catch (error) {
      dlog("main", "pet.notices.quarantine_prune_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private reset(): void {
    this.state = { records: new Map(), dedupe: new Map(), quarantine: [] };
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
      parsed = await readBoundedJson(this.path, this.maxBytes);
    } catch (error) {
      await this.quarantineFile("pet.notices.unreadable", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (parsed === undefined) {
      this.reset();
      return;
    }
    if (!isRecord(parsed) || typeof parsed.version !== "number") {
      await this.quarantineFile("pet.notices.invalid", {});
      return;
    }
    if (Number.isSafeInteger(parsed.version) && parsed.version > SCHEMA_VERSION) {
      // Written by a newer build: leave it in place and refuse to write over it.
      this.reset();
      this.unwritable = true;
      dlog("main", "pet.notices.newer_schema", { version: parsed.version });
      return;
    }
    if (
      parsed.version !== SCHEMA_VERSION ||
      !Array.isArray(parsed.records) ||
      (parsed.dedupe !== undefined && !Array.isArray(parsed.dedupe)) ||
      (parsed.quarantine !== undefined && !Array.isArray(parsed.quarantine))
    ) {
      await this.quarantineFile("pet.notices.invalid", { version: parsed.version });
      return;
    }
    const records = new Map<string, NoticeRecord>();
    const dedupe = new Map<string, number>();
    const quarantine: unknown[] = Array.isArray(parsed.quarantine) ? [...parsed.quarantine] : [];
    // The dedupe index is derived data: malformed pairs are skipped, not kept.
    for (const entry of Array.isArray(parsed.dedupe) ? parsed.dedupe : []) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [hash, at] = entry as unknown[];
      if (typeof hash !== "string" || !HEX24.test(hash) || !isTimestamp(at)) continue;
      const seen = dedupe.get(hash);
      dedupe.set(hash, seen === undefined ? at : Math.min(seen, at));
    }
    let rejected = 0;
    for (const stored of parsed.records) {
      const record = parseStoredRecord(stored);
      if (record && !records.has(record.id)) {
        records.set(record.id, record);
        continue;
      }
      quarantine.push(stored);
      rejected += 1;
    }
    if (rejected > 0) dlog("main", "pet.notices.quarantined_rows", { rejected });
    this.state = { records, dedupe, quarantine };
    this.unwritable = false;
  }
}
