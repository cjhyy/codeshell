import type { PetRuleScheduler, PetRuleSchedulerDeps } from "../../main/pet/pet-rule-schedule.js";
import type { CronNotice } from "./execution-receipts.js";
import type { CronJob, CronRunResult } from "@cjhyy/code-shell-core/internal";
import type { MessagePort } from "node:worker_threads";
import { resolveDesktopAutomationJobWorkspace } from "../../main/automation-host.js";
import { isPetRuleScheduleJob } from "../../main/pet/pet-rule-schedule.js";
import type { HostAutomationRuns } from "../composition/automation-run.js";
import { CronPeer, nodeCronPort, type CronPort } from "./peer.js";
import type { CronCommand } from "./commands.js";

export class HostScheduler {
  private readonly storage: CronPeer;
  private native?: CronPeer;
  rules?: Pick<PetRuleScheduler, "wake" | "missed" | "repairSoon">;
  private searchPath = "";
  private ready?: Promise<unknown>;
  private closing = false;
  private readonly awaitingBind = new Set<() => void>();
  constructor(
    port: MessagePort,
    private readonly engines: Pick<HostAutomationRuns, "run">,
    private readonly startRetryDelays: readonly number[] = [500, 2000, 5000],
  ) {
    this.storage = new CronPeer(nodeCronPort(port), async (method, input, signal) => {
      const native = this.native;
      if (!native) throw Error("Native automation services unavailable");
      if (method === "execute") {
        const job = input as CronJob;
        if (job.resumeSessionId) {
          const validation = await resolveDesktopAutomationJobWorkspace(job);
          if (!validation.ok)
            return {
              reason: "resume-authority-invalid",
              text: "",
              stop: { reason: validation.reason },
            };
        }
        if (this.rules && isPetRuleScheduleJob(job)) {
          await this.rules.wake(job);
          return { text: "Scheduled rule wake handled", reason: "done" };
        }
        if (job.resumeSessionId || isPetRuleScheduleJob(job))
          return native.call<CronRunResult>("execute", job, signal);
        return this.engines.run(job, this.searchPath, signal);
      }
      if (method === "deliver" && this.rules) {
        const event = input as CronNotice;
        if (isPetRuleScheduleJob(event.job)) {
          if (event.type === "job_missed") await this.rules.missed(event.job);
          if (event.type === "job_error") this.rules.repairSoon();
          return;
        }
      }
      if (
        method === "deliver" ||
        method === "authorize" ||
        method === "definition" ||
        method === "started"
      )
        return native.call(method, input, signal);
      throw Error("Unknown scheduler request");
    });
  }
  fireRule(
    ...args: Parameters<PetRuleSchedulerDeps["fire"]>
  ): ReturnType<PetRuleSchedulerDeps["fire"]> {
    if (this.closing || !this.native) throw Error("Mimi schedule adapter unavailable");
    return this.native.call("fireRule", args);
  }
  bind(port: CronPort, searchPath: string) {
    if (this.native || this.closing) {
      port.close();
      return;
    }
    this.searchPath = searchPath;
    this.native = new CronPeer(port, () => {
      throw Error("Unexpected native request");
    });
    this.ready = this.start();
    for (const wake of this.awaitingBind) wake();
    const native = this.native;
    void this.ready
      .then(() => native.call("online", undefined))
      .catch((e) => {
        console.error("[Desktop Host] Scheduler failed to start", e);
        native.close();
        // Leave the rejected start for waiting commands, but accept another adapter.
        if (this.native === native) this.native = undefined;
      });
  }
  /** A contended store lock or an unreadable receipt file at startup is usually brief.
   * Storage start is idempotent; all attempts fit inside Main's startup wait. */
  private async start() {
    for (const delay of [...this.startRetryDelays, undefined]) {
      try {
        return await this.storage.call("start", undefined);
      } catch (error) {
        if (delay === undefined || this.closing) throw error;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  async command(cmd: CronCommand, permit: Int32Array, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!this.ready && !this.closing) {
      // The workbench can connect before Main has handed over the native adapter.
      // A command belongs to this Host generation and its originating document.
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          this.awaitingBind.delete(wake);
          signal.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.awaitingBind.delete(wake);
          reject(signal.reason);
        };
        this.awaitingBind.add(wake);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    if (this.closing || !this.ready) throw Error("Automation scheduler is closed");
    await this.ready;
    signal.throwIfAborted();
    if (this.closing) throw Error("Automation scheduler is closed");
    return this.storage.call("command", { cmd, permit }, signal);
  }
  async close() {
    this.closing = true;
    for (const wake of this.awaitingBind) wake();
    try {
      if (this.ready) await this.storage.call("stop", undefined);
    } finally {
      this.storage.close();
      this.native?.close();
    }
  }
}
