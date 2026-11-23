import { randomUUID } from "node:crypto";
import {
  mutateJsonFile,
  type CronJob,
  type CronJobLifecycleEvent,
  type CronStore,
} from "@cjhyy/code-shell-core/internal";

export type CronNotice = Omit<CronJobLifecycleEvent, "job"> & {
  job: Pick<
    CronJob,
    "id" | "name" | "createdAt" | "runCount" | "creationKey" | "nextRun" | "timezone"
  >;
};

interface Receipt {
  id: string;
  state: "running" | "pending";
  startedAt: number;
  once: boolean;
  interrupted?: boolean;
  notice: CronNotice;
}

const LIMIT = 8192;
function noticeFor(event: CronJobLifecycleEvent): CronNotice {
  const { id, name, createdAt, runCount, creationKey, nextRun, timezone } = event.job;
  return {
    ...event,
    ...(event.error && { error: event.error.slice(0, 2000) }),
    ...(event.reason && { reason: event.reason.slice(0, 2000) }),
    job: { id, name, createdAt, runCount, creationKey, nextRun, timezone },
  };
}
function validReceipt(row: Receipt): boolean {
  return (
    !!row &&
    typeof row.id === "string" &&
    Number.isSafeInteger(row.startedAt) &&
    typeof row.once === "boolean" &&
    (row.state === "running" || row.state === "pending") &&
    !!row.notice &&
    typeof row.notice.job?.id === "string" &&
    typeof row.notice.job.name === "string" &&
    Number.isSafeInteger(row.notice.job.createdAt) &&
    Number.isSafeInteger(row.notice.job.runCount) &&
    ["job_start", "job_stopped", "job_error", "job_end", "job_cancelled", "job_missed"].includes(
      row.notice.type,
    )
  );
}

/** Owned by Desktop's storage thread. Reserve durably before sending an
 * execution to either Engine. Only acknowledgement of the terminal notice
 * retires the receipt. Lost acknowledgements replay its stable delivery key. */
export class CronExecutionReceipts {
  constructor(
    private readonly path: string,
    private readonly store: CronStore,
  ) {}

  private change<R>(fn: (rows: Receipt[]) => { value?: Receipt[]; result: R }): R {
    return mutateJsonFile<Receipt[], R>(this.path, {
      maxBytes: 16 * 1024 * 1024,
      mode: 0o600,
      parse(raw) {
        if (raw === undefined) return [];
        const data = JSON.parse(raw);
        if (
          data?.version !== 1 ||
          !Array.isArray(data.receipts) ||
          data.receipts.length > LIMIT ||
          !data.receipts.every(validReceipt)
        )
          throw Error("Invalid automation execution receipts");
        return data.receipts;
      },
      serialize: (receipts) => JSON.stringify({ version: 1, receipts }),
      mutation: fn,
    }) as R;
  }
  claim(job: CronJob): string {
    const id = randomUUID();
    return this.change((rows) => {
      if (rows.length >= LIMIT)
        throw Error("Pending automation notifications must be delivered before starting more jobs");
      const existing = rows.find(
        (r) =>
          r.notice.job.id === job.id &&
          r.notice.job.createdAt === job.createdAt &&
          (r.once || r.state === "running"),
      );
      if (existing) throw Error("Automation already has a durable execution claim");
      return {
        value: [
          ...rows,
          {
            id,
            state: "running",
            startedAt: Date.now(),
            once: job.once === true,
            notice: noticeFor({ type: "job_start", job }),
          },
        ],
        result: id,
      };
    });
  }
  finish(id: string, event: CronJobLifecycleEvent): CronNotice {
    return this.change((rows) => {
      const receipt = rows.find((r) => r.id === id);
      if (!receipt || receipt.state !== "running")
        throw Error("Automation execution receipt is no longer active");
      receipt.notice = noticeFor(event);
      receipt.state = "pending";
      return { value: rows, result: receipt.notice };
    });
  }
  /** A missed timer has no Engine side effect, but still owes its notice. */
  missed(event: CronJobLifecycleEvent): string {
    const id = randomUUID();
    return this.change((rows) => {
      const old = rows.find(
        (r) =>
          r.notice.type === "job_missed" &&
          r.notice.scheduledFor === event.scheduledFor &&
          r.notice.job.id === event.job.id &&
          r.notice.job.createdAt === event.job.createdAt,
      );
      if (old) return { result: old.id };
      if (rows.length >= LIMIT) throw Error("Automation notification backlog is full");
      return {
        value: [
          ...rows,
          {
            id,
            state: "pending",
            startedAt: Date.now(),
            once: event.job.once === true,
            notice: noticeFor(event),
          },
        ],
        result: id,
      };
    });
  }
  /** Call only after the former utility has exited. A recorded claim is never
   * used to run the effect again; it remains inspectable as interrupted. */
  recover(): Receipt[] {
    const receipts = this.change((rows) => {
      let changed = false;
      for (const r of rows)
        if (r.state === "running") {
          r.state = "pending";
          r.interrupted = true;
          r.notice = {
            ...r.notice,
            type: "job_error",
            error: "Automation Host stopped before recording the outcome",
          };
          changed = true;
        }
      return { ...(changed && { value: rows }), result: rows };
    });
    if (receipts.length)
      this.store.mutate((jobs) => {
        const pending = new Map(receipts.map((row) => [row.notice.job.id, row]));
        return {
          jobs: jobs
            .filter((job) => {
              const row = pending.get(job.id);
              return !row?.once || row.notice.job.createdAt !== job.createdAt;
            })
            .map((job) => {
              const row = pending.get(job.id);
              if (row?.notice.job.createdAt !== job.createdAt || row.interrupted !== true)
                return job;
              return {
                ...job,
                enabled: false,
                disabledReason: row.notice.error,
                lastExecution: {
                  id: row.id,
                  status: "interrupted",
                  startedAt: row.startedAt,
                  finishedAt: Math.max(Date.now(), row.startedAt),
                  detail: row.notice.error,
                },
              };
            }),
          result: null,
        };
      });
    return receipts;
  }
  acknowledge(id: string): void {
    const receipt = this.change((rows) => ({
      result: rows.find((r) => r.id === id && r.state === "pending"),
    }));
    if (!receipt) return;
    // A crash between delivery and the scheduler's own finally must not re-arm an absolute one-shot.
    if (receipt.once)
      this.store.mutate((jobs) => ({
        jobs: jobs.filter(
          (job) =>
            job.id !== receipt.notice.job.id || job.createdAt !== receipt.notice.job.createdAt,
        ),
        result: null,
      }));
    this.change((rows) => ({ value: rows.filter((r) => r.id !== id), result: undefined }));
  }
}
