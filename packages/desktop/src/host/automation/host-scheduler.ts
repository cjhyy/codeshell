import type { CronJob, CronRunResult } from "@cjhyy/code-shell-core/internal";
import type { MessagePort } from "node:worker_threads";
import { resolveDesktopAutomationJobWorkspace } from "../../main/automation-host.js";
import { isPetRuleScheduleJob } from "../../main/pet/pet-rule-schedule.js";
import type { HostAutomationRuns } from "../composition/automation-run.js";
import { CronPeer, electronCronPort, nodeCronPort } from "./peer.js";
import type { CronCommand } from "./commands.js";

export class HostScheduler {
  private readonly storage: CronPeer;
  private native?: CronPeer;
  private searchPath = "";
  private ready?: Promise<unknown>;
  constructor(
    port: MessagePort,
    private readonly engines: HostAutomationRuns,
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
        if (job.resumeSessionId || isPetRuleScheduleJob(job))
          return native.call<CronRunResult>("execute", job, signal);
        return this.engines.run(job, this.searchPath, signal);
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
  bind(port: Electron.MessagePortMain, searchPath: string) {
    if (this.native) {
      port.close();
      return;
    }
    this.searchPath = searchPath;
    this.native = new CronPeer(electronCronPort(port), () => {
      throw Error("Unexpected native request");
    });
    this.ready = this.storage.call("start", undefined);
    const native = this.native;
    void this.ready
      .then(() => native.call("online", undefined))
      .catch((e) => {
        console.error("[Desktop Host] Scheduler failed to start", e);
        native.close();
      });
  }
  async command(cmd: CronCommand, permit: Int32Array) {
    if (!this.ready) {
      if (cmd.method === "list" || cmd.method === "forSession") return [];
      if (cmd.method === "get") return null;
      if (cmd.method === "reload") return;
      throw Error("Automation scheduler is not initialized");
    }
    await this.ready;
    return this.storage.call("command", { cmd, permit });
  }
  async close() {
    try {
      if (this.ready) await this.storage.call("stop", undefined);
    } finally {
      this.storage.close();
      this.native?.close();
    }
  }
}
