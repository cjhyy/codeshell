import type { CronJob, CronScheduler } from "@cjhyy/code-shell-core/internal";
import type { PetRegisteredFollowUp } from "@cjhyy/code-shell-pet";
import type { PetRegisteredFollowUpStore } from "./pet-registered-follow-up-store.js";

const PREFIX = "mimi-follow-up:";

export function petFollowUpWakeKey(id: string, revision: number): string {
  return `${PREFIX}${id}:${revision}`;
}

export function isPetFollowUpWakeJob(job: Pick<CronJob, "creationKey">): boolean {
  return job.creationKey?.startsWith(PREFIX) === true;
}

/** Canonical records own intent; cron jobs are replaceable trigger projections. */
export class PetFollowUpWakeCoordinator {
  private reconcileTail: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private started = false;
  private preparation?: Promise<void>;
  private repairTimer?: ReturnType<typeof setTimeout>;
  private repairDelay = 1_000;

  constructor(
    private readonly deps: {
      store: PetRegisteredFollowUpStore;
      scheduler(): CronScheduler;
      notify(item: PetRegisteredFollowUp, text: string, deliveryKey: string): Promise<void>;
      resume(
        item: PetRegisteredFollowUp,
      ): Promise<{ launched: boolean; text: string; taskId?: string }>;
      now?: () => number;
      onError?(error: unknown): void;
    },
  ) {}

  prepare(): Promise<void> {
    return (this.preparation ??= this.deps.store
      .load()
      .then(async () => {
        await this.deps.store.recoverClaims();
      })
      .catch((error) => {
        this.preparation = undefined;
        throw error;
      }));
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.prepare();
    this.started = true;
    this.unsubscribe = this.deps.store.subscribe(() => {
      void this.reconcile().catch((error) => this.deps.onError?.(error));
    });
    await this.reconcile();
  }

  stop(): void {
    this.started = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.repairTimer) clearTimeout(this.repairTimer);
    this.repairTimer = undefined;
  }

  /** Repairs only internal projections; claimed/unknown effects never become eligible. */
  repairSoon(): void {
    if (!this.started || this.repairTimer) return;
    this.repairTimer = setTimeout(() => {
      this.repairTimer = undefined;
      this.repairDelay = Math.min(30_000, this.repairDelay * 2);
      void this.reconcile().catch((error) => this.deps.onError?.(error));
    }, this.repairDelay);
    this.repairTimer.unref?.();
  }

  reconcile(): Promise<void> {
    const next = this.reconcileTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.started) return;
        const scheduler = this.deps.scheduler();
        const records = this.deps.store.list();
        const desired = new Map(
          records
            .filter((row) => row.status === "open" && row.wake.status === "scheduled")
            .map((row) => [petFollowUpWakeKey(row.id, row.revision), row]),
        );
        // Retiring old revisions first fences stale timer callbacks at the ledger too.
        for (const job of scheduler.list()) {
          if (!isPetFollowUpWakeJob(job)) continue;
          const row = desired.get(job.creationKey!);
          if (
            !row ||
            !job.enabled ||
            job.name !== row.title ||
            job.prompt !== "Registered follow-up wake" ||
            job.schedule !== "once" ||
            job.once !== true ||
            job.runAt !== row.wakeAt ||
            job.timezone !== row.timezone ||
            job.missedPolicy !== row.missedPolicy ||
            job.catchUpUntil !== row.catchUpUntil ||
            job.resumeSessionId !== undefined
          )
            scheduler.delete(job.id);
        }
        const now = this.deps.now?.() ?? Date.now();
        for (const [creationKey, row] of desired) {
          if (
            row.catchUpUntil < now ||
            (row.missedPolicy === "skip" && now - row.wakeAt > 90_000)
          ) {
            const claimed = await this.deps.store.claimWake(row.id, row.revision);
            if (claimed)
              await this.deps.store.completeWake(row.id, row.revision, {
                status: "failed",
                detail: "已错过约定时间或补发期限，未自动执行。请重新改期。",
              });
            continue;
          }
          scheduler.create(row.title, "once", "Registered follow-up wake", {
            once: true,
            runAt: row.wakeAt,
            timezone: row.timezone,
            missedPolicy: row.missedPolicy,
            catchUpUntil: row.catchUpUntil,
            creationKey,
          });
        }
      });
    const repaired = next
      .then(() => {
        this.repairDelay = 1_000;
      })
      .catch((error) => {
        this.repairSoon();
        throw error;
      });
    this.reconcileTail = repaired;
    return repaired;
  }

  /** The durable claim precedes all external effects; duplicate callbacks become no-ops. */
  async wake(job: Pick<CronJob, "creationKey">): Promise<void> {
    const match = /^mimi-follow-up:(registered-followup-[a-f0-9]{24}):(\d+)$/u.exec(
      job.creationKey ?? "",
    );
    if (!match) throw new Error("invalid registered follow-up wake identity");
    await this.prepare();
    const revision = Number(match[2]);
    const item = await this.deps.store.claimWake(match[1]!, revision);
    if (!item) return;
    const now = this.deps.now?.() ?? Date.now();
    if (now > item.catchUpUntil || (item.missedPolicy === "skip" && now - item.wakeAt > 90_000)) {
      await this.deps.store.completeWake(item.id, revision, {
        status: "failed",
        detail: "已错过约定时间或补发期限，未自动执行。请重新改期。",
      });
      return;
    }
    try {
      const outcome =
        item.intent === "resume"
          ? await this.deps.resume(item)
          : { launched: false, text: item.text };
      await this.deps.notify(item, outcome.text, petFollowUpWakeKey(item.id, revision));
      await this.deps.store.completeWake(item.id, revision, {
        status: outcome.launched ? "launched" : "notified",
        detail: outcome.text,
        ...(outcome.taskId ? { taskId: outcome.taskId } : {}),
      });
    } catch (error) {
      // An exception after launch/send cannot prove that the effect did not occur.
      await this.deps.store.completeWake(item.id, revision, {
        status: "unknown",
        detail: `处理结果待核实，未自动重试：${String(error).slice(0, 2_000)}`,
      });
      this.deps.onError?.(error);
    }
  }

  async missed(job: Pick<CronJob, "creationKey">): Promise<void> {
    const match = /^mimi-follow-up:(registered-followup-[a-f0-9]{24}):(\d+)$/u.exec(
      job.creationKey ?? "",
    );
    if (!match) return;
    await this.prepare();
    const item = await this.deps.store.claimWake(match[1]!, Number(match[2]));
    if (item)
      await this.deps.store.completeWake(item.id, item.revision, {
        status: "failed",
        detail: "已错过约定时间或补发期限，未自动执行。请重新改期。",
      });
  }
}
