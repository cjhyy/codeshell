import type { DecisionPromptRecord } from "./pet-notice-types.js";
import { noticeLine } from "./pet-notice-compose.js";
import type { PetNoticesQuery } from "@cjhyy/code-shell-pet/protocol";
import type { NoticeRecord, PetNoticeLedger } from "./pet-notice-ledger.js";
import { unpackFacts } from "./pet-notice-types.js";
const PROACTIVE_KINDS: ReadonlySet<string> = new Set([
  "brief.morning",
  "brief.evening",
  "heartbeat",
]);
export const RECENT_PROACTIVE_WINDOW_MS = 12 * 60 * 60_000;
export const RECENT_PROACTIVE_MAX = 3;
function wasDelivered(record: NoticeRecord): boolean {
  const outlet = record.decision?.outlet;
  if (outlet !== "desktop" && outlet !== "both" && outlet !== "im") return false;
  const status = record.delivery?.status;
  if (outlet !== "im") return true;
  return (
    status === "accepted" || status === "enqueued" || status === "claimed" || status === "unknown"
  );
}
export type NoticeRowQuery =
  | { kind: "history"; query: PetNoticesQuery }
  | { kind: "proactive"; since: number; channel?: string };
export function queryNoticeRows(ledger: Pick<PetNoticeLedger, "newest">, input: NoticeRowQuery) {
  if (input.kind === "history") {
    const { query } = input;
    const kinds = query.kinds ? new Set<string>(query.kinds) : undefined;
    const match = (record: Readonly<NoticeRecord>) =>
      (!kinds || kinds.has(record.kind)) &&
      (query.sessionId === undefined || record.sessionId === query.sessionId) &&
      (query.since === undefined || record.createdAt >= query.since) &&
      (query.until === undefined || record.createdAt <= query.until) &&
      record.decision?.outlet !== "drop";
    return ledger.newest(match, query.limit + 1);
  }
  const { since, channel } = input;
  return ledger.newest((record) => {
    if (!PROACTIVE_KINDS.has(record.kind) || record.createdAt < since) return false;
    if (unpackFacts(record.facts).target.kind !== "owner" || !wasDelivered(record as NoticeRecord))
      return false;
    if (channel === undefined) return true;
    const im = record.delivery?.channel ?? record.decision?.im;
    return (
      (record.decision?.outlet === "im" || record.decision?.outlet === "both") && im === channel
    );
  }, RECENT_PROACTIVE_MAX);
}

/** Resolve prompt and escalation copies during one ledger read, in persisted time order. */
export function projectDecisionPrompts(
  records: Iterable<NoticeRecord>,
  code?: string,
): DecisionPromptRecord[] {
  const retained = Array.from(records);
  const key = (record: NoticeRecord) =>
    JSON.stringify([record.sessionId, record.requestId, record.kind]);
  const oldestFirst = (left: NoticeRecord, right: NoticeRecord) => left.createdAt - right.createdAt;
  const prompts = retained
    .filter((row) => row.prompt && (code === undefined || row.prompt.code === code))
    .sort(oldestFirst);
  if (code !== undefined) prompts.splice(1); // byPromptCode returns the oldest matching record.
  const related = new Map<string, NoticeRecord[]>(prompts.map((row) => [key(row), []]));
  for (const row of retained) if (row.requestId && row.sessionId) related.get(key(row))?.push(row);
  for (const group of related.values()) group.sort(oldestFirst);
  return prompts.map((row) => {
    const { facts, target } = unpackFacts(row.facts);
    const title = noticeLine(facts.title);
    return {
      code: row.prompt!.code,
      sessionId: row.sessionId!,
      requestId: row.requestId!,
      target,
      ruleIds: row.ruleIds,
      ...(title !== undefined && { title }),
      prompt: row.prompt!,
      ...(row.decision && { decision: row.decision }),
      copies: [row, ...related.get(key(row))!.filter((copy) => copy.id !== row.id)].map((copy) => {
        const channel = copy.delivery?.channel ?? copy.decision?.im;
        return {
          ...(copy.delivery && { status: copy.delivery.status }),
          ...(channel !== undefined && { channel }),
        };
      }),
    };
  });
}
