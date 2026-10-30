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
import { Methods, USER_DECISION_TIMEOUT_MS, type PendingApprovalMetadata } from "./types.js";

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
      const expiresAt = createdAt + USER_DECISION_TIMEOUT_MS;
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
                : (result.reason ?? "(user declined to answer)"),
            );
          } else {
            resolve(typeof decision === "string" ? decision : "");
          }
        },
      );
      this.armTimeout(session, requestId, expiresAt);
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

      try {
        this.host.notify(Methods.ApprovalRequest, {
          ...routeEnvelope,
          expiresAt,
          ...(sourceSessionId ? { sourceSessionId } : {}),
          request: {
            toolName: "__ask_user__",
            args,
            description: question,
            riskLevel: "low" as const,
          },
        });
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
      const expiresAt = Date.now() + USER_DECISION_TIMEOUT_MS;
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
          result.approved ? (result.answer ?? "") : (result.reason ?? "(user declined to answer)"),
        );
      });
      this.host.pendingApprovalTargets.set(requestId, route);
      this.host.approvalDeadlines.set(requestId, expiresAt);
      this.host.approvalTimers.set(
        requestId,
        setTimeout(
          () =>
            finish({
              approved: false,
              failure: "timed_out",
              reason:
                "The confirmation deadline expired without an answer. No permission was granted.",
            }),
          USER_DECISION_TIMEOUT_MS,
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
      try {
        this.host.notify(Methods.ApprovalRequest, {
          ...route,
          expiresAt,
          request: {
            toolName: "__ask_user__",
            args,
            description: question,
            riskLevel: "low" as const,
          },
        });
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

  armTimeout(session: ChatSession, requestId: string, expiresAt: number): void {
    this.host.approvalDeadlines.set(requestId, expiresAt);
    this.host.approvalTimers.set(
      requestId,
      setTimeout(
        () => {
          this.finishSession(
            session,
            requestId,
            {
              approved: false,
              failure: "timed_out",
              reason:
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
  }
}
