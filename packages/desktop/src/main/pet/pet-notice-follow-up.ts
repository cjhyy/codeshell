import type { PetFollowUpWake } from "@cjhyy/code-shell-pet";
import { noticeLine } from "./pet-notice-compose.js";
import type { RouteDecision } from "./pet-notice-policy.js";
import type { NoticeSubmission } from "./pet-notice-types.js";

/**
 * A follow-up occurrence coming due, as a notice. Its schedule rule is the
 * record of WHEN to remind (and the rule scheduler the executor); the
 * reminder itself is sent by the notice router like every other push, so it
 * gets the ledger, dedupe, presence and channel selection.
 *
 * The owner chose this moment, so quiet hours do not hold it and it does not
 * use the P1/P2 hourly budget; it shares the P0 backstop instead
 * (`usesP0Budget`). Without an IM origin it goes to the owner (`auto`: the
 * desktop while they are at the computer, else the IM they last used); with
 * one it goes back to that conversation, with a desktop record.
 */

export const FOLLOW_UP_NOTICE_KIND = "followup.due";
/** An on-time wake with a tight catch-up window still gets this long to reach the owner. */
export const FOLLOW_UP_MIN_DELIVERY_MS = 10 * 60_000;
const MAX_TEXT = 3_000;

/** What the reminder needs of an occurrence: its wake plus its catch-up deadline. */
export type FollowUpNoticeSource = Pick<
  PetFollowUpWake,
  "title" | "sourceSessionId" | "completionTarget"
> & { catchUpUntil: number };

export function followUpNotice(
  item: FollowUpNoticeSource,
  text: string,
  wakeKey: string,
  now: number,
): NoticeSubmission {
  const title = noticeLine(item.title) ?? "跟进";
  const detail = text.trim().slice(0, MAX_TEXT);
  const origin = item.completionTarget;
  return {
    kind: FOLLOW_UP_NOTICE_KIND,
    priority: "P1",
    // One occurrence of one revision is one reminder, across restarts.
    dedupeKey: wakeKey,
    ...(item.sourceSessionId ? { sessionId: item.sourceSessionId } : {}),
    ruleIds: [],
    expiresAt: Math.max(item.catchUpUntil, now + FOLLOW_UP_MIN_DELIVERY_MS),
    facts: { title, ...(detail ? { summary: detail } : {}) },
    body: detail ? `「${title}」：${detail}` : `「${title}」`,
    attention: "always",
    channel: origin ? origin.channel : "auto",
    target: origin ? { kind: "route", route: origin } : { kind: "owner" },
  };
}

/**
 * The wake coordinator's `notify`: resolves once the router took the
 * reminder (routed, recorded, sent or held); throws when it could not, so the
 * wake is recorded `unknown` rather than `notified`.
 */
export function createFollowUpNotifier(deps: {
  submit(notice: NoticeSubmission): Promise<RouteDecision>;
  now?: () => number;
}): (item: FollowUpNoticeSource, text: string, wakeKey: string) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (item, text, wakeKey) => {
    const decision = await deps.submit(followUpNotice(item, text, wakeKey, now()));
    if (decision.reason === "disposed") throw new Error("提醒通道已关闭，跟进提醒未送出");
  };
}
