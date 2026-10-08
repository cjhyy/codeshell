import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { TokenUsage } from "../types.js";
import type { UsageLedger } from "./store.js";
import type { UsageIdentity, UsagePurpose, UsageReceipt } from "./types.js";

export interface UsageOwner {
  ledger: UsageLedger;
  sessionId: string;
  accountingSessionId: string;
  runId?: string;
  ancestors: readonly string[];
  ancestorAccountingIds: readonly string[];
  purpose: UsagePurpose;
}

const owners = new AsyncLocalStorage<UsageOwner>();
const attempts = new AsyncLocalStorage<{
  owner: UsageOwner;
  identity: UsageIdentity;
  receipts: UsageReceipt[];
  latest?: UsageReceipt;
  latestIdentity?: UsageAttemptIdentity;
}>();

type UsageAttemptIdentity = Pick<
  UsageReceipt,
  "requestId" | "runtimeId" | "sessionId" | "accountingSessionId" | "runId" | "purpose"
>;

function account<T>(owner: UsageOwner, operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    try {
      owner.ledger.noteAccountingFailure();
    } catch {
      /* Accounting cannot fail a paid call. */
    }
    return undefined;
  }
}

export function currentUsageOwner(): UsageOwner | undefined {
  return owners.getStore();
}

/** Correlate a transport-boundary observer without exposing the owner or request content. */
export function currentUsageAttempt():
  | Pick<
      UsageReceipt,
      "requestId" | "runtimeId" | "sessionId" | "accountingSessionId" | "runId" | "purpose"
    >
  | undefined {
  const receipt = attempts.getStore()?.latestIdentity ?? attempts.getStore()?.latest;
  if (!receipt) return undefined;
  const { requestId, runtimeId, sessionId, accountingSessionId, runId, purpose } = receipt;
  return Object.freeze({ requestId, runtimeId, sessionId, accountingSessionId, runId, purpose });
}

export function withUsageOwner<T>(owner: UsageOwner, operation: () => T): T {
  return owners.run(owner, operation);
}

export function withUsagePurpose<T>(purpose: UsagePurpose, operation: () => T): T {
  const owner = currentUsageOwner();
  return owner ? withUsageOwner({ ...owner, purpose }, operation) : operation();
}

/** Accounting failures are contained by the ledger and never escape into provider retries. */
export async function withUsageAttempt<T>(
  identity: UsageIdentity,
  enabled: boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const owner = currentUsageOwner();
  if (!owner || !enabled) return attempts.exit(operation);
  const call = {
    owner,
    identity,
    receipts: [] as UsageReceipt[],
    latest: undefined as UsageReceipt | undefined,
    latestIdentity: undefined as UsageAttemptIdentity | undefined,
  };
  return attempts.run(call, async () => {
    try {
      const result = await operation();
      for (const receipt of call.receipts)
        account(owner, () =>
          owner.ledger.finish(receipt, receipt.outcome === "failed" ? "failed" : "completed"),
        );
      return result;
    } catch (error) {
      for (const receipt of call.receipts)
        account(owner, () => owner.ledger.finish(receipt, "failed"));
      throw error;
    }
  });
}

export function recordOwnedUsage(identity: UsageIdentity, usage: TokenUsage | null): void {
  const attempt = attempts.getStore();
  if (attempt) {
    if (!attempt.latest) {
      attempt.latest = account(attempt.owner, () =>
        attempt.owner.ledger.begin(
          attempt.owner,
          identity,
          undefined,
          attempt.latestIdentity?.requestId,
        ),
      );
      if (attempt.latest) attempt.receipts.push(attempt.latest);
    }
    if (attempt.latest)
      account(attempt.owner, () => attempt.owner.ledger.settle(attempt.latest!, usage));
    return;
  }
  // Custom providers using recordUsage retain one receipt per reported request.
  const owner = currentUsageOwner();
  if (!owner) return;
  account(owner, () => {
    const receipt = owner.ledger.begin(owner, identity);
    owner.ledger.settle(receipt, usage);
    owner.ledger.finish(receipt, "completed");
  });
}

/** One receipt per SDK call of configured fetch; retries hidden inside that fetch are unobservable. */
export function usageTrackingFetch(underlying: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const call = attempts.getStore();
    if (!call) return underlying(input, init);
    const requestId = createHash("sha256")
      .update(JSON.stringify([call.owner.ledger.namespace, "provider", randomUUID()]))
      .digest("hex");
    call.latestIdentity = Object.freeze({
      requestId,
      runtimeId: call.owner.ledger.runtimeId,
      sessionId: call.owner.sessionId,
      accountingSessionId: call.owner.accountingSessionId,
      ...(call.owner.runId ? { runId: call.owner.runId } : {}),
      purpose: call.owner.purpose,
    });
    call.latest = undefined;
    const receipt = account(call.owner, () =>
      call.owner.ledger.begin(call.owner, call.identity, undefined, requestId),
    );
    if (!receipt) return underlying(input, init);
    call.receipts.push(receipt);
    call.latest = receipt;
    try {
      const response = await underlying(input, init);
      if (!response.ok) account(call.owner, () => call.owner.ledger.finish(receipt, "failed"));
      return response;
    } catch (error) {
      account(call.owner, () => call.owner.ledger.finish(receipt, "failed"));
      throw error;
    }
  }) as typeof globalThis.fetch;
}

/** Called only before the underlying transport; accounting failures cannot mask preflight failures. */
export function markCurrentUsageAttemptNotSent(): void {
  const call = attempts.getStore();
  if (call?.latest) account(call.owner, () => call.owner.ledger.markNotSent(call.latest!));
}
