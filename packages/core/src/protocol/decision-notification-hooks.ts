/**
 * `notification` hooks for the user-facing decisions of a Session: a tool
 * approval or a question raised (`approval_requested` / `ask_user_requested`)
 * and settled (`approval_resolved` / `ask_user_resolved`). Emitted on the
 * Session's own Engine hook registry, so settings hooks and Claude-Code
 * plugin `Notification` hooks (matcher on `kind`) receive them.
 *
 * Internal host loopbacks (workspace, host, browser, credential, panel
 * actions) are never announced. Emission is fire-and-forget: a hook that
 * throws, rejects or is slow never touches the decision itself.
 */
import { logger } from "../logging/logger.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { ChatSession } from "./chat-session.js";
import type { PendingApprovalMetadata } from "./types.js";

const MAX_TEXT = 500;

/** What the hook says about a settled decision. */
export type DecisionHookOutcome =
  | "approved"
  | "denied"
  | "answered"
  | "skipped"
  | "expired"
  | "cancelled";

interface Tracked {
  session: ChatSession;
  metadata: PendingApprovalMetadata;
  question?: string;
  header?: string;
  /** Latest decision handed to an asynchronous question (announced when it retires). */
  decision?: unknown;
  /** A blocking decision retired before its resolve ran: announce on the next microtask. */
  retiredStatus?: string;
}

function clip(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : undefined;
}

/** Map a decision value (or, without one, the retirement status) onto the hook outcome. */
export function decisionOutcome(
  question: boolean,
  decision: unknown,
  status?: string,
): { outcome: DecisionHookOutcome; approved: boolean } {
  if (typeof decision === "string")
    return { outcome: question ? "answered" : "approved", approved: true };
  if (decision && typeof decision === "object" && "approved" in decision) {
    const result = decision as { approved: unknown; failure?: unknown };
    if (result.approved === true)
      return { outcome: question ? "answered" : "approved", approved: true };
    if (result.failure === "timed_out") return { outcome: "expired", approved: false };
    if (result.failure === undefined || result.failure === "denied")
      return { outcome: question ? "skipped" : "denied", approved: false };
    return { outcome: "cancelled", approved: false };
  }
  return { outcome: status === "expired" ? "expired" : "cancelled", approved: false };
}

export class DecisionNotificationHooks {
  private readonly tracked = new Map<string, Tracked>();
  private readonly described = new Map<string, { question?: string; header?: string }>();

  /** The question text of a request about to be registered (questions only). */
  describe(requestId: string, detail: { question?: string; header?: string }): void {
    this.described.set(requestId, detail);
  }

  /** A pending decision was registered for `session`. */
  requested(session: ChatSession, metadata: PendingApprovalMetadata): void {
    const detail = this.described.get(metadata.requestId);
    this.described.delete(metadata.requestId);
    if (metadata.kind === "internal") return;
    const tracked: Tracked = {
      session,
      metadata,
      ...(detail?.question !== undefined ? { question: detail.question } : {}),
      ...(detail?.header !== undefined ? { header: detail.header } : {}),
    };
    this.tracked.set(metadata.requestId, tracked);
    this.emit(tracked, "requested");
  }

  /** The decision's resolve ran with `decision`. */
  decided(requestId: string, decision: unknown): void {
    const tracked = this.tracked.get(requestId);
    if (!tracked) return;
    if (tracked.metadata.asynchronous) {
      tracked.decision = decision;
      return;
    }
    this.tracked.delete(requestId);
    this.emit(tracked, "resolved", decision);
  }

  /**
   * The pending entry left its Session (answered, cancelled, expired, owner
   * lost). An asynchronous question is announced now, with the answer it was
   * given; a blocking one normally resolves right after this call, so it is
   * announced from {@link decided}, and only falls back to the status here.
   */
  retired(metadata: PendingApprovalMetadata, status: string): void {
    const tracked = this.tracked.get(metadata.requestId);
    if (!tracked || tracked.metadata !== metadata) return;
    if (metadata.asynchronous) {
      this.tracked.delete(metadata.requestId);
      this.emit(tracked, "resolved", tracked.decision, status);
      return;
    }
    tracked.retiredStatus = status;
    queueMicrotask(() => {
      if (this.tracked.get(metadata.requestId) !== tracked) return;
      this.tracked.delete(metadata.requestId);
      this.emit(tracked, "resolved", undefined, tracked.retiredStatus);
    });
  }

  private emit(
    tracked: Tracked,
    phase: "requested" | "resolved",
    decision?: unknown,
    status?: string,
  ): void {
    const { metadata, session } = tracked;
    const question = metadata.kind === "ask_user";
    const text = question ? (clip(tracked.header) ?? clip(tracked.question)) : undefined;
    const base: Record<string, unknown> = {
      kind: `${question ? "ask_user" : "approval"}_${phase}`,
      sessionId: metadata.sessionId,
      requestId: metadata.requestId,
      ...(metadata.sourceSessionId ? { sourceSessionId: metadata.sourceSessionId } : {}),
      ...(question
        ? {
            ...(text !== undefined ? { title: text } : {}),
            ...(clip(tracked.question) !== undefined ? { question: clip(tracked.question) } : {}),
            ...(metadata.asynchronous ? { asynchronous: true } : {}),
          }
        : {
            ...(metadata.toolName ? { toolName: metadata.toolName } : {}),
            ...(metadata.riskLevel ? { riskLevel: metadata.riskLevel } : {}),
          }),
      // Claude-Code Notification hooks read `message`.
      message: text ?? metadata.title,
    };
    const payload =
      phase === "requested"
        ? base
        : {
            ...base,
            ...(() => {
              const { outcome, approved } = decisionOutcome(question, decision, status);
              return { decision: outcome, approved, ...(status ? { status } : {}) };
            })(),
          };
    let hooks: HookRegistry | undefined;
    try {
      hooks = (session.engine as { getHookRegistry?: () => HookRegistry }).getHookRegistry?.();
      if (!hooks?.hasHooks("notification")) return;
      void hooks.emit("notification", payload).catch((error: unknown) => {
        logger.warn("decision_hook.failed", { kind: payload.kind, error: String(error) });
      });
    } catch (error) {
      logger.warn("decision_hook.failed", { kind: payload.kind, error: String(error) });
    }
  }
}
