/**
 * Desktop automation host — builds the execution backend that fired cron jobs
 * run through.
 *
 * Phase 2 path (preferred): a RunManager configured read-only. Each fired job
 * is submitted to the manager, lands in the RunStore, and shows up in the
 * existing runs UI with full history/checkpoint/resume.
 *
 * Phase 1 path (kept as fallback): a one-shot headless Engine per job.
 *
 * Read-only contract until sandbox + write tiers land (Phase 4/5): the
 * RunManager is created with HeadlessApprovalBackend("approve-read-only") and
 * permissionMode "default", so reads are auto-approved and writes denied.
 */

import {
  Engine,
  SettingsManager,
  createRunManager,
  HeadlessApprovalBackend,
  type RunManager,
  type CronRunner,
  type CronRunResult,
} from "@cjhyy/code-shell-core";

/**
 * Build a read-only RunManager for automation. Per-job cwd is passed at submit
 * time (bindCronToRunManager), so the manager's own cwd is only a default.
 */
export function buildDesktopRunManager(): RunManager {
  const settings = new SettingsManager(process.cwd(), "full").get();
  return createRunManager({
    llm: {
      provider: settings.model.provider,
      model: settings.model.name,
      apiKey: settings.model.apiKey ?? "",
      baseUrl: settings.model.baseUrl,
      maxTokens: settings.model.maxTokens,
    },
    cwd: process.cwd(),
    // Read-only contract: unattended runs auto-approve reads, deny writes.
    // permissionMode "default" so the classifier doesn't add acceptEdits
    // write-allow rules ahead of the backend.
    permissionMode: "default",
    approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
  });
}

/** Build a CronRunner that runs each job as a one-shot read-only headless Engine. */
export function buildDesktopAutomationRunner(): CronRunner {
  return async (req): Promise<CronRunResult> => {
    // CronJob.cwd is added in Phase 2; read defensively so Phase 1 compiles and
    // Phase 2 can add the field without touching this runner.
    const jobCwd = (req.job as { cwd?: string }).cwd ?? process.cwd();
    const settings = new SettingsManager(jobCwd, "full").get();
    const engine = new Engine({
      llm: {
        provider: settings.model.provider,
        model: settings.model.name,
        apiKey: settings.model.apiKey ?? "",
        baseUrl: settings.model.baseUrl,
        maxTokens: settings.model.maxTokens,
      },
      cwd: jobCwd,
      settingsScope: "full",
      headless: true,
      // Read-only contract from bindCronToEngine — cron is unattended.
      permissionMode: req.permissionMode,
      approvalBackend: req.approvalBackend,
    });
    const result = await engine.run(req.prompt, { cwd: jobCwd });
    return { text: result.text, reason: result.reason };
  };
}
