/**
 * Desktop automation host — builds the read-only Engine runner that fired
 * cron jobs execute through. Phase 1 runs a one-shot headless Engine per job
 * (read-only: bindCronToEngine supplies permissionMode "default" + a read-only
 * approval backend). Phase 2 will replace this with RunManager.submit().
 */

import {
  Engine,
  SettingsManager,
  type CronRunner,
  type CronRunResult,
} from "@cjhyy/code-shell-core";

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
