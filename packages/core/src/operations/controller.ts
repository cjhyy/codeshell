import type { RunLedger } from "./host-transport.js";
import {
  OperationLedger,
  type OperationError,
  type OperationPlan,
  type OperationReceipt,
  type OperationReference,
  type OperationConflictScopeResolver,
} from "./ledger.js";
import { readOperationSessionOwner } from "./session-owner.js";
import type { UsageLedger } from "../cost-ledger/store.js";

/** Engine-owned binding is captured lazily, after its durable usage owner is checkpointed. */
export function createSessionOperationController(
  root: string,
  sessionId: string,
  usageLedger: UsageLedger | undefined,
  assertAuthorized?: () => void,
  remote?: RunLedger,
): OperationController {
  return new OperationController(
    new OperationLedger(
      root,
      undefined,
      usageLedger
        ? {
            sessionId,
            read: () => readOperationSessionOwner(root, sessionId, usageLedger),
          }
        : undefined,
    ),
    assertAuthorized,
    remote,
  );
}

export class OperationFailure extends Error {
  constructor(readonly category: OperationError) {
    super(`Operation ${category}`);
  }
}
export interface OperationAdapter {
  /** Trusted provider normalization; installed before the atomic resource conflict check. */
  conflictScope?: OperationConflictScopeResolver;
  /** Live authority check; called again after every asynchronous stage. */
  assertAuthorized(): void;
  /** Host callback rechecks live batch authority around asynchronous stages. */
  checkAuthorized?(): Promise<void>;
  /** Fixed predecessor from a Native-approved manifest, never model input. */
  previousVerifiedId?: string;
  preflight(): Promise<void>;
  validate(): Promise<void>;
  authorize(): Promise<boolean>;
  /** Exactly one send. The controller never retries a write. */
  execute(): Promise<OperationReference>;
  /** Independent permission-gated read, never trusting the write response as proof. */
  verify(reference: OperationReference): Promise<boolean>;
  /** Optional original private inputs; never model output or a later reconciliation read. */
  recoveryInput?(phase: "prepared" | "identity"): unknown | undefined;
}

function category(error: unknown): OperationError {
  return error instanceof OperationFailure ? error.category : "transient";
}

/** A durable control path shared by trusted adapters, independent of any UI. */
export class OperationController {
  private readonly finalized = new Set<string>();
  private readonly verificationFailures = new Map<string, number>();
  constructor(
    readonly ledger: OperationLedger,
    private readonly assertAuthorized?: () => void,
    private readonly remote?: RunLedger,
  ) {}
  sealForFinalization(sessionId: string) {
    this.finalized.add(sessionId);
    return (this.remote ?? this.ledger).sealForFinalization(sessionId);
  }

  async run(plan: OperationPlan, adapter: OperationAdapter): Promise<OperationReceipt> {
    const assertRun = () => {
      if (this.finalized.has(plan.sessionId)) throw new Error("Operation run has finalized");
      this.assertAuthorized?.();
    };
    assertRun();
    const ledger = this.remote ?? this.ledger;
    if (!this.remote && adapter.conflictScope)
      this.ledger.setConflictScopeResolver(plan.service, adapter.conflictScope);
    let receipt = await ledger.prepare(plan);
    if (receipt.state === "verified" || receipt.state === "blocked" || receipt.state === "unknown")
      return receipt;
    // Another process may still own the send. A restart cannot establish whether
    // it reached the provider, so neither caller is allowed to replay it.
    if (receipt.state === "running") return ledger.sealPending(receipt.id);
    const assertHost = async () => {
      try {
        assertRun();
      } catch (error) {
        // Custody loss after a physical send freezes only this receipt. A
        // superseded controller must not finalize the newer run's operations.
        if (receipt.state === "running" || receipt.state === "succeeded")
          receipt = await ledger.sealPending(receipt.id);
        throw error;
      }
    };
    const assertAuthorized = async () => {
      await assertHost();
      adapter.assertAuthorized();
    };
    const check = async () => {
      await assertAuthorized();
      await adapter.checkAuthorized?.();
      await assertAuthorized();
    };
    try {
      if (adapter.checkAuthorized) await check();
      else await assertAuthorized();
      if (receipt.state === "planned" && (await ledger.hasUnverifiedWrites(plan.sessionId)))
        throw new OperationFailure("stale_reference");
      await adapter.preflight();
      if (adapter.checkAuthorized) await check();
      else await assertAuthorized();
      if (receipt.state === "planned") {
        await adapter.validate();
        if (adapter.checkAuthorized) await check();
        else await assertAuthorized();
        if (!(await adapter.authorize())) throw new OperationFailure("cancelled");
        if (adapter.checkAuthorized) await check();
        else await assertAuthorized();
        const preparedRecovery = adapter.recoveryInput?.("prepared");
        if (preparedRecovery !== undefined)
          await ledger.captureRecovery(plan, receipt.id, "prepared", preparedRecovery);
        const claim = await ledger.claim(receipt.id, adapter.previousVerifiedId);
        receipt = claim.receipt;
        if (!claim.claimed)
          return receipt.state === "running" ? ledger.sealPending(receipt.id) : receipt;
        try {
          if (this.remote || adapter.checkAuthorized) await check();
          assertRun();
          adapter.assertAuthorized();
          const reference = await adapter.execute();
          await assertHost();
          // Persist the receipt even if permission was revoked during the send.
          receipt = await ledger.settle(receipt.id, receipt.attemptId, "succeeded", { reference });
          if (receipt.state !== "succeeded") return receipt;
        } catch (error) {
          // A failed local checkpoint is as uncertain as a lost HTTP response.
          // If this write also fails, the earlier durable running claim remains.
          try {
            return await ledger.settle(receipt.id, receipt.attemptId, "unknown", {
              error: category(error),
            });
          } catch {
            return { ...receipt, state: "unknown", error: category(error) };
          }
        }
      }
      if (adapter.checkAuthorized) await check();
      else await assertAuthorized();
      if (!receipt.reference) throw new OperationFailure("validation");
      if ((this.verificationFailures.get(receipt.id) ?? 0) >= 2)
        return await ledger.settle(receipt.id, receipt.attemptId, "succeeded", {
          error: "postcondition_failed",
        });
      const verified = await adapter.verify(structuredClone(receipt.reference));
      if (adapter.checkAuthorized) await check();
      else await assertAuthorized();
      const identityRecovery = adapter.recoveryInput?.("identity");
      if (identityRecovery !== undefined)
        await ledger.captureRecovery(plan, receipt.id, "identity", identityRecovery);
      if (!verified)
        this.verificationFailures.set(
          receipt.id,
          (this.verificationFailures.get(receipt.id) ?? 0) + 1,
        );
      return await ledger.settle(
        receipt.id,
        receipt.attemptId,
        verified ? "verified" : "succeeded",
        {
          ...(verified ? {} : { error: "postcondition_failed" }),
        },
      );
    } catch (error) {
      if (receipt.state === "planned")
        return await ledger.settle(receipt.id, undefined, "blocked", { error: category(error) });
      if (receipt.state === "succeeded") {
        this.verificationFailures.set(
          receipt.id,
          (this.verificationFailures.get(receipt.id) ?? 0) + 1,
        );
        return await ledger.settle(receipt.id, receipt.attemptId, "succeeded", {
          error: category(error),
        });
      }
      throw error;
    }
  }
}
