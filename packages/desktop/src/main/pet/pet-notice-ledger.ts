import { createHash, randomUUID } from "node:crypto";
import { dlog } from "../desktop-logger.js";
import {
  quarantineCorruptJson,
  readBoundedJson,
  writeOwnerJsonAtomic,
} from "./bounded-json-store.js";
import type { NoticePriority, RouteDecision } from "./pet-notice-policy.js";

export type NoticeDeliveryStatus =
  | "claimed"
  | "accepted"
  | "failed"
  | "queued"
  | "unknown"
  | "revoked";

export interface NoticeDelivery {
  /** Idempotency key for the gateway: sha256(dedupeKey), first 24 hex chars. */
  key: string;
  channel?: string;
  status: NoticeDeliveryStatus;
  /** Number of claims (send attempts). */
  attempts: number;
  /** Epoch ms of the last status change (claim or settle). */
  at: number;
  error?: string;
}

export interface NoticeRecord {
  id: string;
  kind: string;
  priority: NoticePriority;
  dedupeKey: string;
  sessionId?: string;
  requestId?: string;
  expiresAt?: number;
  ruleIds: string[];
  facts: unknown;
  /** Frozen by the first claim, so every resend carries the same text. */
  body?: string;
  decision?: RouteDecision;
  delivery?: NoticeDelivery;
  createdAt: number;
}

export type NoticeRecordInput = Omit<NoticeRecord, "id" | "createdAt">;

export interface PetNoticeLedgerOptions {
  path: string;
  now?: () => number;
  /**
   * Maps an instant to its local clock hour; two instants with the same key
   * are in the same hour for the hourly caps. Defaults to the host's local
   * time zone (DST-aware via Date's local getters).
   */
  localHourKey?: (ms: number) => string;
  /** Soft cap on records; only terminal records are evicted to honour it. */
  maxRecords?: number;
  /** Hard cap on the file size. */
  maxBytes?: number;
}

export type PetNoticeLedgerErrorCode =
  | "notice_not_found"
  | "notice_already_settled"
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
/** A key seen within this window is a duplicate, even after its record was evicted. */
export const NOTICE_DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** A claim younger than this at startup is resent; older ones are marked unknown. */
export const NOTICE_RESEND_WINDOW_MS = 10 * 60_000;
const MAX_DEDUPE_ENTRIES = 20_000;
const MAX_TEXT = 1_024;
const MAX_BODY = 32_000;
const MAX_ERROR = 2_000;
const MAX_RULE_IDS = 100;
const DELIVERY_KEY = /^[0-9a-f]{24}$/u;
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
  "unknown",
  "revoked",
];
const SETTLE_STATUSES: readonly NoticeDeliveryStatus[] = STATUSES.filter(
  (status) => status !== "claimed",
);
/** In-flight deliveries; their records are never evicted. */
const LIVE_STATUSES: ReadonlySet<NoticeDeliveryStatus> = new Set(["claimed", "queued"]);
/** Settles that only make sense after a send was attempted. */
const NEEDS_CLAIM: ReadonlySet<NoticeDeliveryStatus> = new Set(["accepted", "failed", "unknown"]);
/** A notice in these states must never be sent again. */
const FINAL_STATUSES: ReadonlySet<NoticeDeliveryStatus> = new Set(["accepted", "revoked"]);

interface PetNoticeFile {
  version: typeof SCHEMA_VERSION;
  records: NoticeRecord[];
  /** dedupeKey → createdAt of its latest record, kept after the record is evicted. */
  dedupe: Array<[string, number]>;
  /** Rows this build could not understand, carried forward unchanged. */
  quarantine: unknown[];
}

interface LedgerState {
  records: Map<string, NoticeRecord>;
  dedupe: Map<string, number>;
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
    !hasOnlyKeys(value, ["key", "channel", "status", "attempts", "at", "error"])
  )
    return undefined;
  if (
    typeof value.key !== "string" ||
    !DELIVERY_KEY.test(value.key) ||
    (value.channel !== undefined && !isText(value.channel, 64)) ||
    !isOneOf(STATUSES, value.status) ||
    !isTimestamp(value.attempts) ||
    !isTimestamp(value.at) ||
    (value.error !== undefined &&
      (typeof value.error !== "string" || value.error.length > MAX_ERROR))
  )
    return undefined;
  return value as unknown as NoticeDelivery;
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
    !isTimestamp(value.createdAt)
  )
    return undefined;
  return value as unknown as NoticeRecord;
}

function deliveryKey(dedupeKey: string): string {
  return createHash("sha256").update(dedupeKey).digest("hex").slice(0, 24);
}

function isEvictable(record: NoticeRecord): boolean {
  return !record.delivery || !LIVE_STATUSES.has(record.delivery.status);
}

function defaultLocalHourKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}T${d.getHours()}`;
}

/** Rebuild an input with only known fields, dropping `undefined` and non-JSON values. */
function normalizeInput(input: NoticeRecordInput, id: string, createdAt: number): NoticeRecord {
  const record: NoticeRecord = {
    id,
    kind: input.kind,
    priority: input.priority,
    dedupeKey: input.dedupeKey,
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ruleIds: Array.isArray(input.ruleIds) ? [...input.ruleIds] : input.ruleIds,
    facts: input.facts,
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(input.decision !== undefined ? { decision: input.decision } : {}),
    ...(input.delivery !== undefined ? { delivery: input.delivery } : {}),
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

/**
 * Durable record of every notice Mimi decided on and how its delivery went,
 * owned by the Electron main process (`<userData>/pet/notices.json`).
 *
 * Every mutation is serialised in-process, staged on a copy, validated,
 * committed atomically, and only then becomes visible; a promise resolves
 * after its write is on disk. Rows this build cannot read are carried in
 * `quarantine` unchanged, and a file from a newer schema is never overwritten.
 *
 * The dedupe index outlives eviction so an evicted notice cannot repeat
 * within {@link NOTICE_DEDUPE_RETENTION_MS}.
 */
export class PetNoticeLedger {
  private state: LedgerState = { records: new Map(), dedupe: new Map() };
  private quarantine: unknown[] = [];
  private unwritable = false;
  private loadPromise: Promise<void> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly now: () => number;
  private readonly localHourKey: (ms: number) => string;
  private readonly maxRecords: number;
  private readonly maxBytes: number;

  constructor(options: PetNoticeLedgerOptions) {
    this.path = options.path;
    this.now = options.now ?? Date.now;
    this.localHourKey = options.localHourKey ?? defaultLocalHourKey;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1)
      throw new Error("invalid maxRecords");
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1)
      throw new Error("invalid maxBytes");
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

  /** Dedupe keys recorded within the last 7 days, including evicted records. */
  seenDedupeKeys(): ReadonlySet<string> {
    const cutoff = this.now() - NOTICE_DEDUPE_RETENTION_MS;
    const keys = new Set<string>();
    for (const [key, at] of this.state.dedupe) if (at > cutoff) keys.add(key);
    return keys;
  }

  /** Records waiting for an IM channel to come back, oldest first. */
  queued(): NoticeRecord[] {
    return [...this.state.records.values()]
      .filter((record) => record.delivery?.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .map((record) => structuredClone(record));
  }

  /**
   * IM sends (claimed or accepted, any channel but "desktop") whose last
   * status change falls in the same local clock hour as `now`; P0 separately.
   */
  countsThisHour(now: number): { sent: number; p0Sent: number } {
    const hour = this.localHourKey(now);
    let sent = 0;
    let p0Sent = 0;
    for (const record of this.state.records.values()) {
      const delivery = record.delivery;
      if (!delivery?.channel || delivery.channel === "desktop") continue;
      if (delivery.status !== "claimed" && delivery.status !== "accepted") continue;
      if (this.localHourKey(delivery.at) !== hour) continue;
      if (record.priority === "P0") p0Sent += 1;
      else sent += 1;
    }
    return { sent, p0Sent };
  }

  record(notice: NoticeRecordInput): Promise<NoticeRecord> {
    const snapshot = structuredClone(notice);
    return this.mutate((staged, touched) => {
      const createdAt = this.timestamp();
      const record = normalizeInput(snapshot, `notice-${randomUUID()}`, createdAt);
      staged.records.set(record.id, record);
      staged.dedupe.set(
        record.dedupeKey,
        Math.max(createdAt, staged.dedupe.get(record.dedupeKey) ?? 0),
      );
      touched.add(record.id);
      return record;
    });
  }

  /**
   * Take the send slot for one attempt: freezes the body on the first claim
   * (later bodies are ignored so a resend is identical), status `claimed`,
   * attempts + 1. Persisted before resolving, so a crash mid-send is visible
   * to {@link recoverOnStartup}.
   */
  claim(id: string, channel: string, body: string): Promise<{ key: string }> {
    return this.mutate((staged, touched) => {
      const current = staged.records.get(id);
      if (!current) throw new PetNoticeLedgerError("notice_not_found");
      if (current.delivery && FINAL_STATUSES.has(current.delivery.status))
        throw new PetNoticeLedgerError("notice_already_settled");
      if (!isText(channel, 64) || typeof body !== "string" || body.length > MAX_BODY)
        throw new PetNoticeLedgerError("invalid_notice");
      const key = deliveryKey(current.dedupeKey);
      const next: NoticeRecord = {
        ...current,
        body: current.body ?? body,
        delivery: {
          key,
          channel,
          status: "claimed",
          attempts: (current.delivery?.attempts ?? 0) + 1,
          at: this.timestamp(),
        },
      };
      staged.records.set(id, next);
      touched.add(id);
      return { key };
    });
  }

  /**
   * Record a delivery outcome. `accepted` / `failed` / `unknown` need a prior
   * claim; `queued` / `revoked` may be set on a notice that was never sent
   * (the queued channel then comes from the decision's `im`).
   */
  settle(
    id: string,
    status: Exclude<NoticeDeliveryStatus, "claimed">,
    error?: string,
  ): Promise<void> {
    return this.mutate((staged, touched) => {
      const current = staged.records.get(id);
      if (!current) throw new PetNoticeLedgerError("notice_not_found");
      // Runtime guard for untyped callers (IPC); "claimed" is only set by claim().
      if (!isOneOf(SETTLE_STATUSES, status)) throw new PetNoticeLedgerError("invalid_notice");
      if (!current.delivery && NEEDS_CLAIM.has(status))
        throw new PetNoticeLedgerError("invalid_notice");
      const channel = current.delivery?.channel ?? current.decision?.im;
      const delivery: NoticeDelivery = {
        key: current.delivery?.key ?? deliveryKey(current.dedupeKey),
        ...(channel !== undefined ? { channel } : {}),
        status,
        attempts: current.delivery?.attempts ?? 0,
        at: this.timestamp(),
        ...(typeof error === "string" && error ? { error: error.slice(0, MAX_ERROR) } : {}),
      };
      staged.records.set(id, { ...current, delivery });
      touched.add(id);
      return undefined;
    });
  }

  /**
   * After a restart: claims younger than {@link NOTICE_RESEND_WINDOW_MS} are
   * returned unchanged for the caller to resend (same key, same body); older
   * claims may or may not have reached the owner and become `unknown`.
   */
  recoverOnStartup(now: number): Promise<NoticeRecord[]> {
    return this.load().then(() => {
      const claimed = [...this.state.records.values()].filter(
        (record) => record.delivery?.status === "claimed",
      );
      const resend = claimed
        .filter((record) => now - record.delivery!.at < NOTICE_RESEND_WINDOW_MS)
        .sort((a, b) => a.delivery!.at - b.delivery!.at || a.id.localeCompare(b.id))
        .map((record) => structuredClone(record));
      const stale = claimed.filter(
        (record) => now - record.delivery!.at >= NOTICE_RESEND_WINDOW_MS,
      );
      if (stale.length === 0) return resend;
      return this.mutate((staged, touched) => {
        for (const { id } of stale) {
          const current = staged.records.get(id);
          if (current?.delivery?.status !== "claimed") continue;
          staged.records.set(id, {
            ...current,
            delivery: { ...current.delivery, status: "unknown", at: now },
          });
          touched.add(id);
        }
        return undefined;
      }).then(() => resend);
    });
  }

  private timestamp(): number {
    const at = this.now();
    if (!isTimestamp(at)) throw new Error("invalid notice ledger clock");
    return at;
  }

  private mutate<T>(apply: (staged: LedgerState, touched: Set<string>) => T): Promise<T> {
    const run = this.queue
      .catch(() => undefined)
      .then(() => this.load())
      .then(async () => {
        if (this.unwritable) throw new PetNoticeLedgerError("notice_ledger_unwritable");
        const staged: LedgerState = {
          records: new Map(
            [...this.state.records].map(([id, record]) => [id, structuredClone(record)] as const),
          ),
          dedupe: new Map(this.state.dedupe),
        };
        const touched = new Set<string>();
        const result = apply(staged, touched);
        for (const record of staged.records.values()) {
          if (!parseNoticeRecord(record)) throw new PetNoticeLedgerError("invalid_notice");
        }
        this.pruneDedupe(staged);
        this.enforceCount(staged, touched);
        await writeOwnerJsonAtomic(this.path, this.fitBytes(staged, touched), this.maxBytes);
        this.state = staged;
        return structuredClone(result);
      });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private pruneDedupe(staged: LedgerState): void {
    const cutoff = this.now() - NOTICE_DEDUPE_RETENTION_MS;
    for (const [key, at] of staged.dedupe) if (at <= cutoff) staged.dedupe.delete(key);
    if (staged.dedupe.size <= MAX_DEDUPE_ENTRIES) return;
    const oldest = [...staged.dedupe].sort((a, b) => a[1] - b[1]);
    for (const [key] of oldest.slice(0, staged.dedupe.size - MAX_DEDUPE_ENTRIES)) {
      staged.dedupe.delete(key);
    }
  }

  /** Oldest terminal records that this mutation did not just write. */
  private evictionOrder(staged: LedgerState, touched: ReadonlySet<string>): NoticeRecord[] {
    return [...staged.records.values()]
      .filter((record) => isEvictable(record) && !touched.has(record.id))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /**
   * Soft count cap: evict the oldest terminal records. Live deliveries
   * (claimed / queued) and the records this mutation wrote are never
   * evicted, so the ledger may sit above the cap rather than lose a notice.
   */
  private enforceCount(staged: LedgerState, touched: ReadonlySet<string>): void {
    if (staged.records.size <= this.maxRecords) return;
    for (const record of this.evictionOrder(staged, touched)) {
      if (staged.records.size <= this.maxRecords) break;
      staged.records.delete(record.id);
    }
  }

  /** Hard byte cap: evict more terminal records until the file fits, else refuse. */
  private fitBytes(staged: LedgerState, touched: ReadonlySet<string>): PetNoticeFile {
    for (;;) {
      const file: PetNoticeFile = {
        version: SCHEMA_VERSION,
        records: [...staged.records.values()],
        dedupe: [...staged.dedupe],
        quarantine: this.quarantine,
      };
      // Same serialisation as writeOwnerJsonAtomic.
      const size = Buffer.byteLength(`${JSON.stringify(file, null, 2)}\n`, "utf8");
      if (size <= this.maxBytes) return file;
      const candidates = this.evictionOrder(staged, touched);
      if (candidates.length === 0) throw new PetNoticeLedgerError("notice_ledger_full");
      let excess = size - this.maxBytes;
      for (const record of candidates) {
        staged.records.delete(record.id);
        // Indented rows are a little larger than this; the loop re-measures.
        excess -= Buffer.byteLength(JSON.stringify(record), "utf8");
        if (excess <= 0) break;
      }
    }
  }

  private reset(): void {
    this.state = { records: new Map(), dedupe: new Map() };
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
      const [key, at] = entry as unknown[];
      if (!isText(key) || !isTimestamp(at)) continue;
      dedupe.set(key, Math.max(at, dedupe.get(key) ?? 0));
    }
    let rejected = 0;
    for (const stored of parsed.records) {
      const record = parseNoticeRecord(stored);
      if (record && !records.has(record.id)) {
        records.set(record.id, record);
        dedupe.set(record.dedupeKey, Math.max(record.createdAt, dedupe.get(record.dedupeKey) ?? 0));
        continue;
      }
      quarantine.push(stored);
      rejected += 1;
    }
    if (rejected > 0) dlog("main", "pet.notices.quarantined_rows", { rejected });
    this.state = { records, dedupe };
    this.quarantine = quarantine;
    this.unwritable = false;
  }
}
