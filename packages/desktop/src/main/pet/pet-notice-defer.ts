import type { NoticeDeferResult } from "./pet-notice-actions.js";
import {
  MAX_DEFERS,
  type NoticeActionsPatch,
  type NoticeRecord,
  type PetNoticeLedger,
} from "./pet-notice-ledger.js";
import { isStandaloneKind } from "./pet-notice-policy.js";
import { errorText, unpackFacts } from "./pet-notice-types.js";

/**
 * "现在别说，明早再说" (design §8.8). The owner's words are read by the reply
 * model, which proposes when (`until`); the host only clamps it and keeps a
 * held copy of the notice that the digest sends again, once, at that time.
 * At most {@link MAX_DEFERS} times per notice, at most 36 hours ahead.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const DEFER_MAX_MS = 36 * 60 * MINUTE;
export const DEFER_MIN_MS = 5 * MINUTE;
/** No time named: the next morning, at this local time. */
const DEFAULT_DEFER_MINUTE = 9 * 60;

/**
 * Mimi's own messages the owner may put off: briefs and the heartbeat. Not
 * digests: an item open after every digest would send each of the owner's
 * IM messages for the next two hours through the reply model first.
 */
export function isDeferrableKind(kind: string): boolean {
  return isStandaloneKind(kind);
}

function localMinute(ms: number, offsetMin: number): number {
  return (((Math.floor(ms / MINUTE) + offsetMin) % (24 * 60)) + 24 * 60) % (24 * 60);
}

/** When a put-off notice comes back: the model's time within [5 min, 36 h], or the next 09:00. */
export function clampDeferUntil(
  until: number | undefined,
  now: number,
  offsetMin: (ms: number) => number,
): number {
  let at = until;
  if (at === undefined || !Number.isFinite(at)) {
    const minute = localMinute(now, offsetMin(now));
    const ahead = (DEFAULT_DEFER_MINUTE - minute + 24 * 60) % (24 * 60) || 24 * 60;
    at = Math.floor(now / MINUTE) * MINUTE + ahead * MINUTE;
  }
  return Math.min(now + DEFER_MAX_MS, Math.max(now + DEFER_MIN_MS, at));
}

/** An instant as the owner reads it: "今天 18:30", "明天 09:00", "11月14日 09:00". */
export function describeLocalTime(
  ms: number,
  now: number,
  offsetMin: (ms: number) => number,
): string {
  const offset = offsetMin(ms);
  const day = (at: number, zone: number) => Math.floor((at + zone * MINUTE) / DAY);
  const minute = localMinute(ms, offset);
  const clock = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const ahead = day(ms, offset) - day(now, offsetMin(now));
  if (ahead === 0) return `今天 ${clock} `;
  if (ahead === 1) return `明天 ${clock} `;
  if (ahead === 2) return `后天 ${clock} `;
  const date = new Date(ms + offset * MINUTE);
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${clock} `;
}

export interface NoticeDeferDeps {
  ledger: Pick<PetNoticeLedger, "byActionCode" | "record">;
  useAction(code: string, patch: NoticeActionsPatch): Promise<unknown>;
  now: () => number;
  offset: (ms: number) => number;
  /** Re-arm the digest, which sends the held copy at its time. */
  schedule(): void;
  log: (event: string, data: Record<string, unknown>) => void;
}

/** Put the notice whose open item has `code` off until (about) `until`. */
export async function deferNotice(
  deps: NoticeDeferDeps,
  code: string,
  until: number | undefined,
): Promise<NoticeDeferResult> {
  const record: NoticeRecord | undefined = deps.ledger.byActionCode(code);
  if (!record || record.actions?.family !== "notice") return { ok: false, reason: "gone" };
  const count = (record.deferCount ?? 0) + 1;
  if (count > MAX_DEFERS) return { ok: false, reason: "limit" };
  const now = deps.now();
  const at = clampDeferUntil(until, now, deps.offset);
  const { facts } = unpackFacts(record.facts);
  // The text as it was, without an open item's ①② label.
  const body = (typeof facts.nonDirectBody === "string" && facts.nonDirectBody) || record.body;
  try {
    await deps.ledger.record({
      kind: record.kind,
      priority: record.priority,
      dedupeKey: `defer:${record.id}`,
      ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
      ruleIds: record.ruleIds,
      facts: record.facts,
      ...(body ? { body } : {}),
      decision: { outlet: "digest", reason: "deferred" },
      deferredUntil: at,
      deferCount: count,
    });
  } catch (error) {
    deps.log("pet.notice.defer_failed", { kind: record.kind, error: errorText(error) });
    return { ok: false, reason: "failed" };
  }
  await deps.useAction(code, { usedAt: now });
  deps.schedule();
  return { ok: true, until: at };
}
