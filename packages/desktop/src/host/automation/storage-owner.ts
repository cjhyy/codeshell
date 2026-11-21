import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import {
  CronScheduler,
  CronStore,
  defaultCronStorePath,
  type CronRunResult,
} from "@cjhyy/code-shell-core/internal";
import {
  createAutomation,
  updateAutomation,
  deleteAutomation,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  cancelAutomationRun,
  reloadAutomations,
  listAutomations,
  getAutomation,
  listAutomationsForResumeSession,
  setAutomationScheduler,
} from "../../main/automation-service.js";
import { desktopAutomationAuthorityDeps } from "../../main/automation-authority.js";
import { createAutomationFromPluginTemplate } from "../../main/plugin-automation-service.js";
import { createDesktopPanelAutomationHost } from "../../main/panel-automation-host.js";
import { isPetRuleScheduleJob } from "../../main/pet/pet-rule-schedule.js";
import { CronExecutionReceipts, type CronNotice } from "./execution-receipts.js";
import { CronPeer, nodeCronPort } from "./peer.js";
import type { CronCommand } from "./commands.js";

export function attachCronStorage(
  port: import("node:worker_threads").MessagePort,
  file = defaultCronStorePath(),
) {
  const grants = new AsyncLocalStorage<Int32Array>();
  const check = () => {
    const p = grants.getStore();
    if (p && Atomics.compareExchange(p, 0, 0, 1) === -1)
      throw Error("Automation change was withdrawn");
  };
  const store = new CronStore(file, { strictRead: true, beforeCommit: check });
  const scheduler = new CronScheduler(store);
  const receipts = new CronExecutionReceipts(join(dirname(file), "cron-deliveries.json"), store);
  const active = new Map<string, string>();
  const pending = new Map<string, CronNotice>();
  const delivering = new Set<string>();
  let started = false,
    stopped = false;
  let retry: NodeJS.Timeout | undefined;
  function flush() {
    if (stopped) return;
    for (const [id, notice] of pending) {
      if (delivering.has(id)) continue;
      delivering.add(id);
      void peer
        .call("deliver", notice)
        .then(() => {
          receipts.acknowledge(id);
          pending.delete(id);
        })
        .catch(() => {
          if (!stopped && !retry)
            retry = setTimeout(() => {
              retry = undefined;
              flush();
            }, 1000).unref();
        })
        .finally(() => delivering.delete(id));
    }
  }
  function start() {
    if (started) return true;
    for (const row of receipts.recover()) pending.set(row.id, row.notice);
    setAutomationScheduler(scheduler);
    scheduler.setDefinitionListener((id) => {
      void peer.call("definition", id).catch(() => {});
    });
    scheduler.setExecutor(async (job, signal) => {
      const id = receipts.claim(job);
      active.set(job.id, id);
      void peer.call("started", job.id).catch(() => {});
      const result = await peer.call<CronRunResult>("execute", job, signal);
      if (result.stop) {
        scheduler.disableWithReason(job.id, result.stop.reason);
        return { stoppedReason: result.stop.reason };
      }
    });
    scheduler.setJobEventListener((event) => {
      if (event.type === "job_start") return;
      const id = event.type === "job_missed" ? receipts.missed(event) : active.get(event.job.id);
      if (!id) return;
      const notice = event.type === "job_missed" ? event : receipts.finish(id, event);
      active.delete(event.job.id);
      pending.set(id, notice);
      flush();
    });
    scheduler.loadJobs();
    started = true;
    flush();
    return true;
  }
  async function command(cmd: CronCommand) {
    if (!started || stopped) throw Error("Automation scheduler is unavailable");
    const deps = desktopAutomationAuthorityDeps;
    switch (cmd.method) {
      case "list":
        return listAutomations();
      case "get":
        return getAutomation(cmd.input);
      case "forSession":
        return listAutomationsForResumeSession(cmd.input, deps());
      case "create":
        return createAutomation(cmd.input, deps());
      case "update":
        return updateAutomation(cmd.input.id, cmd.input.patch, deps(), cmd.input.scope);
      case "delete":
        return deleteAutomation(cmd.input);
      case "pause":
        return pauseAutomation(cmd.input);
      case "resume":
        return resumeAutomation(cmd.input);
      case "runNow":
        check();
        return runAutomationNow(cmd.input);
      case "cancel":
        check();
        return cancelAutomationRun(cmd.input);
      case "reload":
        return reloadAutomations();
      case "template": {
        const { installKey, templateId, expectedRevision, workspace } = cmd.input;
        return createAutomationFromPluginTemplate(
          installKey,
          templateId,
          expectedRevision,
          workspace,
          deps(),
        );
      }
      case "panel": {
        const { scope, method, params, grantId } = cmd.input;
        return createDesktopPanelAutomationHost(deps).call(
          {
            ...scope,
            isAuthorized: () => peer.call<boolean>("authorize", grantId),
            assertAuthorized: check,
          },
          method,
          params,
        );
      }
      case "petList":
        return scheduler.list().filter(isPetRuleScheduleJob);
      case "petCreate": {
        const { name, schedule, prompt, options } = cmd.input;
        if (!isPetRuleScheduleJob(options)) throw Error("Invalid scheduled Mimi job");
        return scheduler.create(name, schedule, prompt, options);
      }
      case "petDelete": {
        const job = scheduler.get(cmd.input);
        return !!job && isPetRuleScheduleJob(job) && scheduler.delete(job.id);
      }
      default:
        throw Error("Unknown automation operation");
    }
  }
  async function stop() {
    stopped = true;
    clearTimeout(retry);
    scheduler.setExecutionEnabled(false);
    await Promise.allSettled([...active.keys()].map((id) => scheduler.abort(id)));
    setAutomationScheduler(null);
  }
  const peer: CronPeer = new CronPeer(
    nodeCronPort(port),
    async (method, params) => {
      if (method === "start") return start();
      if (method === "stop") return stop();
      if (method !== "command") throw Error("Unknown automation storage request");
      const { cmd, permit } = params as { cmd: CronCommand; permit: Int32Array };
      return grants.run(permit, () => command(cmd));
    },
    () => {
      void stop();
    },
  );
  return peer;
}
