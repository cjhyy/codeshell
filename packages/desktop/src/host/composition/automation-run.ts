import {
  resolveWritePolicy,
  type CronJob,
  type CronRunner,
  type CronRunResult,
} from "@cjhyy/code-shell-core/internal";
import {
  buildDesktopAutomationRunner,
  type AutomationSessionMeta,
} from "../../main/automation-host.js";
import { ConfiguredBrowserRuntime } from "../../main/browser-runtime/configured-runtime.js";
import { DedicatedPlaywrightBackend } from "../../main/browser-runtime/playwright-backend.js";

import type { HostRunOperations } from "./run-operations.js";

export type AutomationRunNotice =
  | { type: "session"; meta: AutomationSessionMeta }
  | { type: "ended"; sessionId: string };

interface AutomationRunServices {
  operations: Pick<HostRunOperations, "open">;
  notice(message: AutomationRunNotice): void;
  share(sessionId: string, enabled: boolean): void;
  publish(sessionId: string, event: unknown): void;
  drain(): Promise<void>;
}

/** Only the native scheduler can submit a persisted job. The utility derives its
 * execution policy from the job and publishes output directly to the durable stream. */
export class HostAutomationRuns {
  private readonly runtime = new ConfiguredBrowserRuntime(
    [new DedicatedPlaywrightBackend()],
    "dedicated-playwright",
  );
  private readonly running = new Map<string, Promise<CronRunResult>>();
  private readonly execute: CronRunner;

  constructor(services: AutomationRunServices) {
    this.execute = buildDesktopAutomationRunner(
      (sessionId, event) => {
        services.publish(sessionId, event);
        if ((event as { type?: string })?.type === "run_result")
          services.notice({ type: "ended", sessionId });
      },
      (meta) => {
        services.share(meta.sessionId, true);
        services.notice({ type: "session", meta });
      },
      this.runtime,
      async (id) => {
        try {
          await services.drain();
        } finally {
          services.share(id, false);
        }
      },
      services.operations,
    );
  }

  async run(job: CronJob, searchPath: string, signal: AbortSignal): Promise<CronRunResult> {
    signal.throwIfAborted();
    if (job.resumeSessionId) throw new Error("A continuation requires the active session");
    if (this.running.has(job.id)) throw new Error("The automation is already running");
    // Includes the login-shell and managed helper paths installed after utility startup.
    process.env.PATH = searchPath;
    const result = this.execute({
      job,
      prompt: job.prompt,
      ...resolveWritePolicy(job.permissionLevel),
      signal,
    });
    this.running.set(job.id, result);
    try {
      return await result;
    } finally {
      this.running.delete(job.id);
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.running.values());
    this.runtime.closeAll();
  }
}
