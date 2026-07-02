import type { ToolDefinition } from "../../types.js";
import { runAgentOnce } from "../../cc-orchestrator/external-agent-driver.js";
import { claudeAdapter, codexAdapter } from "../../cc-orchestrator/agent-adapter.js";
import type { AgentRunResult } from "../../cc-orchestrator/external-agent-driver.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { readExternalChangedFiles } from "../../cc-orchestrator/external-agent-changes.js";
import { notificationQueue } from "./agent-notifications.js";
import type { ToolContext } from "../context.js";

export type DriveCli = "claude" | "codex";

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
    "with the result. For a quick task where you want the answer inline, pass background:false. " +
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
      prompt: { type: "string", description: "The task for the agent. Make it COMPLETE and self-contained: state the goal, a concrete definition of done, and (for open-ended work) an explicit scope bound so it finishes end-to-end and verifies its own work rather than sprawling or stopping half-way." },
      cli: { type: "string", enum: ["claude", "codex"], description: "Which external CLI to drive. 'claude' = Claude Code (default), 'codex' = OpenAI Codex. resumeSessionId is only valid against the same cli that produced it." },
      resumeSessionId: { type: "string", description: "Existing session id to resume (keeps context). Must come from a prior run of the SAME cli. Omit for a fresh session." },
      cwd: { type: "string", description: "Working directory the run operates in." },
      permissionMode: { type: "string", enum: ["default", "acceptEdits", "bypassPermissions"], description: "Permission/sandbox level. Defaults to 'bypassPermissions' (full auto — needed so the agent's tools run unattended; there is no interactive approval loop here). For codex: default→read-only sandbox, acceptEdits→workspace-write, bypassPermissions→no sandbox. Pass 'default'/'acceptEdits' to gate." },
      background: { type: "boolean", description: "Defaults to TRUE: run in the background and notify you on completion (right for long tasks). Pass false to run in the foreground and get the result inline (only for quick tasks)." },
    },
    required: ["prompt", "cwd"],
  },
};

type PermMode = "default" | "acceptEdits" | "bypassPermissions";
type Runner = (opts: { cli: DriveCli; prompt: string; resumeSessionId?: string; cwd: string; permissionMode?: PermMode }) => Promise<AgentRunResult>;

const defaultRunner: Runner = (opts) => {
  const { adapter, command } = CLI_ADAPTERS[opts.cli];
  return runAgentOnce(adapter, { command, prompt: opts.prompt, resumeSessionId: opts.resumeSessionId, cwd: opts.cwd, permissionMode: opts.permissionMode ?? "default" });
};

/** Factory so tests can inject a fake runner. `fixedCli` (back-compat) forces a
 *  cli and hides the `cli` arg — that's how DriveClaudeCode stays a thin alias. */
export function makeDriveAgentTool(runner: Runner = defaultRunner, fixedCli?: DriveCli) {
  return async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const cwd = typeof args.cwd === "string" ? args.cwd : process.cwd();
    if (!prompt) return "Error: prompt is required";
    const cli: DriveCli = fixedCli ?? (args.cli === "codex" ? "codex" : args.cli === "claude" || args.cli === undefined ? "claude" : ("invalid" as DriveCli));
    if (cli === ("invalid" as DriveCli)) return `Error: unknown cli "${String(args.cli)}" (expected "claude" or "codex")`;
    const resumeSessionId = typeof args.resumeSessionId === "string" ? args.resumeSessionId : undefined;
    // Default to bypassPermissions: this tool is a fire-one-turn delegation to
    // an external CLI with nobody watching for approvals, and there is no
    // interactive approval loop here — so under "default" a tool that needs
    // approval (WebSearch/WebFetch/Write) silently can't run (the
    // "DriveClaudeCode 没有联网能力" report). A caller that wants gating passes
    // an explicit mode, which is honored. (For codex, the mode maps to a sandbox
    // tier inside codexAdapter.)
    const permissionMode: PermMode =
      args.permissionMode === "default" ||
      args.permissionMode === "acceptEdits" ||
      args.permissionMode === "bypassPermissions"
        ? args.permissionMode
        : "bypassPermissions";
    const cliName = cli === "codex" ? "Codex" : "Claude Code";
    const label = `DriveAgent(${cli}): ${prompt.slice(0, 40)}`;
    // Background by default (these tasks are typically long). Only an explicit
    // background:false runs in the foreground and returns the result inline.
    const background = args.background !== false;
    if (background) {
      // Fail loud on a missing sessionId: a background job whose completion
      // notification can't be routed (enqueue drops invalid/empty sessionId)
      // would run to completion and then silently vanish — nobody gets woken
      // with the result. Refuse up front instead of launching disappearing work.
      const sessionId = ctx?.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return `Error: cannot start a background ${cliName} job without a session — its result notification would be dropped. Retry with background:false, or ensure the tool runs inside a session.`;
      }
      const jobId = `cc-${process.hrtime.bigint().toString(36)}`;
      backgroundJobRegistry.start(jobId, sessionId, label);
      void runner({ cli, prompt, resumeSessionId, cwd, permissionMode })
        .then((r) => {
          // Deliver the result back so the woken agent actually sees the answer
          // (not just "a job finished"). Mirrors the video/sub-agent completion
          // path — enqueue lands in the same notificationQueue the wakeup drains.
          notificationQueue.enqueue(
            r.isError
              ? { agentId: jobId, description: label, status: "failed", workKind: "cc", error: r.finalText || "(no output)", ccSessionId: r.sessionId || undefined, enqueuedAt: Date.now() }
              : { agentId: jobId, description: label, status: "completed", workKind: "cc", finalText: r.finalText, ccSessionId: r.sessionId || undefined, enqueuedAt: Date.now() },
            sessionId,
          );
          // Attribute the files the external agent changed by parsing its own
          // transcript (#6) — those Edit/Write calls are invisible to the host's
          // in-session aggregator. Best-effort; [] on any failure.
          const changedFiles = r.sessionId
            ? readExternalChangedFiles(cli, cwd, r.sessionId)
            : [];
          // Retain the job in the panel with its result + the external CLI
          // session id + changed files.
          backgroundJobRegistry.finish(jobId, {
            status: r.isError ? "failed" : "completed",
            finalText: r.finalText || undefined,
            ccSessionId: r.sessionId || undefined,
            ...(changedFiles.length ? { changedFiles } : {}),
          });
        })
        .catch((err) => {
          const msg = (err as Error)?.message ?? String(err);
          notificationQueue.enqueue(
            { agentId: jobId, description: label, status: "failed", workKind: "cc", error: msg, enqueuedAt: Date.now() },
            sessionId,
          );
          backgroundJobRegistry.finish(jobId, { status: "failed", finalText: msg });
        });
      return `已在后台启动 ${cliName}（jobId ${jobId}）。完成后会通知你结果，无需轮询。`;
    }
    const r = await runner({ cli, prompt, resumeSessionId, cwd, permissionMode });
    if (r.isError) return `${cliName} 运行出错（session ${r.sessionId}）：\n${r.finalText}`;
    return `${cliName} 完成（session ${r.sessionId}）：\n${r.finalText}`;
  };
}

export const driveAgentTool = makeDriveAgentTool();

// ── Back-compat: DriveClaudeCode = DriveAgent pinned to cli:"claude" ──────────
// Kept so old prompts / memories / call sites that reference DriveClaudeCode
// keep working. It's a thin alias over the same machinery (fixedCli "claude").
export const driveClaudeCodeToolDef: ToolDefinition = {
  ...driveAgentToolDef,
  name: "DriveClaudeCode",
  description:
    "(Alias of DriveAgent with cli:claude.) Delegate a task to the external Claude Code CLI " +
    "(drives `claude` for one turn). Prefer DriveAgent for new calls; this name is kept for " +
    "compatibility. " + driveAgentToolDef.description,
  inputSchema: {
    type: "object",
    properties: {
      // intentionally omit `cli` — this alias is always claude
      prompt: (driveAgentToolDef.inputSchema as any).properties.prompt,
      resumeSessionId: { type: "string", description: "Existing CC session id to resume (keeps context). Omit for a fresh session." },
      cwd: (driveAgentToolDef.inputSchema as any).properties.cwd,
      permissionMode: (driveAgentToolDef.inputSchema as any).properties.permissionMode,
      background: (driveAgentToolDef.inputSchema as any).properties.background,
    },
    required: ["prompt", "cwd"],
  },
};

/** Back-compat factory: a DriveAgent pinned to cli:"claude" with the `cli` arg
 *  hidden. The injected `runner` here keeps the old shape (no `cli` field); we
 *  adapt it to the generic Runner so existing tests' fakes still work. */
type LegacyRunner = (opts: { prompt: string; resumeSessionId?: string; cwd: string; permissionMode?: PermMode }) => Promise<AgentRunResult>;
export function makeDriveClaudeCodeTool(runner?: LegacyRunner) {
  const generic: Runner | undefined = runner
    ? ({ prompt, resumeSessionId, cwd, permissionMode }) => runner({ prompt, resumeSessionId, cwd, permissionMode })
    : undefined;
  return makeDriveAgentTool(generic ?? defaultRunner, "claude");
}

export const driveClaudeCodeTool = makeDriveClaudeCodeTool();
