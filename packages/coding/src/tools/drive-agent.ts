import {
  backgroundJobRegistry,
  isExistingDirectory,
  logger,
  normalizeCwdPath,
  notificationQueue,
  type BackgroundJobEntry,
  type ToolContext,
  type ToolDefinition,
} from "@cjhyy/code-shell-core";
import { runAgentOnce, type AgentRunResult } from "../cc-orchestrator/external-agent-driver.js";
import { claudeAdapter, codexAdapter } from "../cc-orchestrator/agent-adapter.js";
import { readExternalChangedFiles } from "../cc-orchestrator/external-agent-changes.js";
import { existsSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  externalAgentSessionStore,
  type ExternalAgentSessionBinding,
  type ExternalAgentSessionRecord,
} from "../cc-orchestrator/external-agent-session-store.js";
import {
  branchExists,
  createWorktree,
  findGitRoot,
  inspectWorktreeChanges,
  lockWorktree,
  removeWorktree,
  unlockWorktree,
  type WorktreeSession,
} from "../git/worktree.js";
import { codingToolService } from "../capability-runtime.js";

export type DriveCli = "claude" | "codex";
export type DriveIsolation = "current" | "worktree" | "none";
export type DriveWorktreeCleanup = "auto" | "keep" | "detach" | "discard";

export const DRIVE_AGENT_FOREGROUND_HANDOFF_MS = 110_000;
export const DRIVE_AGENT_TOOL_TIMEOUT_MS = 1_800_000;

const CLI_ADAPTERS: Record<DriveCli, { adapter: typeof claudeAdapter; command: string }> = {
  claude: { adapter: claudeAdapter, command: "claude" },
  codex: { adapter: codexAdapter, command: "codex" },
};

export const driveAgentToolDef: ToolDefinition = {
  name: "DriveAgent",
  description:
    "Delegate a task to an external coding-agent CLI — drives `claude` (Claude Code) or `codex` " +
    "(OpenAI Codex) for one turn. Pick with `cli` (defaults to claude). Use to hand a coding/" +
    "research task to the agent, or continue an existing session of it. " +
    "Runs in the BACKGROUND by default — these tasks are typically long (minutes to hours), so this " +
    "returns immediately and the result is delivered to you later via a completion notification " +
    "that wakes you. Do NOT sleep-poll for it; just continue or end your turn — you'll be woken " +
    "with the result. " +
    "Before launching writable work in a cwd, call DriveAgentJobs(action:'list', cwd) to see any " +
    "already-running DriveAgent jobs there, their prompt summaries, owner sessions, CLI kind, and " +
    "known changed files; use DriveAgentJobs(action:'cancel', jobId) if you must stop one. " +
    "If the external agent is explicitly expected to write a workspace other than its launch cwd, " +
    "set effectiveWorkspaceCwd so cross-session conflict checks use that declared workspace; omit " +
    "it when the run writes in cwd. " +
    "For a quick task where you want the answer inline, pass background:false. " +
    "It has NO time concept of its own: for 'in N minutes' / 'every N' / looping, use CronCreate " +
    "instead (never sleep). A scheduled CronCreate job runs one codeshell turn whose prompt can " +
    "instruct it to call DriveAgent; to continue a prior session across runs, have that turn pass " +
    "the sessionId this tool returned as resumeSessionId (same cli). To make the single turn work " +
    "longer/deeper, write that into `prompt` (e.g. 'keep working until done'). " +
    "Pass `resumeSessionId` to continue a prior session of the SAME cli (keeps context); omit to start fresh.\n" +
    "SCOPE & BUDGET (read before fanning out): each driven agent consumes a large, SHARED token budget. " +
    "Do NOT launch many agents at once to 'cover more ground' — that burns the budget and leaves every " +
    "task half-done. Default to ONE agent at a time; only run a few in parallel when the work TRULY splits " +
    "into independent pieces, and even then keep the count small (≈2-3). Prefer finishing one task before " +
    "starting the next. " +
    "Make each `prompt` a COMPLETE, self-contained task that instructs the agent to finish the whole thing " +
    "end-to-end and verify its own work before returning — never a vague 'start looking into X'. " +
    "Give it a concrete definition of done and, for open-ended work, a bound (files/scope/steps) so it " +
    "doesn't sprawl. If a big job must be split, split it into a SEQUENCE you drive one at a time (resume " +
    "the same session), not a swarm launched simultaneously.",
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description:
          "The task for the agent. Make it COMPLETE and self-contained: state the goal, a concrete definition of done, and (for open-ended work) an explicit scope bound so it finishes end-to-end and verifies its own work rather than sprawling or stopping half-way.",
      },
      cli: {
        type: "string",
        enum: ["claude", "codex"],
        description:
          "Which external CLI to drive. 'claude' = Claude Code (default), 'codex' = OpenAI Codex. resumeSessionId is only valid against the same cli that produced it.",
      },
      resumeSessionId: {
        type: "string",
        description:
          "Existing session id to resume (keeps context). Must come from a prior run of the SAME cli. Omit for a fresh session.",
      },
      model: {
        type: "string",
        description:
          "Optional model override, passed through to `claude --model` / `codex exec --model`. Omit to use the CLI default; only pass when the user explicitly requests a model.",
      },
      cwd: { type: "string", description: "Working directory the run operates in." },
      isolation: {
        type: "string",
        enum: ["current", "worktree", "none"],
        description:
          "Workspace isolation. 'worktree' creates a unique per-run git worktree; 'current' uses the CodeShell session workspace; 'none' uses cwd directly. By default the first run uses cwd directly, while a parallel writable run targeting an already-busy workspace is automatically isolated; resumes reuse their bound workspace.",
      },
      baseRef: {
        type: "string",
        description:
          "Base for a new isolated worktree: 'head' (default), 'fresh' (locally-known origin/HEAD), or an explicit branch/ref/commit.",
      },
      include: {
        type: "array",
        items: { type: "string" },
        description:
          "Extra gitignore-style patterns to copy into a new worktree. Combined with repository .worktreeinclude; intended for ignored env/config files.",
      },
      cleanup: {
        type: "string",
        enum: ["auto", "keep", "detach", "discard"],
        description:
          "New worktree completion policy. auto (default) discards a clean/no-commit worktree and keeps one with changes; keep preserves directory+branch; detach removes the directory only when uncommitted changes are absent and preserves the branch; discard always deletes directory+branch.",
      },
      effectiveWorkspaceCwd: {
        type: "string",
        description:
          "Optional declared workspace the external agent is expected to write when that differs from its launch cwd (for example, an explicitly managed worktree it will cd into). Used for conflict detection only; the CLI still launches in cwd. Defaults to cwd.",
      },
      attachmentPaths: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional local file paths to hand to the driven agent. Paths must resolve inside cwd. Images are also passed to Codex with -i when the installed Codex CLI supports it; otherwise all paths are listed in the prompt.",
      },
      permissionMode: {
        type: "string",
        enum: ["default", "acceptEdits", "bypassPermissions"],
        description:
          "Permission/sandbox level. Defaults to 'bypassPermissions' (full auto — needed so the agent's tools run unattended; there is no interactive approval loop here). For codex: default→read-only sandbox, acceptEdits→workspace-write, bypassPermissions→no sandbox. Pass 'default'/'acceptEdits' to gate.",
      },
      background: {
        type: "boolean",
        description:
          "Defaults to TRUE: run in the background and notify you on completion (right for long tasks). Pass false to run in the foreground and get the result inline (only for quick tasks).",
      },
    },
    required: ["prompt"],
  },
};

type PermMode = "default" | "acceptEdits" | "bypassPermissions";
type Runner = (opts: {
  cli: DriveCli;
  prompt: string;
  resumeSessionId?: string;
  model?: string;
  cwd: string;
  permissionMode?: PermMode;
  signal?: AbortSignal;
  imagePaths?: string[];
}) => Promise<AgentRunResult>;
type SessionStore = {
  get(cli: DriveCli, sessionId: string): ExternalAgentSessionBinding | undefined;
  record(binding: ExternalAgentSessionRecord): void;
};

interface ManagedDriveWorktree {
  session: WorktreeSession;
  cleanup: DriveWorktreeCleanup;
  branchPrefix?: string;
}

interface WorktreeLifecycleResult {
  action: "kept" | "detached" | "discarded";
  note: string;
}

export interface DriveAgentToolOptions {
  foregroundHandoffMs?: number;
  sessionStore?: SessionStore;
  /** Test seam for external transcript attribution. */
  readChangedFiles?: typeof readExternalChangedFiles;
}

const defaultRunner: Runner = (opts) => {
  const { adapter, command } = CLI_ADAPTERS[opts.cli];
  return runAgentOnce(
    adapter,
    {
      command,
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      model: opts.model,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? "default",
      imagePaths: opts.imagePaths,
    },
    opts.signal,
  );
};

function newDriveJobId(): string {
  return `cc-${process.hrtime.bigint().toString(36)}`;
}

function newDriveRunSeed(): string {
  return process.hrtime.bigint().toString(36).padStart(8, "0");
}

function driveIsolationArg(value: unknown): DriveIsolation | undefined {
  return value === "current" || value === "worktree" || value === "none" ? value : undefined;
}

function driveCleanupArg(value: unknown): DriveWorktreeCleanup {
  return value === "keep" || value === "detach" || value === "discard" || value === "auto"
    ? value
    : "auto";
}

function driveIncludeArg(value: unknown): { patterns?: string[]; error?: string } {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    return { error: "include must be an array of non-empty gitignore-style patterns" };
  }
  return { patterns: value.map((item) => String(item).trim()) };
}

async function resolveDriveWorkspaceRoot(cwd: string): Promise<string> {
  try {
    return await findGitRoot(cwd);
  } catch {
    return normalizeCwdPath(cwd);
  }
}

function hasRunningDriveWriter(workspaceCwd: string, workspaceRoot: string): boolean {
  if (backgroundJobRegistry.listRunningByCwd(workspaceCwd).some(isDriveAgentJob)) return true;
  return backgroundJobRegistry
    .list()
    .some(
      (job) =>
        (job.status === "running" || job.status === "cancelling") &&
        isDriveAgentJob(job) &&
        job.workspaceRoot === workspaceRoot,
    );
}

async function prepareDriveWorktree(params: {
  cwd: string;
  cli: DriveCli;
  baseRef?: string;
  include?: string[];
  cleanup: DriveWorktreeCleanup;
  ctx?: ToolContext;
  signal?: AbortSignal;
}): Promise<ManagedDriveWorktree> {
  const gitRoot = await findGitRoot(params.cwd, params.signal);
  const branchPrefix = codingToolService(params.ctx)?.readWorktreeBranchPrefix(gitRoot);
  const session = await createWorktree(gitRoot, `drive-${params.cli}`, newDriveRunSeed(), {
    prefix: branchPrefix,
    signal: params.signal,
    baseRef: params.baseRef,
    include: params.include,
  });
  try {
    lockWorktree(session.worktreePath, `CodeShell DriveAgent ${params.cli} run`);
  } catch (error) {
    removeWorktree(session.worktreePath, true, { prefix: branchPrefix });
    throw error;
  }
  return { session, cleanup: params.cleanup, branchPrefix };
}

function finalizeDriveWorktree(managed: ManagedDriveWorktree): WorktreeLifecycleResult {
  const { session } = managed;
  let state;
  try {
    state = inspectWorktreeChanges(session.worktreePath, session.baseRef);
  } catch (error) {
    try {
      unlockWorktree(session.worktreePath);
    } catch {
      // Preservation is still safer than deleting a worktree we could not inspect.
    }
    return {
      action: "kept",
      note:
        `Worktree kept at ${session.worktreePath} (branch ${session.worktreeBranch}) because ` +
        `change inspection failed: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  let action = managed.cleanup;
  let safetyNote = "";
  if (action === "auto") action = state.hasChanges ? "keep" : "discard";
  if (action === "detach" && state.uncommitted) {
    action = "keep";
    safetyNote = " Requested detach was changed to keep because uncommitted changes are present.";
  }

  unlockWorktree(session.worktreePath);
  const summary = `uncommitted=${state.uncommitted}, commitsAhead=${state.commitsAhead}`;
  if (action === "keep") {
    return {
      action: "kept",
      note:
        `Worktree kept at ${session.worktreePath} (branch ${session.worktreeBranch}; ${summary}).` +
        `${safetyNote} Resume the external session in this path, or clean it later with ` +
        `DriveAgentJobs(action:"cleanup", cleanup:"detach"|"discard").`,
    };
  }
  if (action === "detach") {
    removeWorktree(session.worktreePath, false);
    return {
      action: "detached",
      note:
        `Worktree directory removed; branch ${session.worktreeBranch} preserved (${summary}). ` +
        `Review/merge the branch or recreate a worktree before resuming this external session.`,
    };
  }

  const removal = removeWorktree(session.worktreePath, true, { prefix: managed.branchPrefix });
  if (removal.branchDeleted === false) {
    return {
      action: "detached",
      note:
        `Worktree directory removed, but branch ${removal.branch ?? session.worktreeBranch} was ` +
        `preserved because deletion failed: ${removal.branchError ?? "unknown error"}.`,
    };
  }
  return {
    action: "discarded",
    note: `Clean worktree and branch ${session.worktreeBranch} removed (${summary}).`,
  };
}

function worktreeStartNote(managed: ManagedDriveWorktree | undefined): string | undefined {
  if (!managed) return undefined;
  const { session } = managed;
  return (
    `Isolation worktree: ${session.worktreePath}\n` +
    `Branch: ${session.worktreeBranch}\n` +
    `Base: ${session.baseRefLabel ?? session.baseRef ?? "HEAD"}; copied ignored files: ${session.includedFiles?.length ?? 0}; cleanup: ${managed.cleanup}`
  );
}

function appendLifecycleNote(text: string, lifecycle?: WorktreeLifecycleResult): string {
  return lifecycle ? `${text}${text ? "\n\n" : ""}[worktree lifecycle] ${lifecycle.note}` : text;
}

function safeFinalizeDriveWorktree(
  managed: ManagedDriveWorktree | undefined,
): WorktreeLifecycleResult | undefined {
  if (!managed) return undefined;
  try {
    return finalizeDriveWorktree(managed);
  } catch (error) {
    return {
      action: "kept",
      note:
        `Worktree cleanup failed; inspect ${managed.session.worktreePath} and branch ` +
        `${managed.session.worktreeBranch} manually: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

function summarizePrompt(prompt: string, max = 120): string {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, Math.max(0, max - 3))}...`;
}

function isDriveAgentJob(job: BackgroundJobEntry): boolean {
  return job.kind === "drive-agent" || job.description.startsWith("DriveAgent(");
}

function changedFilesSummary(job: BackgroundJobEntry): string {
  const files = job.changedFiles ?? [];
  if (files.length === 0) return "unknown";
  if (files.length <= 4) return files.join(",");
  return `${files.slice(0, 4).join(",")} (+${files.length - 4} more)`;
}

/**
 * Canonicalize external transcript paths against the DriveAgent cwd. Claude
 * normally records absolute paths while Codex apply_patch normally records
 * relative paths; returning a cwd-relative display path for in-workspace files
 * gives the renderer one stable identity and removes duplicate transcript hits.
 */
function normalizeChangedFiles(cwd: string, files: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of files) {
    if (typeof file !== "string" || !file.trim()) continue;
    const absolute = resolve(cwd, file.trim());
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    const rel = relative(cwd, absolute);
    out.push(rel && rel !== ".." && !rel.startsWith(`..${sep}`) ? rel : absolute);
  }
  return out;
}

function jobDurationSeconds(job: BackgroundJobEntry): string {
  const end = job.finishedAt ?? Date.now();
  return `${Math.max(0, (end - job.startedAt) / 1000).toFixed(1)}s`;
}

function formatDriveJobListLine(job: BackgroundJobEntry): string {
  const prompt = job.promptSummary || job.description || "(no prompt summary)";
  const launchCwd = job.launchCwd ?? job.cwd ?? "(unknown cwd)";
  const cli = job.cli ?? "unknown";
  return [
    `${job.jobId}`,
    `status=${job.status}`,
    `cli=${cli}`,
    `session=${job.sessionId}`,
    `launchCwd=${launchCwd}`,
    ...(job.worktreePath ? [`worktree=${job.worktreePath}`] : []),
    ...(job.worktreeBranch ? [`branch=${job.worktreeBranch}`] : []),
    ...(job.worktreeLifecycle ? [`lifecycle=${job.worktreeLifecycle}`] : []),
    `startedAt=${new Date(job.startedAt).toISOString()}`,
    `duration=${jobDurationSeconds(job)}`,
    `changedFiles=${changedFilesSummary(job)}`,
    `prompt="${prompt}"`,
  ].join("  ");
}

const DEFAULT_DRIVE_JOB_RESULT_CHARS = 800;
const DRIVE_JOB_RESULT_TRUNCATED_SUFFIX = "…(truncated, use inspect for full)";

function isTerminalDriveJob(job: BackgroundJobEntry): boolean {
  return job.status === "completed" || job.status === "failed" || job.status === "cancelled";
}

function driveJobResultChars(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DRIVE_JOB_RESULT_CHARS;
  return Math.floor(value);
}

function truncateDriveJobResult(finalText: string, maxChars: number): string {
  const characters = Array.from(finalText);
  if (characters.length <= maxChars) return finalText;
  return `${characters.slice(0, maxChars).join("")}${DRIVE_JOB_RESULT_TRUNCATED_SUFFIX}`;
}

function formatDriveJobListBlock(job: BackgroundJobEntry, resultChars: number): string {
  const lines = [formatDriveJobListLine(job)];
  if (isTerminalDriveJob(job) && resultChars > 0 && job.finalText) {
    const resultLines = truncateDriveJobResult(job.finalText, resultChars)
      .split("\n")
      .map((line) => `  ${line}`);
    lines.push("finalText:", ...resultLines);
  }
  return lines.join("\n");
}

function isValidSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.length > 0;
}

function argSignal(args: Record<string, unknown>): AbortSignal | undefined {
  const signal = args.__signal;
  return signal &&
    typeof signal === "object" &&
    typeof (signal as AbortSignal).aborted === "boolean" &&
    typeof (signal as AbortSignal).addEventListener === "function"
    ? (signal as AbortSignal)
    : undefined;
}

function startRun(runner: Runner, opts: Parameters<Runner>[0]): Promise<AgentRunResult> {
  return Promise.resolve().then(() => runner(opts));
}

function resolveAttachmentPaths(raw: unknown, cwd: string): { paths: string[]; error?: string } {
  if (raw === undefined) return { paths: [] };
  if (!Array.isArray(raw))
    return { paths: [], error: "attachmentPaths must be an array of strings" };
  const cwdReal = realpathSync(cwd);
  const paths: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      return { paths: [], error: "attachmentPaths must contain only non-empty strings" };
    }
    const candidate = isAbsolute(item) ? item : resolve(cwd, item);
    if (!existsSync(candidate)) return { paths: [], error: `attachment path not found: ${item}` };
    const real = realpathSync(candidate);
    const rel = relative(cwdReal, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) {
      return { paths: [], error: `attachment path is outside cwd: ${item}` };
    }
    const info = statSync(real);
    if (!info.isFile()) return { paths: [], error: `attachment path is not a file: ${item}` };
    paths.push(real);
  }
  return { paths };
}

const DRIVE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

function appendAttachmentPrompt(prompt: string, paths: string[]): string {
  if (paths.length === 0) return prompt;
  const lines = ["", "Attached files:"];
  for (const path of paths) {
    const kind = DRIVE_IMAGE_EXTS.has(extname(path).toLowerCase()) ? "image" : "file";
    lines.push(`- ${path} (${kind})`);
  }
  return `${prompt}\n${lines.join("\n")}`;
}

function recordSuccessfulSession(
  store: SessionStore,
  cli: DriveCli,
  cwd: string,
  result: AgentRunResult,
  metadata: {
    codeShellSessionId?: string;
    workspaceRoot: string;
    isolation: DriveIsolation;
    worktree?: ManagedDriveWorktree;
    lifecycle?: WorktreeLifecycleResult;
  },
  includeErroredSession = false,
): void {
  if ((!includeErroredSession && result.isError) || !result.sessionId) return;
  // When the isolation worktree directory was removed during finalization the
  // recorded cwd (the worktree path) no longer exists, so a later resume would
  // be rejected even though the external CLI session — keyed by sessionId, not
  // cwd — is still resumable. Rebind such runs to the workspace root, which
  // still exists, and drop the dead worktree path. `keep` runs keep the
  // worktree; `detach` keeps the branch for recreation but its directory is
  // gone, so bind cwd to the workspace root while retaining the branch.
  const dirRemoved = metadata.lifecycle?.action === "discarded" || metadata.lifecycle?.action === "detached";
  const branchPreserved = metadata.lifecycle?.action === "detached";
  const boundCwd = dirRemoved ? metadata.workspaceRoot : cwd;
  const boundIsolation: DriveIsolation =
    dirRemoved && metadata.isolation === "worktree" ? "current" : metadata.isolation;
  const worktreeBinding =
    metadata.worktree && !dirRemoved
      ? {
          worktreePath: metadata.worktree.session.worktreePath,
          worktreeBranch: metadata.worktree.session.worktreeBranch,
          worktreeBaseRef: metadata.worktree.session.baseRef,
        }
      : metadata.worktree && branchPreserved
        ? { worktreeBranch: metadata.worktree.session.worktreeBranch }
        : {};
  try {
    store.record({
      cli,
      sessionId: result.sessionId,
      ...(metadata.codeShellSessionId ? { codeShellSessionId: metadata.codeShellSessionId } : {}),
      cwd: boundCwd,
      workspaceRoot: metadata.workspaceRoot,
      isolation: boundIsolation,
      ...worktreeBinding,
    });
  } catch (err) {
    logger.warn("drive_agent.session_binding_record_failed", {
      cat: "cc",
      cli,
      sessionId: result.sessionId,
      cwd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function duplicateCwdWarning(effectiveWorkspaceCwd: string, writable: boolean): string | undefined {
  if (!writable) return undefined;
  const running = backgroundJobRegistry
    .listRunningByCwd(effectiveWorkspaceCwd)
    .filter(isDriveAgentJob);
  if (running.length === 0) return undefined;
  const jobs = running.map(formatDriveJobListLine).join("; ");
  const workspaceRoot =
    running[0]?.effectiveWorkspaceRoot ?? normalizeCwdPath(effectiveWorkspaceCwd);
  return (
    `Warning: another DriveAgent job is already running in effective workspace ${workspaceRoot}. ` +
    "Concurrent writable agents in the same workspace can overwrite each other's work. " +
    `Run DriveAgentJobs(action:"list", cwd:"${effectiveWorkspaceCwd}") before dispatching parallel work for details/cancellation. ` +
    `Running: ${jobs}`
  );
}

function attachDriveCompletion(params: {
  jobId: string;
  sessionId: string;
  label: string;
  cli: DriveCli;
  cwd: string;
  workspaceRoot: string;
  isolation: DriveIsolation;
  worktree?: ManagedDriveWorktree;
  run: Promise<AgentRunResult>;
  sessionStore: SessionStore;
  readChangedFiles: typeof readExternalChangedFiles;
  recordExternalFileChanges?: ToolContext["recordExternalFileChanges"];
  originClientMessageId?: string;
}): void {
  const {
    jobId,
    sessionId,
    label,
    cli,
    cwd,
    workspaceRoot,
    isolation,
    worktree,
    run,
    sessionStore,
    readChangedFiles,
    recordExternalFileChanges,
    originClientMessageId,
  } = params;
  void run
    .then((r) => {
      const jobStatus = backgroundJobRegistry.get(jobId)?.status;
      if (jobStatus !== "running" && jobStatus !== "cancelling") {
        safeFinalizeDriveWorktree(worktree);
        return;
      }
      const cancelling = jobStatus === "cancelling";
      // Attribute external changes BEFORE publishing completion. Previously the
      // notification event was emitted first and carried no files; changedFiles
      // only reached the background-work registry/panel, so the chat turn card
      // could never count DriveAgent edits.
      const rawChangedFiles = r.sessionId ? readChangedFiles(cli, cwd, r.sessionId) : [];
      const changedFiles = normalizeChangedFiles(cwd, rawChangedFiles);
      const lifecycle = safeFinalizeDriveWorktree(worktree);
      const finalText = appendLifecycleNote(r.finalText, lifecycle);
      if (lifecycle) {
        backgroundJobRegistry.recordWorktreeLifecycle(jobId, lifecycle.action);
      }
      recordSuccessfulSession(
        sessionStore,
        cli,
        cwd,
        r,
        { codeShellSessionId: sessionId, workspaceRoot, isolation, worktree, lifecycle },
        cancelling,
      );
      if (changedFiles.length > 0) {
        recordExternalFileChanges?.({
          jobId,
          description: label,
          cli,
          cwd,
          status: cancelling ? "cancelled" : r.isError ? "failed" : "completed",
          changedFiles,
          ...(originClientMessageId ? { originClientMessageId } : {}),
        });
      }
      logger.debug("changed_files.drive_completion", {
        cat: "changed_files",
        jobId,
        sessionId,
        externalSessionId: r.sessionId || undefined,
        cli,
        cwd,
        originClientMessageId,
        rawSize: rawChangedFiles.length,
        size: changedFiles.length,
        files: changedFiles,
      });
      if (cancelling) {
        backgroundJobRegistry.recordArtifacts(jobId, {
          ccSessionId: r.sessionId || undefined,
          changedFiles,
        });
        return;
      }
      // Deliver the result back so the woken agent actually sees the answer
      // (not just "a job finished"). Mirrors the video/sub-agent completion
      // path — enqueue lands in the same notificationQueue the wakeup drains.
      notificationQueue.enqueue(
        r.isError
          ? {
              agentId: jobId,
              description: label,
              status: "failed",
              workKind: "cc",
              error: finalText || "(no output)",
              ccSessionId: r.sessionId || undefined,
              ...(changedFiles.length ? { changedFiles, cwd } : {}),
              ...(originClientMessageId ? { originClientMessageId } : {}),
              enqueuedAt: Date.now(),
            }
          : {
              agentId: jobId,
              description: label,
              status: "completed",
              workKind: "cc",
              finalText,
              ccSessionId: r.sessionId || undefined,
              ...(changedFiles.length ? { changedFiles, cwd } : {}),
              ...(originClientMessageId ? { originClientMessageId } : {}),
              enqueuedAt: Date.now(),
            },
        sessionId,
      );
      // Retain the job in the panel with its result + the external CLI
      // session id + changed files.
      backgroundJobRegistry.finish(jobId, {
        status: r.isError ? "failed" : "completed",
        finalText: finalText || undefined,
        ccSessionId: r.sessionId || undefined,
        ...(changedFiles.length ? { changedFiles } : {}),
        ...(lifecycle ? { worktreeLifecycle: lifecycle.action } : {}),
      });
    })
    .catch((err) => {
      if (backgroundJobRegistry.get(jobId)?.status !== "running") {
        safeFinalizeDriveWorktree(worktree);
        return;
      }
      const lifecycle = safeFinalizeDriveWorktree(worktree);
      const msg = appendLifecycleNote((err as Error)?.message ?? String(err), lifecycle);
      if (lifecycle) {
        backgroundJobRegistry.recordWorktreeLifecycle(jobId, lifecycle.action);
      }
      notificationQueue.enqueue(
        {
          agentId: jobId,
          description: label,
          status: "failed",
          workKind: "cc",
          error: msg,
          enqueuedAt: Date.now(),
        },
        sessionId,
      );
      backgroundJobRegistry.finish(jobId, {
        status: "failed",
        finalText: msg,
        ...(lifecycle ? { worktreeLifecycle: lifecycle.action } : {}),
      });
    });
}

function trackBackgroundRun(params: {
  sessionId: string;
  label: string;
  cli: DriveCli;
  cwd: string;
  effectiveWorkspaceCwd: string;
  workspaceRoot: string;
  isolation: DriveIsolation;
  worktree?: ManagedDriveWorktree;
  promptSummary: string;
  start: () => Promise<AgentRunResult>;
  abort: () => void;
  sessionStore: SessionStore;
  writable: boolean;
  readChangedFiles: typeof readExternalChangedFiles;
  recordExternalFileChanges?: ToolContext["recordExternalFileChanges"];
  originClientMessageId?: string;
}): { jobId: string; warning?: string } {
  const warning = duplicateCwdWarning(params.effectiveWorkspaceCwd, params.writable);
  const jobId = newDriveJobId();
  const run = params.start();
  backgroundJobRegistry.start(jobId, params.sessionId, params.label, {
    kind: "drive-agent",
    launchCwd: params.cwd,
    effectiveWorkspaceCwd: params.effectiveWorkspaceCwd,
    workspaceRoot: params.workspaceRoot,
    isolation: params.isolation,
    ...(params.worktree
      ? {
          worktreePath: params.worktree.session.worktreePath,
          worktreeBranch: params.worktree.session.worktreeBranch,
          worktreeBaseRef: params.worktree.session.baseRef,
          worktreeCleanup: params.worktree.cleanup,
          worktreeBranchPrefix: params.worktree.branchPrefix,
        }
      : {}),
    cli: params.cli,
    promptSummary: params.promptSummary,
    originClientMessageId: params.originClientMessageId,
    abort: async () => {
      params.abort();
      await run.catch(() => undefined);
    },
  });
  attachDriveCompletion({ ...params, jobId, run });
  return { jobId, ...(warning ? { warning } : {}) };
}

async function waitForForegroundOrHandoff(
  run: Promise<AgentRunResult>,
  handoffMs: number,
): Promise<{ kind: "completed"; result: AgentRunResult } | { kind: "handoff" }> {
  if (handoffMs < 0) {
    return { kind: "completed", result: await run };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run.then((result) => ({ kind: "completed" as const, result })),
      new Promise<{ kind: "handoff" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "handoff" }), handoffMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function makeAbortController(parent?: AbortSignal, linkParent = false): AbortController {
  const controller = new AbortController();
  if (!parent) return controller;
  if (parent.aborted) {
    controller.abort(parent.reason);
  } else if (linkParent) {
    parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  }
  return controller;
}

/** Factory so tests can inject a fake runner. `fixedCli` (back-compat) forces a
 *  cli and hides the `cli` arg — that's how DriveClaudeCode stays a thin alias. */
export function makeDriveAgentTool(
  runner: Runner = defaultRunner,
  fixedCli?: DriveCli,
  options: DriveAgentToolOptions = {},
) {
  return async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    if (!prompt) return "Error: prompt is required";
    const cli: DriveCli =
      fixedCli ??
      (args.cli === "codex"
        ? "codex"
        : args.cli === "claude" || args.cli === undefined
          ? "claude"
          : ("invalid" as DriveCli));
    if (cli === ("invalid" as DriveCli))
      return `Error: unknown cli "${String(args.cli)}" (expected "claude" or "codex")`;
    const resumeSessionId =
      typeof args.resumeSessionId === "string" ? args.resumeSessionId : undefined;
    const model = typeof args.model === "string" && args.model.trim() ? args.model : undefined;
    const permissionMode: PermMode =
      args.permissionMode === "default" ||
      args.permissionMode === "acceptEdits" ||
      args.permissionMode === "bypassPermissions"
        ? args.permissionMode
        : "bypassPermissions";
    const isWritableRun = permissionMode !== "default";
    const background = args.background !== false;
    const cliName = cli === "codex" ? "Codex" : "Claude Code";
    if (background && !isValidSessionId(ctx?.sessionId)) {
      return `Error: cannot start a background ${cliName} job without a session — its result notification would be dropped. Retry with background:false, or ensure the tool runs inside a session.`;
    }
    const callerSignal = ctx?.signal ?? argSignal(args);
    const rawRequestedCwd =
      typeof args.cwd === "string" && args.cwd.trim()
        ? args.cwd
        : typeof ctx?.cwd === "string" && ctx.cwd
          ? ctx.cwd
          : process.cwd();
    const requestedCwd = normalizeCwdPath(rawRequestedCwd);
    const requestedWorkspaceRoot = await resolveDriveWorkspaceRoot(requestedCwd);
    const requestedIsolation = driveIsolationArg(args.isolation);
    const hasParallelWriter =
      !resumeSessionId &&
      isWritableRun &&
      hasRunningDriveWriter(requestedCwd, requestedWorkspaceRoot);
    let isolation: DriveIsolation = requestedIsolation ?? (hasParallelWriter ? "worktree" : "none");
    let cwd =
      isolation === "current" && typeof ctx?.cwd === "string" && ctx.cwd
        ? normalizeCwdPath(ctx.cwd)
        : requestedCwd;
    let workspaceRoot =
      cwd === requestedCwd ? requestedWorkspaceRoot : await resolveDriveWorkspaceRoot(cwd);
    let managedWorktree: ManagedDriveWorktree | undefined;
    const includeArg = driveIncludeArg(args.include);
    if (includeArg.error) return `Error: ${includeArg.error}`;
    const cleanup: DriveWorktreeCleanup =
      args.cleanup === "auto" ||
      args.cleanup === "keep" ||
      args.cleanup === "detach" ||
      args.cleanup === "discard"
        ? args.cleanup
        : resumeSessionId
          ? "keep"
          : driveCleanupArg(undefined);
    const sessionStore = options.sessionStore ?? externalAgentSessionStore;
    let resumeNote = "";
    if (resumeSessionId) {
      const binding = sessionStore.get(cli, resumeSessionId);
      if (binding) {
        const storedCwd = normalizeCwdPath(binding.cwd);
        if (!isExistingDirectory(storedCwd)) {
          const branchStillExists =
            !!binding.worktreeBranch &&
            !!binding.workspaceRoot &&
            isExistingDirectory(binding.workspaceRoot) &&
            (await branchExists(binding.workspaceRoot, binding.worktreeBranch, callerSignal));
          return branchStillExists
            ? `Error: cannot resume ${cli} session ${resumeSessionId}: stored cwd no longer exists or is not a directory: ${storedCwd}. Branch ${binding.worktreeBranch} is preserved; recreate the worktree from ${binding.workspaceRoot} before resuming.`
            : `Error: cannot resume ${cli} session ${resumeSessionId}: stored cwd no longer exists or is not a directory: ${storedCwd}. The bound workspace was deleted${binding.worktreeBranch ? ` and branch ${binding.worktreeBranch} is gone` : ""}; start a new external session.`;
        }
        isolation = binding.isolation ?? (binding.worktreePath ? "worktree" : "current");
        workspaceRoot = binding.workspaceRoot ?? storedCwd;
        if (storedCwd !== requestedCwd) {
          cwd = storedCwd;
          resumeNote = `Note: resume session ${resumeSessionId} is bound to stored cwd ${storedCwd}; ignoring requested cwd ${requestedCwd}.`;
          logger.info("drive_agent.resume_forced_stored_cwd", {
            cat: "cc",
            cli,
            sessionId: resumeSessionId,
            requestedCwd,
            storedCwd,
          });
        } else {
          cwd = storedCwd;
        }
        if (binding.worktreePath && binding.worktreeBranch) {
          const session: WorktreeSession = {
            originalCwd: workspaceRoot,
            worktreePath: normalizeCwdPath(binding.worktreePath),
            worktreeName: "drive-resume",
            worktreeBranch: binding.worktreeBranch,
            baseRef: binding.worktreeBaseRef,
            sessionId: resumeSessionId,
            createdAt: binding.createdAt,
          };
          try {
            lockWorktree(session.worktreePath, `CodeShell DriveAgent ${cli} resume`);
          } catch (error) {
            return `Error: cannot lock bound worktree ${session.worktreePath} for resume: ${error instanceof Error ? error.message : String(error)}`;
          }
          managedWorktree = { session, cleanup };
        }
      } else if (requestedIsolation === "worktree") {
        return `Error: cannot create a new worktree while resuming unbound ${cli} session ${resumeSessionId}; resume requires its original workspace binding.`;
      }
    }

    if (!resumeSessionId && isolation === "worktree") {
      try {
        managedWorktree = await prepareDriveWorktree({
          cwd,
          cli,
          baseRef:
            typeof args.baseRef === "string" && args.baseRef.trim() ? args.baseRef : undefined,
          include: includeArg.patterns,
          cleanup,
          ctx,
          signal: callerSignal,
        });
        cwd = managedWorktree.session.worktreePath;
        workspaceRoot = managedWorktree.session.originalCwd;
      } catch (error) {
        if (requestedIsolation === "worktree") {
          return `Error: failed to create DriveAgent isolation worktree: ${error instanceof Error ? error.message : String(error)}`;
        }
        isolation = "none";
        cwd = requestedCwd;
        workspaceRoot = requestedWorkspaceRoot;
        resumeNote =
          `Note: parallel worktree isolation was unavailable; continuing in ${requestedCwd}. ` +
          `${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const effectiveWorkspaceCwd = managedWorktree
      ? managedWorktree.session.worktreePath
      : typeof args.effectiveWorkspaceCwd === "string" && args.effectiveWorkspaceCwd.trim()
        ? normalizeCwdPath(args.effectiveWorkspaceCwd)
        : cwd;
    // Default to bypassPermissions: this tool is a fire-one-turn delegation to
    // an external CLI with nobody watching for approvals, and there is no
    // interactive approval loop here — so under "default" a tool that needs
    // approval (WebSearch/WebFetch/Write) silently can't run (the
    // "DriveClaudeCode 没有联网能力" report). A caller that wants gating passes
    // an explicit mode, which is honored. (For codex, the mode maps to a sandbox
    // tier inside codexAdapter.)
    const attachmentSourceCwd = managedWorktree?.session.originalCwd ?? cwd;
    const resolvedAttachmentPaths = resolveAttachmentPaths(
      args.attachmentPaths,
      attachmentSourceCwd,
    );
    if (resolvedAttachmentPaths.error) {
      safeFinalizeDriveWorktree(managedWorktree);
      return `Error: ${resolvedAttachmentPaths.error}`;
    }
    const attachmentPaths = resolvedAttachmentPaths.paths;
    const promptWithAttachments = appendAttachmentPrompt(prompt, attachmentPaths);
    const imagePaths =
      cli === "codex"
        ? attachmentPaths.filter((path) => DRIVE_IMAGE_EXTS.has(extname(path).toLowerCase()))
        : [];
    const label = `DriveAgent(${cli}): ${prompt.slice(0, 40)}`;
    const promptSummary = summarizePrompt(prompt);
    const runOptsBase = {
      cli,
      prompt: promptWithAttachments,
      resumeSessionId,
      model,
      cwd,
      permissionMode,
      imagePaths,
    };
    const foregroundHandoffMs = options.foregroundHandoffMs ?? DRIVE_AGENT_FOREGROUND_HANDOFF_MS;
    if (background) {
      // Fail loud on a missing sessionId: a background job whose completion
      // notification can't be routed (enqueue drops invalid/empty sessionId)
      // would run to completion and then silently vanish — nobody gets woken
      // with the result. Refuse up front instead of launching disappearing work.
      const sessionId = ctx!.sessionId!;
      const abortController = makeAbortController(callerSignal, false);
      const tracked = trackBackgroundRun({
        sessionId,
        label,
        cli,
        cwd,
        effectiveWorkspaceCwd,
        workspaceRoot,
        isolation,
        worktree: managedWorktree,
        promptSummary,
        start: () => startRun(runner, { ...runOptsBase, signal: abortController.signal }),
        abort: () => abortController.abort(),
        sessionStore,
        writable: isWritableRun,
        readChangedFiles: options.readChangedFiles ?? readExternalChangedFiles,
        recordExternalFileChanges: ctx?.recordExternalFileChanges,
        originClientMessageId: ctx?.originClientMessageId,
      });
      return [
        resumeNote,
        `已在后台启动 ${cliName}（jobId ${tracked.jobId}）。完成后会通知你结果，无需轮询。`,
        worktreeStartNote(managedWorktree),
        tracked.warning,
      ]
        .filter(Boolean)
        .join("\n");
    }
    const foregroundAbort = makeAbortController(callerSignal, true);
    const run = startRun(runner, { ...runOptsBase, signal: foregroundAbort.signal });
    let result: Awaited<ReturnType<typeof waitForForegroundOrHandoff>>;
    try {
      result = await waitForForegroundOrHandoff(run, foregroundHandoffMs);
    } catch (error) {
      const lifecycle = safeFinalizeDriveWorktree(managedWorktree);
      return appendLifecycleNote(
        `${cliName} 运行出错：${error instanceof Error ? error.message : String(error)}`,
        lifecycle,
      );
    }
    if (result.kind === "handoff" && isValidSessionId(ctx?.sessionId)) {
      const tracked = trackBackgroundRun({
        sessionId: ctx.sessionId,
        label,
        cli,
        cwd,
        effectiveWorkspaceCwd,
        workspaceRoot,
        isolation,
        worktree: managedWorktree,
        promptSummary,
        start: () => run,
        abort: () => foregroundAbort.abort(),
        sessionStore,
        writable: isWritableRun,
        readChangedFiles: options.readChangedFiles ?? readExternalChangedFiles,
        recordExternalFileChanges: ctx?.recordExternalFileChanges,
        originClientMessageId: ctx?.originClientMessageId,
      });
      return [
        resumeNote,
        `${cliName} foreground run exceeded ${foregroundHandoffMs}ms; moved it to background (jobId ${tracked.jobId}). Completion will notify this session, so do not poll.`,
        worktreeStartNote(managedWorktree),
        tracked.warning,
      ]
        .filter(Boolean)
        .join("\n");
    }
    const r = result.kind === "completed" ? result.result : await run;
    const lifecycle = safeFinalizeDriveWorktree(managedWorktree);
    recordSuccessfulSession(sessionStore, cli, cwd, r, {
      codeShellSessionId: ctx?.sessionId,
      workspaceRoot,
      isolation,
      worktree: managedWorktree,
      lifecycle,
    });
    const prefix = resumeNote ? `${resumeNote}\n` : "";
    const finalText = appendLifecycleNote(r.finalText, lifecycle);
    if (r.isError) return `${prefix}${cliName} 运行出错（session ${r.sessionId}）：\n${finalText}`;
    return `${prefix}${cliName} 完成（session ${r.sessionId}）：\n${finalText}`;
  };
}

export const driveAgentTool = makeDriveAgentTool();

export const driveAgentJobsToolDef: ToolDefinition = {
  name: "DriveAgentJobs",
  description:
    "List, inspect, cancel, or clean up background DriveAgent jobs. action:'list' without cwd defaults to " +
    "the current CodeShell session, not by cwd; all:true expands that to every session. status " +
    "defaults to running, so use " +
    "status:'all' to include completed, failed, and cancelled retained jobs. Before launching " +
    "writable DriveAgent work, pass cwd as a cross-session conflict filter; cwd is not a grouping " +
    "or ownership dimension. Results include prompt summary, owner session, launchCwd, CLI kind, " +
    "status, start time, and known changed files. With status:'all', list groups active jobs before " +
    "terminal jobs and includes each terminal job's " +
    "available/non-empty finalText result summary, so you usually do not need to inspect every " +
    "completed job. Use " +
    "resultChars to control each result summary (default 800; 0 or less hides results). " +
    "Use action:'inspect' with jobId for full details, action:'cancel' to abort a running process, " +
    "or action:'cleanup' with cleanup:'detach'/'discard' for a retained isolated worktree.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "inspect", "cancel", "cleanup"],
        description: "What to do. Defaults to list.",
      },
      jobId: {
        type: "string",
        description: "DriveAgent jobId for inspect or cancel.",
      },
      cwd: {
        type: "string",
        description:
          "When listing, use the effective workspace containing this cwd as a cross-session filter for conflict inspection. A job's launch cwd is output metadata, not a grouping or ownership key; omit cwd to list the current CodeShell session.",
      },
      status: {
        type: "string",
        enum: ["running", "all"],
        description: "When listing: running (default) or all retained DriveAgent jobs.",
      },
      all: {
        type: "boolean",
        description:
          "When listing without cwd: true lists DriveAgent jobs from every session; default lists only this session when session context exists.",
      },
      resultChars: {
        type: "number",
        default: DEFAULT_DRIVE_JOB_RESULT_CHARS,
        description:
          "When listing, maximum characters of finalText shown for each terminal job. Defaults to 800; 0 or a negative number hides results and returns summary-only job entries. Use inspect for the full result.",
      },
      cleanup: {
        type: "string",
        enum: ["keep", "detach", "discard"],
        description:
          "With action cleanup: keep unlocks/preserves; detach removes the directory only when there are no uncommitted changes; discard removes directory and managed branch.",
      },
    },
  },
};

function jobIdArg(args: Record<string, unknown>): string | undefined {
  const camel = typeof args.jobId === "string" ? args.jobId.trim() : "";
  if (camel) return camel;
  const snake = typeof args.job_id === "string" ? args.job_id.trim() : "";
  return snake || undefined;
}

function listDriveAgentJobs(args: Record<string, unknown>, ctx?: ToolContext): string {
  const rawCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd : undefined;
  const cwd = rawCwd ? normalizeCwdPath(rawCwd) : undefined;
  const sessionId = ctx?.sessionId;
  const listAllSessions = args.all === true || !!cwd || !sessionId;
  const status = args.status === "all" ? "all" : "running";
  let jobs = cwd
    ? backgroundJobRegistry.listByWorkspaceCwd(cwd)
    : listAllSessions || !sessionId
      ? backgroundJobRegistry.list()
      : backgroundJobRegistry.listForSession(sessionId);
  jobs = jobs.filter(isDriveAgentJob);
  if (status === "running") {
    jobs = jobs.filter((job) => job.status === "running" || job.status === "cancelling");
  }

  if (jobs.length === 0) {
    if (cwd) return `No ${status} DriveAgent jobs in the effective workspace containing ${cwd}.`;
    if (listAllSessions) return `No ${status} DriveAgent jobs in this process.`;
    return `No ${status} DriveAgent jobs in this session.`;
  }
  const resultChars = driveJobResultChars(args.resultChars);
  if (resultChars <= 0) return jobs.map(formatDriveJobListLine).join("\n");
  const activeJobs = jobs.filter((job) => !isTerminalDriveJob(job));
  const terminalJobs = jobs.filter(isTerminalDriveJob);
  const activeOutput = activeJobs.map(formatDriveJobListLine).join("\n");
  const terminalOutput = terminalJobs
    .map((job) => formatDriveJobListBlock(job, resultChars))
    .join("\n\n");
  if (activeOutput && terminalOutput) {
    return [
      `Active DriveAgent jobs:\n${activeOutput}`,
      `Terminal DriveAgent jobs:\n${terminalOutput}`,
    ].join("\n\n");
  }
  return activeOutput || terminalOutput;
}

function inspectDriveAgentJob(jobId: string | undefined): string {
  if (!jobId) return "Error: jobId is required.";
  const job = backgroundJobRegistry.get(jobId);
  if (!job || !isDriveAgentJob(job)) return `Error: DriveAgent jobId "${jobId}" not found.`;
  const lines = [
    `jobId: ${job.jobId}`,
    `status: ${job.status}`,
    `cli: ${job.cli ?? "unknown"}`,
    `session: ${job.sessionId}`,
    `launchCwd: ${job.launchCwd ?? job.cwd ?? "(unknown cwd)"}`,
    `startedAt: ${new Date(job.startedAt).toISOString()}`,
    `duration: ${jobDurationSeconds(job)}`,
    `prompt: ${job.promptSummary || job.description || "(no prompt summary)"}`,
    `description: ${job.description}`,
  ];
  if (job.isolation) lines.push(`isolation: ${job.isolation}`);
  if (job.worktreePath) lines.push(`worktreePath: ${job.worktreePath}`);
  if (job.worktreeBranch) lines.push(`worktreeBranch: ${job.worktreeBranch}`);
  if (job.worktreeBaseRef) lines.push(`worktreeBaseRef: ${job.worktreeBaseRef}`);
  if (job.worktreeCleanup) lines.push(`worktreeCleanup: ${job.worktreeCleanup}`);
  if (job.worktreeLifecycle) lines.push(`worktreeLifecycle: ${job.worktreeLifecycle}`);
  if (job.finishedAt !== undefined)
    lines.push(`finishedAt: ${new Date(job.finishedAt).toISOString()}`);
  if (job.ccSessionId) lines.push(`ccSessionId: ${job.ccSessionId}`);
  if (job.changedFiles && job.changedFiles.length > 0) {
    lines.push("changedFiles:", ...job.changedFiles.map((file) => `- ${file}`));
  } else {
    lines.push("changedFiles: unknown");
  }
  if (job.finalText) lines.push("finalText:", job.finalText);
  return lines.join("\n");
}

async function cancelDriveAgentJob(jobId: string | undefined): Promise<string> {
  if (!jobId) return "Error: jobId is required.";
  const job = backgroundJobRegistry.get(jobId);
  if (!job || !isDriveAgentJob(job)) return `Error: DriveAgent jobId "${jobId}" not found.`;
  if (job.status !== "running") {
    return `DriveAgent job ${jobId} is already ${job.status}; nothing to cancel.`;
  }
  if (!job.abort) {
    return `Error: DriveAgent job ${jobId} has no cancellation handle recorded.`;
  }

  const finalText = `DriveAgent job ${jobId} cancelled by DriveAgentJobs.`;
  const ok = await backgroundJobRegistry.cancel(jobId, { finalText });
  if (!ok) return `Failed to cancel DriveAgent job ${jobId}.`;
  notificationQueue.enqueue(
    {
      agentId: jobId,
      description: job.description,
      status: "cancelled",
      workKind: "cc",
      error: finalText,
      ccSessionId: job.ccSessionId,
      ...(job.changedFiles?.length
        ? { changedFiles: job.changedFiles, cwd: job.launchCwd ?? job.cwd }
        : {}),
      ...(job.originClientMessageId ? { originClientMessageId: job.originClientMessageId } : {}),
      enqueuedAt: Date.now(),
    },
    job.sessionId,
  );
  return `DriveAgent job ${jobId} cancelled.`;
}

function cleanupDriveAgentWorktree(jobId: string | undefined, requested: unknown): string {
  if (!jobId) return "Error: jobId is required.";
  const job = backgroundJobRegistry.get(jobId);
  if (!job || !isDriveAgentJob(job)) return `Error: DriveAgent jobId "${jobId}" not found.`;
  if (job.status === "running" || job.status === "cancelling") {
    return `Error: DriveAgent job ${jobId} is still ${job.status}; cancel or wait before cleanup.`;
  }
  if (!job.worktreePath || !job.worktreeBranch) {
    return `Error: DriveAgent job ${jobId} has no managed worktree.`;
  }
  const action =
    requested === "keep" || requested === "detach" || requested === "discard"
      ? requested
      : undefined;
  if (!action) return "Error: cleanup must be keep, detach, or discard.";
  if (!existsSync(job.worktreePath)) {
    return `Worktree directory is already absent: ${job.worktreePath} (lifecycle ${job.worktreeLifecycle ?? "unknown"}).`;
  }
  const active = backgroundJobRegistry
    .listRunningByCwd(job.worktreePath)
    .filter((entry) => entry.jobId !== jobId && isDriveAgentJob(entry));
  if (active.length > 0) {
    return `Error: worktree ${job.worktreePath} is in use by running DriveAgent job(s): ${active.map((entry) => entry.jobId).join(", ")}.`;
  }
  try {
    if (action === "keep") {
      unlockWorktree(job.worktreePath);
      const note = `Worktree kept at ${job.worktreePath}; branch ${job.worktreeBranch} preserved.`;
      backgroundJobRegistry.recordWorktreeLifecycle(jobId, "kept", note);
      return note;
    }
    const state = inspectWorktreeChanges(job.worktreePath, job.worktreeBaseRef);
    if (action === "detach" && state.uncommitted) {
      return `Error: detach refused because ${job.worktreePath} has uncommitted changes. Use keep or explicit discard.`;
    }
    unlockWorktree(job.worktreePath);
    const removal = removeWorktree(job.worktreePath, action === "discard", {
      prefix: job.worktreeBranchPrefix,
    });
    if (action === "discard" && removal.branchDeleted === false) {
      const note =
        `Worktree directory removed; branch ${removal.branch ?? job.worktreeBranch} preserved because ` +
        `deletion failed: ${removal.branchError ?? "unknown error"}.`;
      backgroundJobRegistry.recordWorktreeLifecycle(jobId, "cleanup-failed", note);
      return `Warning: ${note}`;
    }
    const lifecycle = action === "discard" ? "discarded" : "detached";
    const note =
      action === "discard"
        ? `Worktree ${job.worktreePath} and branch ${job.worktreeBranch} deleted.`
        : `Worktree directory ${job.worktreePath} removed; branch ${job.worktreeBranch} preserved.`;
    backgroundJobRegistry.recordWorktreeLifecycle(jobId, lifecycle, note);
    return note;
  } catch (error) {
    const note = `Cleanup failed for ${job.worktreePath}: ${error instanceof Error ? error.message : String(error)}.`;
    backgroundJobRegistry.recordWorktreeLifecycle(jobId, "cleanup-failed", note);
    return `Error: ${note}`;
  }
}

export async function driveAgentJobsTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const action =
    args.action === "inspect" ||
    args.action === "cancel" ||
    args.action === "cleanup" ||
    args.action === "list"
      ? args.action
      : "list";
  if (action === "inspect") return inspectDriveAgentJob(jobIdArg(args));
  if (action === "cancel") return await cancelDriveAgentJob(jobIdArg(args));
  if (action === "cleanup") return cleanupDriveAgentWorktree(jobIdArg(args), args.cleanup);
  return listDriveAgentJobs(args, ctx);
}

// ── Back-compat: DriveClaudeCode = DriveAgent pinned to cli:"claude" ──────────
// Kept so old prompts / memories / call sites that reference DriveClaudeCode
// keep working. It's a thin alias over the same machinery (fixedCli "claude").
export const driveClaudeCodeToolDef: ToolDefinition = {
  ...driveAgentToolDef,
  name: "DriveClaudeCode",
  description:
    "(Alias of DriveAgent with cli:claude.) Delegate a task to the external Claude Code CLI " +
    "(drives `claude` for one turn). Prefer DriveAgent for new calls; this name is kept for " +
    "compatibility. " +
    driveAgentToolDef.description,
  inputSchema: {
    type: "object",
    properties: {
      // intentionally omit `cli` — this alias is always claude
      prompt: (driveAgentToolDef.inputSchema as any).properties.prompt,
      resumeSessionId: {
        type: "string",
        description: "Existing CC session id to resume (keeps context). Omit for a fresh session.",
      },
      model: (driveAgentToolDef.inputSchema as any).properties.model,
      cwd: (driveAgentToolDef.inputSchema as any).properties.cwd,
      isolation: (driveAgentToolDef.inputSchema as any).properties.isolation,
      baseRef: (driveAgentToolDef.inputSchema as any).properties.baseRef,
      include: (driveAgentToolDef.inputSchema as any).properties.include,
      cleanup: (driveAgentToolDef.inputSchema as any).properties.cleanup,
      effectiveWorkspaceCwd: (driveAgentToolDef.inputSchema as any).properties
        .effectiveWorkspaceCwd,
      attachmentPaths: (driveAgentToolDef.inputSchema as any).properties.attachmentPaths,
      permissionMode: (driveAgentToolDef.inputSchema as any).properties.permissionMode,
      background: (driveAgentToolDef.inputSchema as any).properties.background,
    },
    required: ["prompt"],
  },
};

/** Back-compat factory: a DriveAgent pinned to cli:"claude" with the `cli` arg
 *  hidden. The injected `runner` here keeps the old shape (no `cli` field); we
 *  adapt it to the generic Runner so existing tests' fakes still work. */
type LegacyRunner = (opts: {
  prompt: string;
  resumeSessionId?: string;
  model?: string;
  cwd: string;
  permissionMode?: PermMode;
  signal?: AbortSignal;
}) => Promise<AgentRunResult>;
export function makeDriveClaudeCodeTool(runner?: LegacyRunner, options?: DriveAgentToolOptions) {
  const generic: Runner | undefined = runner
    ? ({ prompt, resumeSessionId, model, cwd, permissionMode, signal }) =>
        runner({ prompt, resumeSessionId, model, cwd, permissionMode, signal })
    : undefined;
  return makeDriveAgentTool(generic ?? defaultRunner, "claude", options);
}

export const driveClaudeCodeTool = makeDriveClaudeCodeTool();
