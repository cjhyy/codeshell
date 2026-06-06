/**
 * Desktop automation host — builds the execution backend that fired cron jobs
 * run through.
 *
 * Active path: a one-shot HEADLESS Engine per job (`buildDesktopAutomationRunner`).
 * Each run uses the job's cwd for config/skills, honors the job's permission tier
 * (resolveWritePolicy → read-only/workspace-write/full), auto-writes a full
 * transcript.jsonl (so the run's content is visible like a chat), keeps a
 * per-task memory.md (the agent calls UpdateAutomationMemory at the end), and
 * streams events to the renderer via the injected `emit`/`onSession` callbacks
 * so the run shows up live in the project sidebar.
 *
 * Fallback (降级保留, no production consumer): `buildDesktopRunManager` — the
 * earlier RunManager-backed path (RunStore + checkpoint/resume/evaluator). Kept
 * for future long/expensive jobs that need durable resume; not wired up now.
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

/** Metadata the renderer needs to live-create a sidebar session for an
 *  automation run: the real engine sessionId, the job cwd (to group under
 *  the right project), and a display title. */
export interface AutomationSessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  /** The cron job id that owns this run. The renderer stores it on the session
   *  so deleting a still-running automation session can cancel the in-flight
   *  run (window.codeshell.cancelAutomationRun(cronJobId)) before deleting the
   *  on-disk session dir. */
  cronJobId: string;
  /** The job's prompt (the triggering "user" message) so the renderer can show
   *  it as the opening message — automation never goes through the chat send()
   *  path, so this is the only way the prompt reaches the live UI. The ORIGINAL
   *  prompt, not the memory-prepended one fed to the engine. */
  prompt: string;
}

/**
 * Build a CronRunner that runs each job as a one-shot read-only headless Engine.
 *
 * `emit`, when provided, forwards Engine stream events (keyed by the real engine
 * sessionId) so the main process can build a live snapshot / broadcast to the
 * renderer stream.
 *
 * `onSession`, when provided, fires ONCE per run the moment the engine
 * sessionId is known (on `session_started`), carrying the job cwd + a display
 * title. The renderer uses this to live-create the sidebar session under the
 * project that owns the cwd — stream events alone carry no cwd, so without this
 * a live automation run can't be attributed to a project until the next startup
 * backfill from disk.
 */
export function buildDesktopAutomationRunner(
  emit?: (sessionId: string, event: unknown) => void,
  onSession?: (meta: AutomationSessionMeta) => void,
): CronRunner {
  return async (req): Promise<CronRunResult> => {
    const jobCwd = req.job.cwd ?? process.cwd();
    const settings = new SettingsManager(jobCwd, "full").get();
    // Task-level cross-run memory: prior run summaries the job left for itself.
    // This is system-level context (notes from earlier runs), NOT something the
    // user typed — so it rides appendSystemPrompt, not the user prompt. Folding
    // it into req.prompt made it indistinguishable from a user instruction
    // (prompt-injection shaped) and polluted the user turn shown in the UI.
    const memory = readAutomationMemory(req.job.id);
    const appendSystemPrompt = memory.trim()
      ? `${AUTOMATION_PROMPT_NOTE}\n\n<previous_runs_memory>\n${memory.trim()}\n</previous_runs_memory>`
      : AUTOMATION_PROMPT_NOTE;

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
      origin: "automation",
      // This is an unattended automation run — tell the model so it doesn't
      // ask the user or offer to schedule automation, and so it persists a
      // cross-run memory summary on finish. Prior-run memory is appended here
      // too (see above) so it's framed as system context, not a user message.
      appendSystemPrompt,
      // Automation runs are unattended and should not block before the first
      // LLM request on plugin/user MCP startup. MCP tools are disabled below,
      // so explicitly keep the engine's MCP config empty for this one-shot run.
      mcpServers: {},
      // Strip the cron tools so an unattended run can't recursively schedule
      // more automations. (disabledBuiltinTools is a delta on the preset's
      // builtin set — see resolveBuiltinToolNames.)
      disabledBuiltinTools: [...AUTOMATION_DISABLED_TOOLS],
      // Reject Bash(run_in_background=true) too — the param survives even
      // though the companion tools are stripped (design §5.5).
      allowBackgroundShells: false,
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

    // Key emitted events by the REAL engine sessionId (carried on the first
    // `session_started` event) so renderer routing/reconnect matches interactive
    // chat. Fall back to job.id until that event is seen.
    let sid: string | undefined;
    const onStream =
      emit || onSession
        ? (e: unknown) => {
            const ev = e as { type?: string; sessionId?: string };
            if (ev.type === "session_started" && typeof ev.sessionId === "string") {
              const firstBind = sid === undefined;
              sid = ev.sessionId;
              // Announce the session ONCE so the renderer can attribute this
              // live run to the project owning jobCwd and title it nicely.
              if (firstBind && onSession) {
                const name = req.job.name?.trim() || req.job.id;
                const date = new Date().toLocaleDateString();
                onSession({ sessionId: sid, cwd: jobCwd, title: `${name} ${date}`, prompt: req.job.prompt, cronJobId: req.job.id });
              }
            }
            emit?.(sid ?? req.job.id, e);
          }
        : undefined;
    try {
      const result = await engine.run(req.prompt, { cwd: jobCwd, onStream, signal: req.signal });
      return { text: result.text, reason: result.reason };
    } catch (err) {
      // engine.run normally emits its own terminal turn_complete/error, which
      // the renderer uses to clear the sidebar "running" spinner it raised on
      // the announce. But post-turn cleanup (background-agent drain, on_session_end
      // hooks, memory pipeline) runs after the turn loop with no catch — a throw
      // there skips that terminal event. If we'd already announced the session
      // (so the renderer is showing a spinner), synthesize one terminal `error`
      // event so the spinner clears instead of sticking forever. No-op when the
      // throw happened before session_started (nothing was marked busy yet).
      if (sid !== undefined) {
        // The envelope supplies the sessionId (emit's first arg); the `error`
        // StreamEvent itself is just { type, error } (see core types.ts).
        emit?.(sid, {
          type: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      }
      throw err;
    }
  };
}
