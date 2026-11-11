import {
  actionHints,
  NOTICE_ACTION_TTL_MS,
  NOTICE_OPEN_ITEM_TTL_MS,
  noticeActionCode,
  type NoticeActions,
  type NoticeSlot,
} from "./pet-notice-action-codes.js";
import { MAX_NOTICE_BODY } from "./pet-notice-compose.js";
import {
  newNoticeRecordId,
  type NoticeActionsPatch,
  type NoticeRecord,
} from "./pet-notice-ledger.js";
import type { RouteDecision } from "./pet-notice-policy.js";
import { actionItemKey, allocateSlot, decisionItemKey, isOpenActions } from "./pet-notice-slots.js";
import {
  errorText,
  targetKey,
  unpackFacts,
  type NoticeActionRecord,
  type NoticeLedgerPort,
  type NoticeSubmission,
} from "./pet-notice-types.js";

export interface NoticeItemsDeps {
  ledger?: NoticeLedgerPort;
  now: () => number;
  log: (event: string, data: Record<string, unknown>) => void;
  /** Withdraw a record's copies still waiting for a channel or the digest (the router's). */
  revoke: (matches: (record: NoticeRecord) => boolean, reason: string) => Promise<void>;
}

/**
 * The router's open-item bookkeeping (pet-notice-action-codes.ts): arming a
 * notice with its item, numbering items per IM conversation, closing items a
 * newer notice or run makes moot, and the item lookups the reply path uses.
 */
export class NoticeItems {
  constructor(private readonly deps: NoticeItemsDeps) {}

  /**
   * A notice that is an open item gets its internal code now, bound to the
   * record id it will be written under, and its IM text ends with a plain
   * line saying what the owner can answer; the desktop and a chat that is
   * not private get the text without it. Without a ledger, no item.
   */
  arm(
    notice: NoticeSubmission,
    body: string,
    id: string | undefined,
  ): { notice: NoticeSubmission; body: string; id?: string; actions?: NoticeActions } {
    const input = notice.actions;
    if (!input || !this.deps.ledger) return { notice, body, ...(id ? { id } : {}) };
    const recordId = id ?? newNoticeRecordId();
    const actions = {
      ...input,
      code: noticeActionCode(["action", recordId, input.family]),
      // "Not now" is said right after it arrives: Mimi's own message is an item briefly,
      // so the owner's later messages are not read against it for a whole day.
      expiresAt:
        this.deps.now() +
        (input.family === "notice" ? NOTICE_OPEN_ITEM_TTL_MS : NOTICE_ACTION_TTL_MS),
    } as NoticeActions;
    const hints = actionHints(actions);
    const room = MAX_NOTICE_BODY - hints.length - 1;
    const text = body.length > room ? `${body.slice(0, room - 1)}…` : body;
    const nonDirect = notice.facts.nonDirectBody;
    return {
      notice: {
        ...notice,
        // Also the text without the item's ①② label (a resend or a defer uses it).
        facts: {
          ...notice.facts,
          nonDirectBody: typeof nonDirect === "string" && nonDirect ? nonDirect : body,
        },
      },
      body: hints ? `${text}\n${hints}` : body,
      id: recordId,
      actions,
    };
  }

  /** An open item going out over IM takes its number in that conversation (and maybe a label). */
  slot(
    notice: NoticeSubmission,
    decision: RouteDecision,
    id: string | undefined,
    actions: NoticeActions | undefined,
  ): { slot: NoticeSlot; label: string } | undefined {
    const ledger = this.deps.ledger;
    const channel =
      decision.im && (decision.outlet === "im" || decision.outlet === "both" || decision.queued)
        ? decision.im
        : undefined;
    const key =
      notice.kind === "session.blocked" && notice.sessionId && notice.requestId
        ? decisionItemKey(notice.sessionId, notice.requestId)
        : actions && id
          ? actionItemKey(id)
          : undefined;
    if (!ledger || !channel || !key) return undefined;
    return allocateSlot(ledger, this.deps.now(), key, channel, notice.target);
  }

  /**
   * After a notice is recorded: a later copy of a prompt (the owner left)
   * puts the prompt in that conversation, and a newer notice about a
   * Session closes its older items (the Session moved on).
   */
  async recorded(
    notice: NoticeSubmission,
    recordId: string,
    slot: NoticeSlot | undefined,
  ): Promise<void> {
    if (slot && !notice.prompt && notice.sessionId && notice.requestId)
      await this.slotPrompt(notice.sessionId, notice.requestId, slot);
    if (notice.sessionId && notice.kind.startsWith("session."))
      await this.close(notice.sessionId, "superseded", (record) => record.id !== recordId);
    // Mimi's newer message there replaces the older one as the thing "not now" is about.
    if (notice.actions?.family === "notice") await this.closeOlderNotices(notice, recordId);
  }

  private async closeOlderNotices(notice: NoticeSubmission, recordId: string): Promise<void> {
    const ledger = this.deps.ledger;
    if (!ledger) return;
    const now = this.deps.now();
    const here = targetKey(notice.target);
    for (const record of ledger.actionRecords()) {
      if (record.id === recordId || record.actions?.family !== "notice") continue;
      if (!isOpenActions(record, now) || targetKey(unpackFacts(record.facts).target) !== here)
        continue;
      try {
        await ledger.updateActions(record.id, { closedAt: now });
      } catch (error) {
        this.deps.log("pet.notice.action_update_failed", { error: errorText(error) });
      }
    }
  }

  /** The Session started another run: its goal / limit / failure items are moot. */
  sessionRunStarted(sessionId: string): Promise<void> {
    return this.close(sessionId, "session-ran", (record) => record.actions?.family !== "open");
  }

  /** The notice whose open item has this internal code; undefined before the ledger loads. */
  actionRecord(code: string): NoticeActionRecord | undefined {
    const record = this.deps.ledger?.byActionCode(code);
    if (!record?.actions) return undefined;
    const { facts, target } = unpackFacts(record.facts);
    return {
      recordId: record.id,
      kind: record.kind,
      createdAt: record.createdAt,
      target,
      facts,
      actions: record.actions,
    };
  }

  /** Open items that reached an IM conversation on `channel` (enqueued or delivered), oldest first. */
  openActionItems(channel: string): NoticeActionRecord[] {
    const ledger = this.deps.ledger;
    if (!ledger) return [];
    const now = this.deps.now();
    return ledger
      .actionRecords()
      .filter(
        (record) =>
          record.actions?.slot?.channel === channel &&
          isOpenActions(record, now) &&
          (record.delivery?.status === "accepted" || record.delivery?.status === "enqueued"),
      )
      .flatMap((record) => {
        const view = this.actionRecord(record.actions!.code);
        return view ? [view] : [];
      });
  }

  /**
   * Persist an item's use (or a pending link). Once it is used, the notice
   * is moot: a copy still waiting for a channel or the digest is withdrawn.
   */
  async useAction(
    code: string,
    patch: NoticeActionsPatch,
  ): Promise<NoticeActionRecord | undefined> {
    const ledger = this.deps.ledger;
    const record = ledger?.byActionCode(code);
    if (!ledger || !record) return undefined;
    try {
      await ledger.updateActions(record.id, patch);
    } catch (error) {
      this.deps.log("pet.notice.action_update_failed", { error: errorText(error) });
      return undefined;
    }
    if (patch.usedAt !== undefined)
      await this.deps.revoke((other) => other.id === record.id, "action-used");
    return this.actionRecord(code);
  }

  private async close(
    sessionId: string,
    reason: string,
    which: (record: NoticeRecord) => boolean,
  ): Promise<void> {
    const ledger = this.deps.ledger;
    if (!ledger) return;
    const now = this.deps.now();
    for (const record of ledger.actionRecords()) {
      if (record.sessionId !== sessionId || !isOpenActions(record, now) || !which(record)) continue;
      try {
        await ledger.updateActions(record.id, { closedAt: now });
      } catch (error) {
        this.deps.log("pet.notice.action_update_failed", { error: errorText(error) });
        continue;
      }
      await this.deps.revoke((other) => other.id === record.id, reason);
    }
  }

  private async slotPrompt(sessionId: string, requestId: string, slot: NoticeSlot): Promise<void> {
    const ledger = this.deps.ledger!;
    const prompted = ledger.forRequest(sessionId, requestId).find((record) => record.prompt);
    const current = prompted?.prompt?.slot;
    if (!prompted || (current?.channel === slot.channel && current.ordinal === slot.ordinal))
      return;
    try {
      await ledger.updatePrompt(prompted.id, { slot });
    } catch (error) {
      this.deps.log("pet.notice.prompt_slot_failed", { error: errorText(error) });
    }
  }
}
