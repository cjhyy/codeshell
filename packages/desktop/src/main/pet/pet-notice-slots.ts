import {
  NOTICE_OPEN_ITEM_TTL_MS,
  ordinalLabel,
  type NoticeSlot,
} from "./pet-notice-action-codes.js";
import { isPromptEnded, type NoticeRecord } from "./pet-notice-ledger.js";
import {
  imTarget,
  targetKey,
  unpackFacts,
  type NoticeLedgerPort,
  type NoticeTarget,
} from "./pet-notice-types.js";

/**
 * Numbers for the open items of one IM conversation (①②③). Every item that
 * goes out over IM (a decision prompt, a notice with `actions`) gets the
 * lowest number not taken by another open item there, and keeps it while it
 * is open; the number is shown only while more than one item is open, so a
 * conversation with a single item reads naturally. The owner may use the
 * number; the reply model (pet-notice-reply-interpreter.ts) reads it.
 */

type SlotLedger = Pick<NoticeLedgerPort, "prompts" | "actionRecords">;

interface OpenSlot {
  /** One item: a decision (`decision:<session>\0<request>`) or a notice's actions. */
  key: string;
  slot: NoticeSlot;
  target: NoticeTarget;
}

/**
 * An item's actions can still be used: not expired, not closed (its Session
 * moved on) and, except open, not used yet. A result is openable for 2 hours.
 */
export function isOpenActions(record: NoticeRecord, now: number): boolean {
  const actions = record.actions;
  if (!actions || now >= actions.expiresAt || actions.closedAt !== undefined) return false;
  if (actions.family === "open") return now - record.createdAt < NOTICE_OPEN_ITEM_TTL_MS;
  return actions.usedAt === undefined;
}

export function decisionItemKey(sessionId: string, requestId: string): string {
  return `decision:${sessionId}\u0000${requestId}`;
}

export function actionItemKey(recordId: string): string {
  return `action:${recordId}`;
}

function openSlots(ledger: SlotLedger, now: number): OpenSlot[] {
  const slots: OpenSlot[] = [];
  for (const record of ledger.prompts((prompt) => !isPromptEnded(prompt.phase) && !!prompt.slot))
    slots.push({
      key: decisionItemKey(record.sessionId ?? "", record.requestId ?? ""),
      slot: record.prompt!.slot!,
      target: unpackFacts(record.facts).target,
    });
  for (const record of ledger.actionRecords())
    if (record.actions?.slot && isOpenActions(record, now))
      slots.push({
        key: actionItemKey(record.id),
        slot: record.actions.slot,
        target: unpackFacts(record.facts).target,
      });
  return slots;
}

/**
 * The slot an item takes in the conversation `channel` + `target` reaches,
 * and the label its text starts with ("" when it is the only open item).
 */
export function allocateSlot(
  ledger: SlotLedger,
  now: number,
  key: string,
  channel: string,
  target: NoticeTarget,
): { slot: NoticeSlot; label: string } {
  const conversation = targetKey(imTarget(target, channel));
  const here = openSlots(ledger, now).filter(
    (open) =>
      open.slot.channel === channel && targetKey(imTarget(open.target, channel)) === conversation,
  );
  const own = here.find((open) => open.key === key)?.slot;
  let ordinal = own?.ordinal ?? 1;
  if (!own) {
    const taken = new Set(here.map((open) => open.slot.ordinal));
    while (taken.has(ordinal) && ordinal < 99) ordinal += 1;
  }
  const others = here.some((open) => open.key !== key);
  return { slot: { channel, ordinal }, label: others ? `${ordinalLabel(ordinal)} ` : "" };
}
