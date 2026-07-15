import type { PetProjectionDelta, PetProjectionSnapshotResult } from "@cjhyy/code-shell-pet";

/**
 * Fences process-local Pet cursors with the desktop worker lifecycle.
 *
 * The stdio worker starts a fresh ChatSessionManager for every process, so its
 * protocol generation is always the default value (1). AgentBridge is the
 * durable process owner and therefore supplies the generation that can
 * distinguish reconnects.
 */
export class PetWorkerProjectionGeneration {
  private value = 0;

  beginWorker(): number {
    this.value += 1;
    return this.value;
  }

  normalizeSnapshot(snapshot: PetProjectionSnapshotResult): PetProjectionSnapshotResult {
    return {
      ...snapshot,
      workerGeneration: this.value,
      pending: snapshot.pending.map((pending) => ({
        ...pending,
        workerGeneration: this.value,
      })),
    };
  }

  normalizeDelta(delta: PetProjectionDelta): PetProjectionDelta {
    if (delta.kind === "pending-upsert") {
      return {
        ...delta,
        workerGeneration: this.value,
        pending: { ...delta.pending, workerGeneration: this.value },
      };
    }
    return { ...delta, workerGeneration: this.value };
  }
}
