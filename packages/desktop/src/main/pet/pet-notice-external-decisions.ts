import { createHash } from "node:crypto";
import type { PetLongTask } from "@cjhyy/code-shell-pet";
import {
  isExternalApprovalRequestId,
  type ExternalApprovalDecision,
  type ExternalApprovalEvent,
  type ExternalApprovalRequest,
  type ExternalPendingApproval,
} from "../external-runtime-approvals.js";
import { codexNativeApprovalPresentation } from "../external-runtime-codex-approvals.js";
import type {
  ImDecision,
  ImDecisionDeliveryResolver,
  PetImDecisionsOptions,
} from "./pet-im-decisions.js";

/**
 * Decision prompts for desktop external runtimes (Codex / Claude Code run in
 * Main). Their tool approvals and questions never reach the worker: they wait
 * in `ExternalRuntimeApprovals`, which denies each one unanswered after ten
 * minutes. This module turns those pending prompts into the same `ImDecision`s
 * the worker's requests become, so `PetImDecisions` prompts, escalates,
 * expires and answers both alike; only where a decision is read from, how it
 * is answered and how its liveness is judged differ, and that is decided by
 * the request id (`isExternalApprovalRequestId`), never by worker state.
 */

/** The approval router as Main reads and answers it (`ExternalRuntimeApprovals`). */
export interface ExternalDecisionApprovals {
  pendingAll(): ExternalPendingApproval[];
  /** Answer without a window id, as Main; false when it is no longer pending. */
  settle(requestId: string, decision: ExternalApprovalDecision): boolean;
  /** Deny it as timed out (its deadline passed), exactly as the router's own timer would. */
  expire(requestId: string): boolean;
}

/** What main hands the notice wiring: the router once it started, and its changes. */
export interface ExternalDecisionSource {
  approvals(): ExternalDecisionApprovals | null | undefined;
  /** Every prompt appearing and retiring (`ExternalRuntimeModule.subscribeApprovals`). */
  subscribe(listener: (event: ExternalApprovalEvent) => void): () => void;
}

/**
 * Where an external decision stands, in `PetImDecisions`' terms: still
 * waiting, answered (anywhere), denied at its deadline, or dropped because
 * its runtime or window went away. Undefined: not known here (Main restarted).
 */
export type ExternalDecisionStatus = "pending" | "resolved" | "expired" | "cancelled";

type ImAnswer = Parameters<PetImDecisionsOptions["approve"]>[1];

export interface PetExternalDecisions {
  /** A desktop external runtime's request (not the worker's). */
  isExternal(sessionId: string, requestId: string): boolean;
  status(sessionId: string, requestId: string): ExternalDecisionStatus | undefined;
  /** The pending external decisions that have somewhere to be prompted. */
  read(): ImDecision[];
  /** Settle the prompt in the router; throws when it is no longer pending. */
  approve(entry: ImDecision, decision: ImAnswer): Promise<void>;
  dispose(): void;
}

/** How long a retired prompt's outcome is remembered, for the prompt's own ending. */
const RESOLUTION_MEMORY_MS = 30 * 60_000;
const RESOLUTION_MEMORY_MAX = 500;

/** Codex's native approvals carry `{ method, params }`; the service adds description/args. */
const CODEX_NATIVE_TOOL = "Codex native tool";

export function createExternalDecisions(deps: {
  source?: ExternalDecisionSource;
  tasks: () => readonly PetLongTask[];
  deliveryFor: ImDecisionDeliveryResolver;
  title: (sessionId: string) => string | undefined;
  /** A prompt appeared or retired (after its outcome is recorded here). */
  onChange: (event: ExternalApprovalEvent) => void;
  now?: () => number;
}): PetExternalDecisions {
  const now = deps.now ?? Date.now;
  const resolutions = new Map<
    string,
    { sessionId: string; status: ExternalDecisionStatus; at: number }
  >();
  const remember = (event: Extract<ExternalApprovalEvent, { type: "resolved" }>): void => {
    const at = now();
    for (const [id, entry] of resolutions)
      if (at - entry.at > RESOLUTION_MEMORY_MS || resolutions.size >= RESOLUTION_MEMORY_MAX)
        resolutions.delete(id);
    resolutions.set(event.requestId, {
      sessionId: event.sessionId,
      status:
        event.cause === "timed_out"
          ? "expired"
          : event.cause === "cancelled"
            ? "cancelled"
            : "resolved",
      at,
    });
  };
  const pending = (): ExternalPendingApproval[] => {
    try {
      return deps.source?.approvals()?.pendingAll() ?? [];
    } catch {
      return [];
    }
  };
  const find = (sessionId: string, requestId: string) =>
    pending().find((entry) => entry.sessionId === sessionId && entry.requestId === requestId);
  const unsubscribe = deps.source?.subscribe((event) => {
    if (event.type === "resolved") remember(event);
    deps.onChange(event);
  });

  return {
    isExternal: (_sessionId, requestId) => isExternalApprovalRequestId(requestId),
    status(sessionId, requestId) {
      if (!isExternalApprovalRequestId(requestId)) return undefined;
      if (find(sessionId, requestId)) return "pending";
      const resolved = resolutions.get(requestId);
      return resolved?.sessionId === sessionId ? resolved.status : undefined;
    },
    read() {
      const tasks = deps.tasks();
      const result: ImDecision[] = [];
      for (const item of pending()) {
        const task = tasks.find(
          (entry) =>
            entry.sessionId === item.sessionId &&
            !["completed", "failed", "cancelled"].includes(entry.status),
        );
        const entry = deps.deliveryFor(item.sessionId, task);
        if (!entry) continue;
        const title = deps.title(item.sessionId);
        result.push({
          code: externalDecisionCode(item.sessionId, item.requestId),
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          ...(title ? { title } : {}),
          ...(task ? { task } : {}),
          delivery: {
            ruleIds: entry.ruleIds,
            attention: entry.attention,
            channel: entry.channel,
            target: entry.target,
            ...(entry.requiresAway ? { requiresAway: true } : {}),
            reply: entry.reply,
          },
          envelope: {
            sessionId: item.sessionId,
            requestId: item.requestId,
            expiresAt: item.expiresAt,
            request: externalDecisionRequest(item.request),
          },
        });
      }
      return result;
    },
    async approve(entry, decision) {
      const { sessionId, requestId } = entry.envelope;
      const approvals = deps.source?.approvals();
      // By request id alone the router would settle any Session's prompt.
      if (!approvals || !find(sessionId, requestId))
        throw new Error("the external runtime's prompt is no longer pending");
      // Mimi's deadline timer won the race: a timeout, so desktop and phone say so.
      const settled =
        decision.failure === "timed_out"
          ? approvals.expire(requestId)
          : approvals.settle(requestId, {
              approved: decision.approved,
              ...(decision.answer !== undefined ? { answer: decision.answer } : {}),
              ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
            });
      if (!settled) throw new Error("the external runtime's prompt is no longer pending");
    },
    dispose() {
      unsubscribe?.();
    },
  };
}

/** Bound to the Session and the router's request id; never equal to a worker request's code. */
export function externalDecisionCode(sessionId: string, requestId: string): string {
  return createHash("sha256")
    .update(JSON.stringify(["external", sessionId, requestId]))
    .digest("hex")
    .slice(0, 12)
    .toUpperCase();
}

/**
 * The request as a prompt reads it. A question is never skippable or kept
 * open here (the runtime denies it at its deadline). A Codex native approval
 * already carries a description and readable args (`codexNativeApprovalPresentation`).
 */
export function externalDecisionRequest(
  request: ExternalApprovalRequest,
): ImDecision["envelope"]["request"] {
  const description = typeof request.description === "string" ? request.description : undefined;
  const args = record(request.args);
  if (request.toolName === "__ask_user__") {
    const { skippable: _skippable, autoResolveMs: _autoResolveMs, ...rest } = args ?? {};
    const question =
      typeof rest.question === "string" && rest.question.trim()
        ? rest.question
        : (description ?? "需要你的回答");
    return {
      toolName: "__ask_user__",
      ...(description ? { description } : {}),
      args: { ...rest, question },
    };
  }
  // A request raised without the service's presentation (description/args).
  if (!args && request.toolName === CODEX_NATIVE_TOOL && typeof request.method === "string")
    return {
      toolName: CODEX_NATIVE_TOOL,
      ...codexNativeApprovalPresentation(request.method, request.params),
    };
  return {
    toolName: request.toolName,
    ...(description ? { description } : {}),
    args: args ?? {},
  };
}

/**
 * `PetImDecisions`' read and answer, over both the worker's decisions and the
 * external runtimes': each answer goes back to where its decision waits.
 */
export function withExternalDecisions(
  external: Pick<PetExternalDecisions, "read" | "approve" | "isExternal">,
  native: Pick<PetImDecisionsOptions, "read" | "approve" | "keepWaiting">,
): Pick<PetImDecisionsOptions, "read" | "approve" | "keepWaiting" | "isExternal"> {
  const owns = (entry: ImDecision) =>
    external.isExternal(entry.envelope.sessionId, entry.envelope.requestId);
  const keepWaiting = native.keepWaiting;
  return {
    read: () => [...native.read(), ...external.read()],
    approve: (entry, decision) =>
      owns(entry) ? external.approve(entry, decision) : native.approve(entry, decision),
    ...(keepWaiting
      ? {
          keepWaiting: (entry: ImDecision) =>
            owns(entry)
              ? Promise.reject(new Error("an external runtime's prompt cannot wait longer"))
              : keepWaiting(entry),
        }
      : {}),
    isExternal: external.isExternal,
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
