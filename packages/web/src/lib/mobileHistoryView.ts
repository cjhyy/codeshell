import type {
  MobileHistoryDetail,
  MobileHistoryDetailResult,
  MobileHistoryItem,
  MobileHistoryView,
} from "@cjhyy/code-shell-core";
import { assertOutputCoverage } from "./outputCoverage.js";
import { compareOutputCursors } from "./outputJournalRecovery.js";

const MiB = 1024 * 1024;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const record = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max = 2048): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max;
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const bool = (value: unknown) => typeof value === "boolean";
const string = (value: unknown) => typeof value === "string";
function cursor(value: unknown): { identity: string; sequence: number; offset: number } {
  if (!text(value) || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid history cursor");
  const item = JSON.parse(atob(value.replace(/-/g, "+").replace(/_/g, "/")));
  if (
    !record(item) ||
    !/^[a-f0-9]{64}$/.test(item.identity) ||
    !/^[a-f0-9]{64}$/.test(item.hash) ||
    !integer(item.sequence) ||
    !integer(item.offset)
  )
    throw new Error("Invalid history cursor");
  return item as { identity: string; sequence: number; offset: number };
}
function item(value: unknown): value is MobileHistoryItem {
  if (!record(value) || !text(value.id, 512)) return false;
  const refs = ["textDetailRef", "reasoningDetailRef", "detailRef"];
  if (refs.some((key) => !optional(value[key], text))) return false;
  if (!optional(value.agentId, (v) => text(v, 512))) return false;
  switch (value.kind) {
    case "user":
      return (
        only(value, ["kind", "id", "text", "attachments", "clientMessageId", "textDetailRef"]) &&
        string(value.text) &&
        optional(value.clientMessageId, (v) => text(v, 512)) &&
        optional(
          value.attachments,
          (items) =>
            Array.isArray(items) &&
            items.length <= 128 &&
            items.every(
              (a) =>
                record(a) &&
                only(a, ["name", "mime", "size", "path", "absPath"]) &&
                string(a.name) &&
                integer(a.size) &&
                ["mime", "path", "absPath"].every((k) => optional(a[k], string)),
            ),
        )
      );
    case "assistant":
      return (
        only(value, [
          "kind",
          "id",
          "messageId",
          "text",
          "reasoning",
          "done",
          "agentId",
          "textDetailRef",
          "reasoningDetailRef",
        ]) &&
        string(value.text) &&
        string(value.reasoning) &&
        bool(value.done) &&
        optional(value.messageId, (v) => text(v, 512)) &&
        (value.done || (!value.textDetailRef && !value.reasoningDetailRef))
      );
    case "tool":
      return (
        only(value, [
          "kind",
          "id",
          "name",
          "args",
          "result",
          "error",
          "summary",
          "done",
          "agentId",
          "detailRef",
          "activityGroupKey",
        ]) &&
        string(value.name) &&
        optional(value.args, record) &&
        optional(value.result, string) &&
        optional(value.error, bool) &&
        optional(value.summary, string) &&
        bool(value.done) &&
        optional(value.activityGroupKey, (v) => text(v, 512)) &&
        (value.done || !value.detailRef)
      );
    case "subagent":
      return (
        only(value, ["kind", "id", "agentId", "label", "status"]) &&
        text(value.agentId, 512) &&
        string(value.label) &&
        string(value.status)
      );
    case "system":
    case "system_error":
      return only(value, ["kind", "id", "text"]) && string(value.text);
    default:
      return false;
  }
}

/** Accept a separate Host-verified display contract, never a fabricated partial journal page. */
export function validateMobileHistoryView(
  value: unknown,
  sessionId: string,
  previous?: MobileHistoryView,
): MobileHistoryView {
  if (
    !record(value) ||
    value.status !== "ok" ||
    bytes(value) > MiB ||
    !only(value, [
      "status",
      "viewId",
      "through",
      "coverageStart",
      "coverageIdentity",
      "snapshot",
      "verifiedInputIds",
      "state",
      "items",
      "totalItems",
      "start",
      "end",
      "before",
    ]) ||
    !text(value.viewId) ||
    !Array.isArray(value.items) ||
    value.items.length > 80 ||
    !value.items.every(item) ||
    new Set(value.items.map((i) => i.id)).size !== value.items.length ||
    !integer(value.totalItems, 262144) ||
    !integer(value.start, value.totalItems) ||
    !integer(value.end, value.totalItems) ||
    value.end - value.start !== value.items.length ||
    (value.start > 0 ? !text(value.before) : value.before !== undefined)
  )
    throw new Error("Invalid history view");
  const state = value.state;
  if (
    !record(state) ||
    !only(state, [
      "run",
      "goal",
      "goalId",
      "goalPaused",
      "goalRevision",
      "sessionId",
      "title",
      "liveByAgent",
      "seq",
    ]) ||
    state.sessionId !== sessionId ||
    !["idle", "running", "waiting", "completed", "error"].includes(state.run) ||
    !integer(state.seq) ||
    !["goal", "goalId", "title"].every((key) => optional(state[key], string)) ||
    !optional(state.goalPaused, bool) ||
    !optional(state.goalRevision, integer) ||
    !record(state.liveByAgent) ||
    Object.keys(state.liveByAgent).length > 128 ||
    !Object.values(state.liveByAgent).every((id) => text(id, 512))
  )
    throw new Error("Invalid history state");
  if (
    !previous &&
    Object.values(state.liveByAgent).some(
      (id) =>
        !value.items.some(
          (entry: MobileHistoryItem) => entry.kind === "assistant" && entry.id === id,
        ),
    )
  )
    throw new Error("History omitted a live display target");
  const snapshot = value.snapshot;
  if (
    !record(snapshot) ||
    !only(snapshot, [
      "epoch",
      "nextSeq",
      "outputCursor",
      "unpaired",
      "inputIds",
      "incarnation",
      "journalIdentity",
      "historicalGap",
    ]) ||
    !text(snapshot.epoch, 512) ||
    !integer(snapshot.nextSeq) ||
    snapshot.nextSeq < 1 ||
    snapshot.unpaired !== false ||
    !optional(snapshot.historicalGap, (v) => v === true) ||
    !optional(snapshot.incarnation, (v) => text(v, 512)) ||
    !optional(snapshot.journalIdentity, (v) => text(v, 512)) ||
    !optional(value.coverageIdentity, (v) => text(v, 512)) ||
    !Array.isArray(value.verifiedInputIds) ||
    value.verifiedInputIds.length > 262144 ||
    value.verifiedInputIds.some((id) => !text(id, 512)) ||
    new Set(value.verifiedInputIds).size !== value.verifiedInputIds.length
  )
    throw new Error("Invalid history coverage");
  if (snapshot.outputCursor !== undefined) cursor(snapshot.outputCursor);
  const start = cursor(value.coverageStart),
    through = cursor(value.through);
  if (
    start.sequence !== 0 ||
    start.identity !== through.identity ||
    start.offset > through.offset ||
    (snapshot.outputCursor !== undefined &&
      (![-1, 0].includes(compareOutputCursors(snapshot.outputCursor, value.through)!) ||
        (compareOutputCursors(snapshot.outputCursor, value.through) === 0 &&
          snapshot.outputCursor !== value.through)))
  )
    throw new Error("History snapshot is not covered");
  const receipts = new Set(value.verifiedInputIds);
  assertOutputCoverage(snapshot, value, (id) => receipts.has(id));
  if (
    previous
      ? value.viewId !== previous.viewId ||
        value.through !== previous.through ||
        value.coverageStart !== previous.coverageStart ||
        value.coverageIdentity !== previous.coverageIdentity ||
        JSON.stringify(snapshot) !== JSON.stringify(previous.snapshot) ||
        JSON.stringify(state) !== JSON.stringify(previous.state) ||
        JSON.stringify(value.verifiedInputIds) !== JSON.stringify(previous.verifiedInputIds) ||
        value.totalItems !== previous.totalItems ||
        value.end !== previous.start ||
        value.start >= previous.start
      : value.end !== value.totalItems
  )
    throw new Error("History view changed its frozen range");
  return value as MobileHistoryView;
}

export function mobileHistoryRefs(items: readonly MobileHistoryItem[]): string[] {
  return items.flatMap((entry) =>
    entry.kind === "tool"
      ? entry.detailRef
        ? [entry.detailRef]
        : []
      : entry.kind === "assistant"
        ? [entry.textDetailRef, entry.reasoningDetailRef].filter(
            (value): value is string => !!value,
          )
        : entry.kind === "user" && entry.textDetailRef
          ? [entry.textDetailRef]
          : [],
  );
}

export async function readMobileHistoryDetail(
  ref: string,
  read: (cursor?: string) => Promise<MobileHistoryDetailResult>,
  current: () => boolean,
): Promise<MobileHistoryDetail> {
  const parts: Uint8Array[] = [];
  const seen = new Set<string>();
  let next: string | undefined,
    offset = 0,
    total: number | undefined;
  for (let page = 0; page < 128; page++) {
    if (!current()) throw new Error("History selection changed");
    const reply = await read(next);
    if (!current()) throw new Error("History selection changed");
    if (
      !record(reply) ||
      reply.status !== "ok" ||
      !only(reply, ["status", "ref", "index", "data", "totalBytes", "complete", "next"]) ||
      bytes(reply) > 512 * 1024 ||
      reply.ref !== ref ||
      reply.index !== offset ||
      !integer(reply.totalBytes, 32 * MiB) ||
      reply.totalBytes === 0 ||
      (total !== undefined && reply.totalBytes !== total) ||
      typeof reply.data !== "string" ||
      reply.data.length > Math.ceil((256 * 1024) / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.data) ||
      typeof reply.complete !== "boolean"
    )
      throw new Error("History detail is no longer available");
    const raw = atob(reply.data);
    if (!raw.length || raw.length > 256 * 1024 || btoa(raw) !== reply.data)
      throw new Error("Invalid history detail part");
    const part = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    total = reply.totalBytes;
    offset += part.length;
    if (offset > total) throw new Error("History detail exceeds its bound");
    parts.push(part);
    if (reply.complete) {
      if (offset !== total || reply.next !== undefined)
        throw new Error("History detail is incomplete");
      const joined = new Uint8Array(total);
      let position = 0;
      for (const chunk of parts) {
        joined.set(chunk, position);
        position += chunk.length;
      }
      const detail = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
      if (
        !record(detail) ||
        !only(detail, ["text", "args", "result", "reasoning"]) ||
        !optional(detail.args, record) ||
        !["text", "result", "reasoning"].every((key) => optional(detail[key], string))
      )
        throw new Error("Invalid history detail");
      return detail as MobileHistoryDetail;
    }
    if (offset === total || !text(reply.next) || seen.has(reply.next))
      throw new Error("History detail made no progress");
    next = reply.next;
    seen.add(next);
  }
  throw new Error("History detail exceeds its page bound");
}
