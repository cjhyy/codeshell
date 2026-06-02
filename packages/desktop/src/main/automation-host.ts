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
  makeUpdateAutomationMemoryTool,
  AUTOMATION_PROMPT_NOTE,
  type RunManager,
  type CronRunner,
  type CronRunResult,
} from "@cjhyy/code-shell-core";
import { readAutomationMemory, appendAutomationMemory } from "./automationMemory.js";
import { AUTOMATION_DISABLED_TOOLS } from "./automationToolset.js";

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

/**
 * Build a CronRunner that runs each job as a one-shot read-only headless Engine.
 *
 * `emit`, when provided, forwards Engine stream events (keyed by job id) so the
 * main process can build a live snapshot / write a transcript (later task B5
 * refines the session id).
 */
export function buildDesktopAutomationRunner(
  emit?: (sessionId: string, event: unknown) => void,
): CronRunner {
  return async (req): Promise<CronRunResult> => {
    const jobCwd = req.job.cwd ?? process.cwd();
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
      // This is an unattended automation run — tell the model so it doesn't
      // ask the user or offer to schedule automation, and so it persists a
      // cross-run memory summary on finish.
      appendSystemPrompt: AUTOMATION_PROMPT_NOTE,
      // Strip the cron tools so an unattended run can't recursively schedule
      // more automations. (disabledBuiltinTools is a delta on the preset's
      // builtin set — see resolveBuiltinToolNames.)
      disabledBuiltinTools: [...AUTOMATION_DISABLED_TOOLS],
      // Read-only contract from bindCronToEngine — cron is unattended.
      permissionMode: req.permissionMode,
      approvalBackend: req.approvalBackend,
    });

    // Let the run persist a one-paragraph summary for the NEXT scheduled run.
    // The sink writes to this job's task-level memory.md.
    const memoryTool = makeUpdateAutomationMemoryTool((summary) =>
      appendAutomationMemory(req.job.id, summary),
    );
    engine.registerCustomTool(memoryTool.definition, memoryTool.execute);

    // Task-level cross-run memory: prepend prior run summaries so the job can
    // build on what earlier runs learned.
    const memory = readAutomationMemory(req.job.id);
    const prompt = memory.trim()
      ? `<previous_runs_memory>\n${memory.trim()}\n</previous_runs_memory>\n\n${req.prompt}`
      : req.prompt;

    // Key emitted events by the REAL engine sessionId (carried on the first
    // `session_started` event) so renderer routing/reconnect matches interactive
    // chat. Fall back to job.id until that event is seen.
    let sid: string | undefined;
    const onStream = emit
      ? (e: unknown) => {
          const ev = e as { type?: string; sessionId?: string };
          if (ev.type === "session_started" && typeof ev.sessionId === "string") sid = ev.sessionId;
          emit(sid ?? req.job.id, e);
        }
      : undefined;
    const result = await engine.run(prompt, { cwd: jobCwd, onStream });
    return { text: result.text, reason: result.reason };
  };
}
