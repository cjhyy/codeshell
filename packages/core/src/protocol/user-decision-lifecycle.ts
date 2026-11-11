/**
 * User decisions share one lifetime across protocol clients. This collaborator
 * owns question cancellation, deadlines and resolution publication; the server
 * supplies session ownership, observer transitions and its pending registries.
 */
import { nanoid } from "nanoid";
import { UserDecisionError } from "../exceptions.js";
import type { ApprovalResult } from "../types.js";
import type { AskUserOptions } from "../tool-system/context.js";
import type { ApprovalRouteTarget } from "../tool-system/permission.js";
import type { ChatSession, PendingApprovalEntry } from "./chat-session.js";
import { DecisionNotificationHooks } from "./decision-notification-hooks.js";
import {
  ErrorCodes,
  Methods,
  USER_DECISION_TIMEOUT_MS,
  createErrorResponse,
  createResponse,
  type ApprovalKeepWaitingParams,
  type PendingApprovalMetadata,
  type RpcRequest,
  type RpcResponse,
} from "./types.js";

interface UserDecisionHost {
  pendingApprovals: Map<string, (result: ApprovalResult) => void>;
  pendingApprovalTargets: Map<string, ApprovalRouteTarget & { requestId: string }>;
  approvalTimers: Map<string, ReturnType<typeof setTimeout>>;
  approvalDeadlines: Map<string, number>;
  connectionId(): string;
  disconnected(): boolean;
  workerGeneration(): number;
  route(sessionId: string, requestId: string): ApprovalRouteTarget & { requestId: string };
  clearTimer(requestId: string): void;
  take(session: ChatSession, requestId: string, status: string): PendingApprovalEntry | undefined;
  observeCreated(metadata: PendingApprovalMetadata): PendingApprovalMetadata;
  notify(method: string, params: Record<string, unknown>): void;
}

export class UserDecisionLifecycle {
  /** `notification` hooks for every registered user-facing decision. */
  readonly hooks = new DecisionNotificationHooks();
  private readonly legacyQuestions = new Map<string, { keepWaiting(): void }>();

  constructor(private readonly host: UserDecisionHost) {}

  askSession(
    session: ChatSession,
    sessionId: string,
    question: string,
    opts: AskUserOptions | undefined,
    register: (metadata: PendingApprovalMetadata, resolve: (decision: unknown) => void) => void,
    sourceSessionId?: string,
  ): Promise<string> {
    if (opts?.signal?.aborted) return Promise.reject(opts.signal.reason);
    return new Promise((resolve, reject) => {
      const requestId = nanoid(12);
      const routeEnvelope = this.host.route(sessionId, requestId);
      const createdAt = Date.now();
      const autoResolveMs = opts?.autoResolveMs;
      const keepWaitable =
        typeof autoResolveMs === "number" && Number.isFinite(autoResolveMs) && autoResolveMs > 0;
      const expiresAt = createdAt + (keepWaitable ? autoResolveMs : USER_DECISION_TIMEOUT_MS);
      this.hooks.describe(requestId, { question, header: opts?.header });
      const cancelQuestion = () =>
        this.finishSession(
          session,
          requestId,
          {
            approved: false,
            failure: "cancelled",
            reason: "The tool that requested this answer was cancelled",
          },
          "cancelled",
        );
      register(
        {
          sessionId,
          requestId,
          routeGeneration: routeEnvelope.generation,
          workerGeneration: this.host.workerGeneration(),
          kind: "ask_user",
          title: "需要用户回答",
          createdAt,
          expiresAt,
          surfaceable: true,
          ...(keepWaitable ? { keepWaitable: true } : {}),
        },
        (decision: unknown) => {
          opts?.signal?.removeEventListener("abort", cancelQuestion);
          this.host.clearTimer(requestId);
          const result = decision as ApprovalResult;
          if (result && typeof result === "object" && "approved" in result) {
            if (
              !result.approved &&
              opts?.throwOnFailure &&
              result.failure &&
              result.failure !== "denied"
            ) {
              reject(
                new UserDecisionError(result.failure, result.reason ?? "User confirmation failed"),
              );
              return;
            }
            resolve(
              result.approved
                ? (result.answer ?? "")
                : (result.reason ??
                    // A model question declined without a reason was skipped.
                    (keepWaitable ? SKIPPED_QUESTION_REASON : "(user declined to answer)")),
            );
          } else {
            resolve(typeof decision === "string" ? decision : "");
          }
        },
      );
      this.armTimeout(
        session,
        requestId,
        expiresAt,
        keepWaitable
          ? autoResolvedQuestionReason(autoResolveMs, recommendedAnswer(opts))
          : undefined,
      );
      opts?.signal?.addEventListener("abort", cancelQuestion, { once: true });
      if (opts?.signal?.aborted) {
        cancelQuestion();
        return;
      }

      const args: Record<string, unknown> = { question };
      if (opts?.header !== undefined) args.header = opts.header;
      if (opts?.options !== undefined) args.options = opts.options;
      if (opts?.multiSelect !== undefined) args.multiSelect = opts.multiSelect;
      if (opts?.optionsOnly !== undefined) args.optionsOnly = opts.optionsOnly;
      const announce = (deadline: number | undefined, canKeepWaiting: boolean) =>
        this.host.notify(Methods.ApprovalRequest, {
          ...routeEnvelope,
          ...(deadline !== undefined ? { expiresAt: deadline } : {}),
          ...(sourceSessionId ? { sourceSessionId } : {}),
          request: {
            toolName: "__ask_user__",
            // Model questions stay skippable after the user chose to keep waiting.
            args: {
              ...args,
              ...(keepWaitable ? { skippable: true } : {}),
              ...(canKeepWaiting ? { keepWaitable: true } : {}),
            },
            description: question,
            riskLevel: "low" as const,
          },
        });

      const entry = session.pendingApprovals.get(requestId);
      if (keepWaitable && entry) {
        entry.keepWaiting = () => {
          if (session.pendingApprovals.get(requestId) !== entry) return;
          this.host.clearTimer(requestId);
          entry.metadata.expiresAt = undefined;
          entry.metadata.keepWaitable = false;
          entry.keepWaiting = undefined;
          // Same requestId: every client and replay cache replaces the dated card.
          announce(undefined, false);
        };
      }

      try {
        announce(expiresAt, keepWaitable);
      } catch (error) {
        this.finishSession(
          session,
          requestId,
          {
            approved: false,
            failure: "session_closed",
            reason: String(error),
          },
          "cancelled",
        );
      }
    });
  }

  askLegacy(question: string, opts?: AskUserOptions): Promise<string> {
    if (opts?.signal?.aborted) return Promise.reject(opts.signal.reason);
    return new Promise((resolve, reject) => {
      const requestId = nanoid(12);
      const route = {
        connectionId: this.host.connectionId(),
        sessionId: "",
        generation: 0,
        requestId,
      };
      const autoResolveMs = opts?.autoResolveMs;
      const keepWaitable =
        typeof autoResolveMs === "number" && Number.isFinite(autoResolveMs) && autoResolveMs > 0;
      const expiresAt = Date.now() + (keepWaitable ? autoResolveMs : USER_DECISION_TIMEOUT_MS);
      const timeoutReason = keepWaitable
        ? autoResolvedQuestionReason(autoResolveMs, recommendedAnswer(opts))
        : "The confirmation deadline expired without an answer. No permission was granted.";
      const finish = (decision: ApprovalResult) => {
        const pending = this.host.pendingApprovals.get(requestId);
        if (!pending) return;
        this.host.pendingApprovals.delete(requestId);
        this.host.pendingApprovalTargets.delete(requestId);
        this.host.clearTimer(requestId);
        pending(decision);
      };
      const cancelQuestion = () =>
        finish({
          approved: false,
          failure: "cancelled",
          reason: "The tool that requested this answer was cancelled",
        });
      this.host.pendingApprovals.set(requestId, (result: ApprovalResult) => {
        this.legacyQuestions.delete(requestId);
        if (!result.approved && result.failure === "timed_out")
          result = { ...result, reason: timeoutReason };
        opts?.signal?.removeEventListener("abort", cancelQuestion);
        this.host.pendingApprovalTargets.delete(requestId);
        this.host.clearTimer(requestId);
        this.notifyResolved(route, result);
        if (
          !result.approved &&
          opts?.throwOnFailure &&
          result.failure &&
          result.failure !== "denied"
        ) {
          reject(
            new UserDecisionError(result.failure, result.reason ?? "User confirmation failed"),
          );
          return;
        }
        resolve(
          result.approved
            ? (result.answer ?? "")
            : (result.reason ??
                (keepWaitable ? SKIPPED_QUESTION_REASON : "(user declined to answer)")),
        );
      });
      this.host.pendingApprovalTargets.set(requestId, route);
      this.host.approvalDeadlines.set(requestId, expiresAt);
      this.host.approvalTimers.set(
        requestId,
        setTimeout(
          () => {
            if (this.host.approvalDeadlines.get(requestId) !== expiresAt) return;
            finish({ approved: false, failure: "timed_out", reason: timeoutReason });
          },
          Math.max(0, expiresAt - Date.now()),
        ),
      );
      opts?.signal?.addEventListener("abort", cancelQuestion, { once: true });
      if (opts?.signal?.aborted) {
        cancelQuestion();
        return;
      }
      const args: Record<string, unknown> = { question };
      if (opts?.header !== undefined) args.header = opts.header;
      if (opts?.options !== undefined) args.options = opts.options;
      if (opts?.multiSelect !== undefined) args.multiSelect = opts.multiSelect;
      if (opts?.optionsOnly !== undefined) args.optionsOnly = opts.optionsOnly;
      const announce = (deadline: number | undefined) =>
        this.host.notify(Methods.ApprovalRequest, {
          ...route,
          ...(deadline !== undefined ? { expiresAt: deadline } : {}),
          request: {
            toolName: "__ask_user__",
            args: {
              ...args,
              ...(keepWaitable ? { skippable: true } : {}),
              ...(keepWaitable && deadline !== undefined ? { keepWaitable: true } : {}),
            },
            description: question,
            riskLevel: "low" as const,
          },
        });
      if (keepWaitable)
        this.legacyQuestions.set(requestId, {
          keepWaiting: () => {
            this.host.clearTimer(requestId);
            announce(undefined);
          },
        });
      try {
        announce(expiresAt);
      } catch (error) {
        finish({ approved: false, failure: "session_closed", reason: String(error) });
      }
    });
  }

  notifyResolved(
    route: Partial<ApprovalRouteTarget> & { requestId: string },
    decision: unknown,
    status?: string,
  ): void {
    // The lifecycle projection is still retired on ownership loss, but a dead
    // connection cannot receive a resolution (or own a replacement request).
    if (this.host.disconnected()) return;
    const result: {
      approved?: boolean;
      answer?: string;
      reason?: string;
      failure?: Extract<ApprovalResult, { approved: false }>["failure"];
    } =
      typeof decision === "string"
        ? { approved: true, answer: decision }
        : (decision as ApprovalResult);
    this.host.notify(Methods.ApprovalResolved, {
      ...route,
      status:
        status ??
        (result?.failure === "timed_out"
          ? "expired"
          : result?.failure === "owner_lost"
            ? "owner-lost"
            : result?.failure
              ? "cancelled"
              : "resolved"),
      approved: result?.approved === true,
      ...(result?.answer !== undefined ? { answer: result.answer } : {}),
      ...(result?.reason !== undefined ? { reason: result.reason } : {}),
      ...(result?.failure !== undefined ? { failure: result.failure } : {}),
    });
  }

  finishSession(
    session: ChatSession,
    requestId: string,
    decision: ApprovalResult,
    status: string,
  ): boolean {
    const entry = this.host.take(session, requestId, status);
    if (!entry) return false;
    this.host.pendingApprovalTargets.delete(requestId);
    this.host.clearTimer(requestId);
    entry.resolve(decision);
    if (entry.metadata.asynchronous) {
      this.notifyResolved(
        {
          connectionId: this.host.connectionId(),
          sessionId: entry.metadata.sessionId,
          generation: entry.metadata.routeGeneration,
          requestId,
        },
        decision,
        status,
      );
    }
    return true;
  }

  /**
   * The user chose to keep a question open: drop its auto-resolve deadline.
   * `owns` applies the host's answer-ownership rules to the request route.
   */
  keepWaitingRpc(
    req: RpcRequest,
    sessions: { get(sessionId: string): ChatSession | undefined } | null | undefined,
    owns: (route: Partial<ApprovalKeepWaitingParams>) => boolean,
  ): RpcResponse {
    const params = (req.params ?? {}) as Partial<ApprovalKeepWaitingParams>;
    const fail = (code: number, message: string) => createErrorResponse(req.id, code, message);
    const { sessionId, requestId } = params;
    if (typeof sessionId !== "string" || typeof requestId !== "string")
      return fail(ErrorCodes.InvalidParams, "sessionId and requestId are required");
    if (!owns(params))
      return fail(
        ErrorCodes.InvalidParams,
        "Keep-waiting request does not match connectionId, sessionId, generation, and requestId",
      );
    if (sessionId === "") {
      const question = this.legacyQuestions.get(requestId);
      if (!question || !this.host.pendingApprovals.has(requestId))
        return fail(ErrorCodes.InvalidParams, `No pending model question: ${requestId}`);
      const deadline = this.host.approvalDeadlines.get(requestId);
      if (deadline !== undefined && Date.now() >= deadline)
        return fail(ErrorCodes.InvalidParams, "This question has already closed");
      if (deadline !== undefined) question.keepWaiting();
      return createResponse(req.id, { ok: true });
    }
    const session = sessions?.get(sessionId);
    if (!session) return fail(ErrorCodes.SessionClosed, `No such session: ${sessionId}`);
    const entry = session.pendingApprovals.get(requestId);
    if (!entry) return fail(ErrorCodes.InvalidParams, `No pending question: ${requestId}`);
    const deadline = entry.metadata.expiresAt;
    if (deadline !== undefined && Date.now() >= deadline)
      return fail(ErrorCodes.InvalidParams, "This question has already closed");
    // Another client already chose to keep waiting: idempotent.
    if (deadline === undefined && !entry.keepWaiting) return createResponse(req.id, { ok: true });
    if (!entry.keepWaiting)
      return fail(ErrorCodes.InvalidParams, "This question cannot be kept open");
    entry.keepWaiting();
    return createResponse(req.id, { ok: true });
  }

  armTimeout(session: ChatSession, requestId: string, expiresAt: number, reason?: string): void {
    this.host.approvalDeadlines.set(requestId, expiresAt);
    this.host.approvalTimers.set(
      requestId,
      setTimeout(
        () => {
          // A deadline cleared or replaced since arming (keep waiting) is stale.
          if (this.host.approvalDeadlines.get(requestId) !== expiresAt) return;
          this.finishSession(
            session,
            requestId,
            {
              approved: false,
              failure: "timed_out",
              reason:
                reason ??
                "The confirmation deadline expired without an answer. No permission was granted.",
            },
            "expired",
          );
        },
        Math.max(0, expiresAt - Date.now()),
      ),
    );
  }

  register(
    session: ChatSession,
    metadata: PendingApprovalMetadata,
    resolve: (decision: unknown) => void | Promise<void>,
    scope?: { sourceSessionId: string; pending: Set<string> },
  ): void {
    if (scope) {
      metadata = { ...metadata, sourceSessionId: scope.sourceSessionId };
      scope.pending.add(metadata.requestId);
    }
    metadata = this.host.observeCreated(metadata);
    let resolved = false;
    session.pendingApprovals.set(metadata.requestId, {
      resolve: (decision) => {
        if (!metadata.asynchronous && resolved) return;
        resolved = true;
        this.hooks.decided(metadata.requestId, decision);
        scope?.pending.delete(metadata.requestId);
        if (!metadata.asynchronous) {
          this.host.pendingApprovalTargets.delete(metadata.requestId);
          this.host.clearTimer(metadata.requestId);
        }
        const outcome = resolve(decision);
        if (!metadata.asynchronous && metadata.kind !== "internal") {
          this.notifyResolved(
            {
              connectionId: this.host.connectionId(),
              sessionId: metadata.sessionId,
              generation: metadata.routeGeneration,
              requestId: metadata.requestId,
            },
            decision,
          );
        }
        return outcome;
      },
      metadata,
    });
    this.hooks.requested(session, metadata);
  }
}

/** Model-facing result when a question auto-resolves; silence is never consent. */
const CONTINUE_WITHOUT_ANSWER =
  "Continue with your best judgment and state the assumption you made. Do not ask this same question again. " +
  "Silence is not consent: do not take risky, destructive, or irreversible actions on this basis.";

/** Model-facing result when the user presses Skip on a model question. */
export const SKIPPED_QUESTION_REASON = `(The user skipped this question without answering.) ${CONTINUE_WITHOUT_ANSWER}`;

/** The recommended label(s) a timed-out question defaults to, if any. */
export function recommendedAnswer(opts: AskUserOptions | undefined): string | undefined {
  const labels = (opts?.options ?? []).filter((o) => o.recommended === true).map((o) => o.label);
  if (labels.length === 0) return undefined;
  return opts?.multiSelect ? labels.join(", ") : labels[0];
}

/** Model-facing result when a question times out: take the recommendation, else skip. */
export function autoResolvedQuestionReason(autoResolveMs: number, recommended?: string): string {
  const seconds = Math.round(autoResolveMs / 1000);
  const span = seconds % 60 === 0 ? `${seconds / 60} minute(s)` : `${seconds} seconds`;
  if (recommended !== undefined) {
    return (
      `(The user did not answer within ${span}, so your recommended option was applied by default: ${JSON.stringify(recommended)}. ` +
      "The user did not explicitly choose it; mention the default you took so it is easy to revisit.) " +
      "Do not treat this default as consent for risky, destructive, or irreversible actions."
    );
  }
  return `(The user did not answer within ${span}, so the question was skipped.) ${CONTINUE_WITHOUT_ANSWER}`;
}
