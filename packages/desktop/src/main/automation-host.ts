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
  resolveLLMConfigForTag,
  type RunManager,
} from "@cjhyy/code-shell-core";
import {
  defaultSandboxConfig,
  type CronRunner,
  type CronRunResult,
  type CronJob,
  type WorkspaceContext,
} from "@cjhyy/code-shell-core/internal";
import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveProjectRoot } from "@cjhyy/code-shell-capability-coding/git";
import { readAutomationMemory, appendAutomationMemory } from "./automationMemory.js";
import { AUTOMATION_DISABLED_TOOLS } from "./automationToolset.js";
import { stablePromptHash } from "@cjhyy/code-shell-server/storage";
import { browserRuntime, type BrowserRuntimeLike } from "./browser-runtime/index.js";
import { getProjectStore } from "./project-store.js";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { getTrustCachedSync } from "./trust-store.js";
import {
  desktopAutomationAuthorityDeps,
  validateAutomationResumeAuthority,
  type AutomationResumeAuthorityValidation,
} from "./automation-authority.js";

export interface AutomationWorkspaceResolution {
  cwd: string;
  projectTrusted: boolean;
  workspaceContext?: WorkspaceContext;
}

export interface AutomationWorkspaceDeps {
  noRepoCwd: () => string;
  foldProjectRoot: (cwd: string) => string;
  resolveProjectRoot: (
    cwd: string,
  ) => { cwd: string; trustCwd: string; workspaceContext: WorkspaceContext } | undefined;
  resolveProjectRootById: (
    projectId: string,
    rootId: string,
  ) => { cwd: string; trustCwd: string; workspaceContext: WorkspaceContext } | undefined;
  hasPersistedSessionCwd: (cwd: string) => boolean;
  isProjectTrusted: (cwd: string) => boolean;
  isNoRepoCwd: (cwd: string) => boolean;
  isDirectory: (cwd: string) => boolean;
}

export function resolveAutomationWorkspace(
  job: Pick<CronJob, "cwd" | "projectId" | "rootId">,
  deps: AutomationWorkspaceDeps,
): AutomationWorkspaceResolution | null {
  const hasStableId = job.projectId !== undefined || job.rootId !== undefined;
  if (hasStableId) {
    if (!job.projectId || !job.rootId) return null;
    const project = deps.resolveProjectRootById(job.projectId, job.rootId);
    if (!project || !deps.isDirectory(project.cwd)) return null;
    return {
      cwd: project.cwd,
      projectTrusted: deps.isProjectTrusted(project.trustCwd),
      workspaceContext: project.workspaceContext,
    };
  }
  const requestedCwd = job.cwd;
  if (!requestedCwd) {
    const cwd = deps.noRepoCwd();
    return { cwd, projectTrusted: false };
  }
  let cwd: string;
  try {
    cwd = deps.foldProjectRoot(requestedCwd);
  } catch {
    return null;
  }
  if (deps.isNoRepoCwd(cwd)) {
    return { cwd: deps.noRepoCwd(), projectTrusted: false };
  }
  if (!deps.isDirectory(cwd)) return null;
  const project = deps.resolveProjectRoot(cwd);
  if (project) {
    return {
      cwd: project.cwd,
      projectTrusted: deps.isProjectTrusted(project.trustCwd),
      workspaceContext: project.workspaceContext,
    };
  }
  if (deps.hasPersistedSessionCwd(cwd)) {
    return { cwd, projectTrusted: deps.isProjectTrusted(cwd) };
  }
  return null;
}

function resolveDesktopAutomationWorkspace(
  job: Pick<CronJob, "cwd" | "projectId" | "rootId">,
): AutomationWorkspaceResolution | null {
  return resolveAutomationWorkspace(job, {
    noRepoCwd: automationNoRepoCwd,
    foldProjectRoot: resolveProjectRoot,
    resolveProjectRoot: (candidate) => {
      const resolved = getProjectStore().resolveExactRootSync(candidate);
      return resolved
        ? {
            cwd: resolved.cwd,
            trustCwd: resolved.mainRoot.path,
            workspaceContext: resolved.workspaceContext,
          }
        : undefined;
    },
    resolveProjectRootById: (projectId, rootId) => {
      try {
        const resolved = getProjectStore().resolveProjectRootByIdSync(projectId, rootId);
        return {
          cwd: resolved.cwd,
          trustCwd: resolved.mainRoot.path,
          workspaceContext: resolved.workspaceContext,
        };
      } catch {
        return undefined;
      }
    },
    hasPersistedSessionCwd: (candidate) =>
      getSessionCwdIndex().resolveConfirmedCwds([candidate])[0] === true,
    isProjectTrusted: (candidate) => getTrustCachedSync(candidate) === "trusted",
    isNoRepoCwd: (candidate) => getProjectStore().isNoRepoCwd(candidate),
    isDirectory: existingDirectory,
  });
}

/** Trigger-time durable Session preflight for resume jobs. */
export function resolveDesktopAutomationJobWorkspace(
  job: Pick<CronJob, "cwd" | "projectId" | "rootId" | "resumeSessionId">,
): Promise<AutomationResumeAuthorityValidation> {
  return validateAutomationResumeAuthority(job, desktopAutomationAuthorityDeps());
}

function existingDirectory(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function automationNoRepoCwd(): string {
  const cwd = join(homedir(), ".code-shell", "no-repo");
  mkdirSync(cwd, { recursive: true });
  return cwd;
}

/**
 * Build a read-only RunManager for automation. Per-job cwd is passed at submit
 * time (bindCronToRunManager), so the manager's own cwd is only a default.
 */
export function buildDesktopRunManager(): RunManager {
  const settings = new SettingsManager(process.cwd(), "full").get();
  const llm = resolveLLMConfigForTag(
    settings,
    "text",
    (settings as { defaults?: { text?: string } }).defaults?.text,
  );
  if (!llm) throw new Error("自动化:没有可用的文本模型连接,请在「连接」页配置。");
  return createRunManager({
    llm,
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
  /** Stable id shared by the live UI bubble and the transcript user message. */
  clientMessageId?: string;
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
  runtime: BrowserRuntimeLike = browserRuntime,
): CronRunner {
  return async (req): Promise<CronRunResult> => {
    const workspace = resolveDesktopAutomationWorkspace(req.job);
    if (!workspace) {
      return {
        text: "",
        reason: "workspace-unresolved",
        stop: { reason: "workspace-unresolved" },
      };
    }
    const jobCwd = workspace.cwd;
    const settings = new SettingsManager(jobCwd, "full").get();
    const llm = resolveLLMConfigForTag(
      settings,
      "text",
      (settings as { defaults?: { text?: string } }).defaults?.text,
    );
    if (!llm) throw new Error("自动化任务:没有可用的文本模型连接。");

    // This runner is ONLY the isolated-automation path (a fresh headless session
    // per fire). "Continue this conversation" jobs (job.resumeSessionId set) are
    // routed away from here by makeCronRunnerWithResume — they feed their prompt
    // into the LIVE session instead, so they never build a headless Engine.

    // Task-level cross-run memory: prior run summaries the job left for itself.
    // This is system-level context (notes from earlier runs), NOT something the
    // user typed — so it rides appendSystemPrompt, not the user prompt. Folding
    // it into req.prompt made it indistinguishable from a user instruction
    // (prompt-injection shaped) and polluted the user turn shown in the UI.
    const memory = readAutomationMemory(req.job.id);
    const appendSystemPrompt = memory.trim()
      ? `${AUTOMATION_PROMPT_NOTE}\n\n<previous_runs_memory>\n${memory.trim()}\n</previous_runs_memory>`
      : AUTOMATION_PROMPT_NOTE;

    // A headless Engine has no renderer-owned <webview>. Give it an explicit,
    // lazy Dedicated Playwright lease instead. The stable per-job user-data
    // directory preserves an intentionally established login across fires
    // without sharing cookies between unrelated automations. No Chromium process
    // is created unless the model actually calls a browser tool.
    const browserLease = await runtime.acquire({
      ownerId: `automation:${req.job.id}`,
      profileId: `automation:${req.job.id}`,
      visibility: "hidden",
      backendPreference: "dedicated-playwright",
      title: `CodeShell 自动化 · ${req.job.name?.trim() || req.job.id}`,
    });
    try {
      const engine = new Engine({
        llm,
        cwd: jobCwd,
        workspaceContext: workspace.workspaceContext,
        projectTrusted: workspace.projectTrusted,
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
        // Permission tier from the job (bindCronToEngine → resolveWritePolicy).
        permissionMode: req.permissionMode,
        approvalBackend: req.approvalBackend,
        // Confine writes/shell to the workspace per the job's tier — defense in
        // depth on top of the approval backend (§5.6 #9).
        sandbox: defaultSandboxConfig(req.sandboxMode),
        browserBridge: browserLease.bridge,
      });

      // Let the run persist a one-paragraph summary for the NEXT scheduled run.
      // The sink writes to this job's task-level memory.md.
      const memoryTool = makeUpdateAutomationMemoryTool((summary) =>
        appendAutomationMemory(req.job.id, summary),
      );
      engine.registerCustomTool(memoryTool.definition, memoryTool.execute);
      const clientMessageId = `automation:${req.job.id}:${stablePromptHash(req.job.prompt)}`;

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
                  onSession({
                    sessionId: sid,
                    cwd: jobCwd,
                    title: `${name} ${date}`,
                    prompt: req.job.prompt,
                    cronJobId: req.job.id,
                    clientMessageId,
                  });
                }
              }
              emit?.(sid ?? req.job.id, e);
            }
          : undefined;
      try {
        const result = await engine.run(req.prompt, {
          cwd: jobCwd,
          workspaceContext: workspace.workspaceContext,
          onStream,
          signal: req.signal,
          clientMessageId,
        });
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
    } finally {
      browserLease.release();
    }
  };
}

/**
 * Feed a "continue this conversation" job's prompt into an EXISTING codeshell
 * session as a new user turn — the "cron = a human typing at a scheduled time"
 * model. The resumed run is a real chat, so it inherits that session's own cwd /
 * permission mode / tools / background-completion wakeup — none of the isolated
 * headless-automation framing applies. Resolves with the run outcome (or a
 * failure result the scheduler can log). See
 * docs/superpowers/specs/2026-07-01-cron-resume-as-fed-input-and-fold-fix-design.md.
 */
export type ResumeInjector = (
  sessionId: string,
  prompt: string,
  signal?: AbortSignal,
  job?: CronJob,
) => Promise<CronRunResult>;

/**
 * Wrap the isolated-automation headless runner so that jobs carrying a
 * `resumeSessionId` are routed to `injectResume` (feed the live session)
 * instead of building a fresh headless Engine. Jobs without one keep the
 * headless isolated-automation path unchanged.
 *
 * An empty-string resumeSessionId is treated as absent (defensive: a persisted
 * "" must not force a resume with no target).
 */
export function makeCronRunnerWithResume(
  headless: CronRunner,
  injectResume: ResumeInjector,
  validateWorkspace?: (
    job: CronJob,
  ) => AutomationResumeAuthorityValidation | Promise<AutomationResumeAuthorityValidation>,
): CronRunner {
  return async (req): Promise<CronRunResult> => {
    const sid = req.job.resumeSessionId;
    if (typeof sid === "string" && sid.length > 0) {
      if (validateWorkspace) {
        const validation = await validateWorkspace(req.job);
        if (!validation.ok) {
          return {
            text: "",
            reason: "resume-authority-invalid",
            stop: { reason: validation.reason },
          };
        }
      }
      return injectResume(sid, req.prompt, req.signal, req.job);
    }
    return headless(req);
  };
}
