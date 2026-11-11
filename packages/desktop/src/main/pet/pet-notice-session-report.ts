import { createHash } from "node:crypto";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import type { PetDeliveryResolver } from "./pet-delivery-plan.js";
import type { RouteDecision } from "./pet-notice-policy.js";
import { textLine } from "./pet-notice-task-closure.js";
import { parseNoticeMedia, type NoticeMedia, type NoticeSubmission } from "./pet-notice-types.js";

/**
 * A Session's explicit progress report (ReportToMimi), told to whoever waits
 * for that Session. Mimi's report turn still composes the update for an
 * IM-started task's origin (its validated GatewayReply draft); this module
 * only decides who gets it, through the delivery plan, and hands each
 * message to the notice router as a `session.report` (P1): quiet hours, the
 * hourly cap and the merge window apply, and held reports go to the digest.
 */

const MAX_TITLE = 200;
const MAX_SUMMARY = 2_000;

export interface SessionReportDelivery {
  sessionId: string;
  /** The report's id (32 hex): one report is one message per conversation, across retries. */
  reportId: string;
  /** The Session's own report text: untrusted data for the template. */
  message: string;
  /** The long task that owns the Session, if any. */
  task?: PetLongTask;
  /**
   * Mimi's owner-facing update for the task's IM origin: the report turn's
   * validated GatewayReply draft (`enrichPetChatReplyWithHostActions`).
   */
  composed?: { text: string; button?: NoticeMedia["button"]; attachments?: readonly unknown[] };
}

export interface PetSessionReportNoticeDeps {
  deliveries: Pick<PetDeliveryResolver, "planReport">;
  /** Hand one notice to the router; rejects when it could not be routed. */
  submit(notice: NoticeSubmission): Promise<RouteDecision>;
  sessionTitle(sessionId: string): string | undefined;
  /** Mimi's own Sessions and tailed CLI rollouts are never watched by rules. */
  isEligibleSession(sessionId: string): boolean;
}

/** Notices for one report; resolves with how many were handed to the router. */
export type SessionReportNotifier = (report: SessionReportDelivery) => Promise<number>;

function conversationDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

export function createSessionReportNotices(
  deps: PetSessionReportNoticeDeps,
): SessionReportNotifier {
  return async (report) => {
    const { sessionId, task } = report;
    const plan = await deps.deliveries.planReport({
      sessionId,
      ...(task ? { task } : {}),
      useRules: deps.isEligibleSession(sessionId),
    });
    const title =
      textLine(deps.sessionTitle(sessionId), MAX_TITLE) ?? textLine(task?.objective, MAX_TITLE);
    const summary = textLine(report.message, MAX_SUMMARY);
    const composedText = report.composed?.text.trim();
    const media = parseNoticeMedia({
      button: report.composed?.button,
      attachments: report.composed?.attachments,
    });
    for (const entry of plan.entries) {
      // Mimi wrote the update for the task's origin; everyone else gets the template.
      const mimi = entry.composeBy === "mimi-closure" && composedText ? composedText : undefined;
      await deps.submit({
        kind: "session.report",
        priority: "P1",
        dedupeKey: `report:${report.reportId}:${conversationDigest(entry.key)}`,
        sessionId,
        ruleIds: entry.ruleIds,
        ...(entry.requiresAway ? { requiresAway: true } : {}),
        attention: entry.attention,
        channel: entry.channel,
        target: entry.target,
        facts: { ...(title ? { title } : {}), ...(summary ? { summary } : {}) },
        ...(mimi ? { body: mimi } : {}),
        ...(mimi && media ? { media } : {}),
      });
    }
    return plan.entries.length;
  };
}
