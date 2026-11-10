/**
 * What the gateway outbox does with each event's delivery result (pure).
 *
 * The relay tries every served event once and reports what became of it
 * (`/v1/events/result`); it never retries in place, so one failing event can
 * no longer hold up the events behind it. Desktop then either settles the
 * delivery (and tells whoever published it) or re-appends it as a new copy
 * after a backoff. A copy keeps its `deliveryKey`, so the relay's per-target
 * progress and the platform client id it derives from that key make the
 * retry resume instead of repeat.
 *
 * Budgeted events (`maxAttempts`) are owner and Mimi notices: they give up
 * after their budget, never retry a send that may already have arrived on a
 * channel without client ids (`unknown`), and expire at `expiresAt`.
 * Unbudgeted events (session replies, automations, tunnel status) keep the
 * old at-least-once promise: retried until delivered, only no longer in place.
 */

export type OutboxDeliveryOutcome =
  | "delivered"
  | "failed"
  | "unknown"
  | "expired"
  | "revoked"
  | "unauthorized";

export const OUTBOX_DELIVERY_OUTCOMES: readonly OutboxDeliveryOutcome[] = [
  "delivered",
  "failed",
  "unknown",
  "expired",
  "revoked",
  "unauthorized",
];

/** What the relay reports for one served event. */
export interface OutboxRelayReport {
  outcome: "delivered" | "failed" | "expired" | "revoked" | "unauthorized";
  attempted?: boolean;
  idempotent?: boolean;
  error?: string;
}

/** The facts of one event copy the policy reads. */
export interface OutboxDeliveryFacts {
  /** 1-based copy number. */
  attempt?: number;
  maxAttempts?: number;
  expiresAt?: number;
}

export type OutboxDeliveryDecision =
  | { kind: "settle"; outcome: OutboxDeliveryOutcome; error?: string }
  | { kind: "retry"; dueAt: number; attempt: number };

/** A settled delivery, kept by key so a publisher can ask after a restart. */
export interface OutboxSettledDelivery {
  outcome: OutboxDeliveryOutcome;
  at: number;
  error?: string;
}

/** Final results the publishers hear about (keyed by the event's deliveryKey). */
export interface OutboxDeliveryResult {
  deliveryKey: string;
  outcome: OutboxDeliveryOutcome;
  error?: string;
}

export const MAX_OUTBOX_ATTEMPTS = 20;
/** Settled deliveries remembered for publishers (bounded, newest kept). */
export const MAX_SETTLED_DELIVERIES = 500;
export const SETTLED_DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Backoff before copy `attempt + 1`: 2 s doubling, capped (1 min budgeted, 5 min otherwise). */
export function outboxRetryDelayMs(attempt: number, budgeted: boolean): number {
  const cap = budgeted ? 60_000 : 5 * 60_000;
  return Math.min(2_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 16), cap);
}

export function decideOutboxResult(
  event: OutboxDeliveryFacts,
  report: OutboxRelayReport,
  now: number,
): OutboxDeliveryDecision {
  const error = report.error ? { error: report.error } : {};
  if (report.outcome !== "failed") return { kind: "settle", outcome: report.outcome, ...error };
  const attempt = event.attempt ?? 1;
  const budgeted = event.maxAttempts !== undefined;
  // A send that may have reached the target, on a channel that cannot drop a
  // duplicate: a budgeted notice is never resent automatically.
  const retrySafe = report.attempted !== true || report.idempotent === true;
  if (budgeted && !retrySafe) return { kind: "settle", outcome: "unknown", ...error };
  if (budgeted && attempt >= event.maxAttempts!)
    return { kind: "settle", outcome: "failed", ...error };
  const dueAt = now + outboxRetryDelayMs(attempt, budgeted);
  if (event.expiresAt !== undefined && dueAt >= event.expiresAt)
    return { kind: "settle", outcome: "expired", ...error };
  return { kind: "retry", dueAt, attempt: attempt + 1 };
}

/** The settled map after adding one entry: retention, then the count cap (oldest first out). */
export function rememberSettled(
  settled: ReadonlyMap<string, OutboxSettledDelivery>,
  deliveryKey: string,
  entry: OutboxSettledDelivery,
  now: number,
): Map<string, OutboxSettledDelivery> {
  const next = new Map(
    [...settled].filter(
      ([key, value]) => key !== deliveryKey && now - value.at < SETTLED_DELIVERY_RETENTION_MS,
    ),
  );
  next.set(deliveryKey, entry);
  while (next.size > MAX_SETTLED_DELIVERIES) next.delete(next.keys().next().value!);
  return next;
}

export function isOutboxDeliveryOutcome(value: unknown): value is OutboxDeliveryOutcome {
  return (OUTBOX_DELIVERY_OUTCOMES as readonly unknown[]).includes(value);
}

const DELIVERY_KEY_RE = /^[a-f0-9]{64}$/u;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** One `[deliveryKey, settled]` entry of the outbox file; throws when malformed. */
export function parseSettledDelivery(value: unknown): [string, OutboxSettledDelivery] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !DELIVERY_KEY_RE.test(value[0]) ||
    !isPlainRecord(value[1]) ||
    !hasOnlyKeys(value[1], ["outcome", "at", "error"]) ||
    !isOutboxDeliveryOutcome(value[1].outcome) ||
    !Number.isSafeInteger(value[1].at) ||
    (value[1].error !== undefined &&
      (typeof value[1].error !== "string" || value[1].error.length > 500))
  )
    throw new Error("Invalid Gateway settled delivery");
  const entry = value[1];
  return [
    value[0],
    {
      outcome: entry.outcome as OutboxDeliveryOutcome,
      at: entry.at as number,
      ...(typeof entry.error === "string" ? { error: entry.error } : {}),
    },
  ];
}

const REPORT_KEYS = [
  "streamId",
  "eventId",
  "deliveryKey",
  "outcome",
  "attempted",
  "idempotent",
  "error",
];
const REPORT_OUTCOMES: readonly string[] = [
  "delivered",
  "failed",
  "expired",
  "revoked",
  "unauthorized",
];

/** The relay's result report (`POST /v1/events/result`) without its event reference; undefined when malformed. */
export function parseOutboxRelayReport(value: unknown): OutboxRelayReport | undefined {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, REPORT_KEYS) ||
    !REPORT_OUTCOMES.includes(String(value.outcome)) ||
    (value.attempted !== undefined && typeof value.attempted !== "boolean") ||
    (value.idempotent !== undefined && typeof value.idempotent !== "boolean") ||
    (value.error !== undefined && typeof value.error !== "string")
  )
    return undefined;
  return {
    outcome: value.outcome as OutboxRelayReport["outcome"],
    ...(value.attempted !== undefined ? { attempted: value.attempted as boolean } : {}),
    ...(value.idempotent !== undefined ? { idempotent: value.idempotent as boolean } : {}),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 500) } : {}),
  };
}
