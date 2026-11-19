/**
 * A DriveAgent Codex worker that can ask.
 *
 * `codex exec` has no approval channel: outside full access a worker launched
 * with it is confined to its sandbox and whatever the sandbox refuses simply
 * does not happen. The app-server protocol does have one, so a worker that is
 * not in full access runs as a one-turn app-server thread instead, through the
 * same `CodexRuntime` the main Codex runtime uses:
 *
 *   default      → `read-only` sandbox
 *   acceptEdits  → `workspace-write` sandbox rooted at the worker's cwd
 *
 * both with `CODEX_WORKER_APPROVAL_POLICY`, under which Codex asks before it
 * leaves the sandbox and also when the sandbox stopped a command.
 *
 * Every approval request Codex sends (command, patch, extra permissions, a
 * user-configured MCP tool) is put to `approve`, which is the launching
 * Session's gate (`drive-agent-permissions.ts`). The run is reported in the
 * shape of a `codex exec --json` run so the rest of DriveAgent needs no second
 * result or progress model.
 *
 * What Codex refuses on its own, without asking, is counted apart from what the
 * gate denied (`sandboxBlocked`). Only a refusal the protocol states is
 * counted; see `codexUnaskedRefusal` for what that leaves out.
 *
 * What it leaves out is reported as two separate facts and no conclusion: how
 * many commands ended failed (`failedCommands`), and whether Codex said the
 * sandbox has no network access (`sandboxNetworkDisabled`).
 */
import type { BackgroundJobProgress } from "@cjhyy/code-shell-core/extension";
import { codexAdapter, type PermissionMode } from "../cc-orchestrator/agent-adapter.js";
import { pathWithCommonBins } from "../cc-orchestrator/cc-capability.js";
import {
  runWithLines,
  terminateAttachedProcessTree,
  traceExternalAgentRun,
  type AgentRunResult,
} from "../cc-orchestrator/external-agent-driver.js";
import {
  advanceAgentProgressWith,
  codexCommandFailed,
  initialAgentProgress,
  recordSandboxBlocked,
} from "../cc-orchestrator/external-agent-progress.js";
import type { AppServerClientOptions } from "../external-runtimes/codex/app-server-client.js";
import { codexNativeApprovalPresentation } from "../external-runtimes/codex/approval-presentation.js";
import { CodexRuntime } from "../external-runtimes/codex/runtime.js";

export type CodexWorkerApproval = (
  request: { toolName: string; input: Record<string, unknown> },
  signal?: AbortSignal,
) => Promise<{ approved: boolean }>;

export interface CodexWorkerRunOpts {
  prompt: string;
  cwd: string;
  /** Full access never comes here: it has nothing to ask and stays on `codex exec`. */
  permissionMode: Exclude<PermissionMode, "bypassPermissions">;
  approve: CodexWorkerApproval;
  resumeSessionId?: string;
  model?: string;
  imagePaths?: string[];
  onSessionId?: (sessionId: string) => void;
  onProgress?: (progress: BackgroundJobProgress) => void;
  onProcess?: (pid: number) => void;
  /** Executable and argv of the app-server; a test points this at a fake. */
  client?: Pick<AppServerClientOptions, "command" | "args">;
}

export function codexWorkerSandbox(mode: CodexWorkerRunOpts["permissionMode"]): string {
  return mode === "acceptEdits" ? "workspace-write" : "read-only";
}

/**
 * The approval policy of a worker thread: every approval flow open.
 *
 * Not `on-request`, although both ask for the same things up front. Measured
 * against codex-cli 0.162.0 with `touch blocked.txt` in a `read-only` sandbox,
 * every app-server message and the rollout captured:
 *
 *   - `on-request`: the command runs in the sandbox and fails there. NO item is
 *     sent for it (no `item/started`, no `item/completed`, no approval request,
 *     no error; the turn ends `completed`). The rollout holds only the tool
 *     script (`custom_tool_call` named `exec`) and its text output
 *     (`custom_tool_call_output`: the command's stderr and `exit_code: 1`).
 *     Nothing structured says a sandbox was involved.
 *   - this policy (`granular` with `sandbox_approval`): the same command is
 *     announced (`item/started`, `status: "inProgress"`), and after the sandbox
 *     stops it Codex sends `item/commandExecution/requestApproval` for that item
 *     to run it again outside the sandbox. Accepted, the item completes with
 *     `exitCode: 0`; declined, it ends `status: "declined"`.
 *
 * So the sandbox's refusal becomes an ask at the gate instead of silence. The
 * policy does not make ordinary work ask: reads, and commands that fail for
 * their own reasons (`grep` without a match, a missing file), run and end as
 * plain `completed` / `failed` items. `untrusted` was measured too and asks
 * before any command it does not know to be read-only, which is too much for
 * `acceptEdits`. 0.162 has no `on-failure`.
 *
 * Which failures count as the sandbox's is Codex's own judgement. One it does
 * not make: a network call stopped by the sandbox (`curl` → exit 6, "could not
 * resolve host") is an ordinary `failed` item under either policy.
 *
 * No setting of 0.162.0 turns that into an ask or a stated refusal. Measured
 * the same way with `curl https://example.com` in `workspace-write`:
 *
 *   - `[features] network_proxy` alone, or the built-in `:workspace` permission
 *     profile (thread/start `permissions`): no change, `status: "failed"`,
 *     `exitCode: 6`.
 *   - a profile with `[permissions.<name>.network] enabled = true` plus
 *     `network_proxy` routes the command through Codex's managed proxy, which
 *     refuses the host (`curl` → "CONNECT tunnel failed, response 403"). The
 *     item is still `status: "failed"`, now with `exitCode: -1`; the reason
 *     exists only as a sentence in `aggregatedOutput`. No approval request is
 *     sent and `networkApprovalContext` never appears, under this policy or
 *     `on-request`. Such a profile is also only usable from process-level
 *     config: defined through thread/start `config`, every turn ended
 *     "failed to load workspace requirements" before the model ran.
 *   - `untrusted` asks about the command up front, as it does for any command
 *     it does not know, with nothing about the network in the request.
 *
 * So the worker does not try to detect it. It counts commands that ended
 * failed and reports whether the thread's sandbox has network access (the
 * `sandbox.networkAccess` of the thread/start answer); see `drive-agent-permissions.ts`.
 */
export const CODEX_WORKER_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: true,
    rules: true,
    skill_approval: true,
    request_permissions: true,
    mcp_elicitations: true,
  },
} as const;

/** Names as `codex exec --json` spells them, which the progress model reads. */
const EXEC_ITEM_TYPES: Record<string, string> = {
  agentMessage: "agent_message",
  reasoning: "reasoning",
  commandExecution: "command_execution",
  fileChange: "file_change",
  mcpToolCall: "mcp_tool_call",
  webSearch: "web_search",
};

const APPROVAL_TOOL_NAMES: Record<string, string> = {
  "item/commandExecution/requestApproval": "shell",
  "item/fileChange/requestApproval": "apply_patch",
  "item/permissions/requestApproval": "permissions",
};

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * One app-server notification as the `codex exec --json` record of the same
 * event, or undefined when exec has no such record (deltas, status changes).
 * Only fields the result parser and the progress model read are carried over.
 */
export function codexExecRecord(method: string, params: unknown): Record<string, unknown> | void {
  if (method === "turn/started") return { type: "turn.started" };
  if (method !== "item/started" && method !== "item/completed") return;
  const item = objectOf(objectOf(params)?.item);
  const type = typeof item?.type === "string" ? EXEC_ITEM_TYPES[item.type] : undefined;
  // A refused command or patch did not run: it is activity, not "finished".
  if (!item || !type || item.status === "declined") return;
  return {
    type: method === "item/started" ? "item.started" : "item.completed",
    item: {
      type,
      ...(typeof item.text === "string" ? { text: item.text } : {}),
      ...(Number.isInteger(item.exitCode) ? { exit_code: item.exitCode } : {}),
      ...(typeof item.server === "string" ? { server: item.server } : {}),
      ...(typeof item.tool === "string" ? { tool: item.tool } : {}),
      ...(Array.isArray(item.changes) ? { changes: item.changes.flatMap(changedPaths) } : {}),
      // How a patch ended decides whether its files count as changed, and
      // how a command ended whether it counts as failed.
      ...((type === "file_change" || type === "command_execution") &&
      method === "item/completed" &&
      typeof item.status === "string"
        ? { status: item.status }
        : {}),
    },
  };
}

/** The path of one `FileUpdateChange`, and where it went if the change moved it. */
function changedPaths(change: unknown): Array<{ path: unknown }> {
  const moved = objectOf(objectOf(change)?.kind)?.move_path;
  return [
    { path: objectOf(change)?.path },
    ...(typeof moved === "string" && moved ? [{ path: moved }] : []),
  ];
}

/**
 * Whether this notification states that Codex refused an operation by itself,
 * with no approval request to answer (`asked` holds the item ids that were put
 * to the gate, whose refusals the gate already counts):
 *
 *   - a command or patch item that ends `declined` without having been asked
 *     about (Codex's own policy or reviewer turned it down);
 *   - a turn that ends with the `sandboxError` error code.
 *
 * A command that ran inside the sandbox and was stopped by it is not counted
 * here because it is no longer unasked: under `CODEX_WORKER_APPROVAL_POLICY`
 * Codex puts it to the gate. What stays uncounted is what codex-cli 0.162.0
 * does not classify itself, such as a network call the sandbox cut off: a
 * `failed` item with an exit code and no cause. Its only trace is the
 * command's own output text, which is not parsed.
 */
export function codexUnaskedRefusal(
  method: string,
  params: unknown,
  asked: ReadonlySet<string>,
): boolean {
  if (method === "turn/completed") {
    return objectOf(objectOf(objectOf(params)?.turn)?.error)?.codexErrorInfo === "sandboxError";
  }
  if (method !== "item/completed") return false;
  const item = objectOf(objectOf(params)?.item);
  return (
    (item?.type === "commandExecution" || item?.type === "fileChange") &&
    item.status === "declined" &&
    !(typeof item.id === "string" && asked.has(item.id))
  );
}

/** Run ONE turn of a Codex app-server thread to its end. Honors AbortSignal. */
export async function runCodexWorkerOnce(
  opts: CodexWorkerRunOpts,
  signal?: AbortSignal,
): Promise<AgentRunResult> {
  if (signal?.aborted) {
    const error = new Error("Agent run aborted");
    error.name = "AbortError";
    throw error;
  }
  const lines: string[] = [];
  let progress = initialAgentProgress("codex");
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let lastProgressReportAt = 0;
  const publishProgress = (): void => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = undefined;
    lastProgressReportAt = Date.now();
    try {
      opts.onProgress?.({
        ...progress,
        recentEvents: progress.recentEvents?.map((event) => ({ ...event })),
      });
    } catch {
      // Observation must never stop the worker.
    }
  };
  const observe = (record?: Record<string, unknown>): void => {
    if (record) lines.push(JSON.stringify(record));
    if (!opts.onProgress) return;
    progress = advanceAgentProgressWith(progress, "codex", record);
    const delay = 250 - (Date.now() - lastProgressReportAt);
    if (delay <= 0) publishProgress();
    else progressTimer ??= setTimeout(publishProgress, delay);
  };
  const safely = (report: () => void): void => {
    try {
      report();
    } catch {
      // Session and process observation are best-effort metadata.
    }
  };

  const sandbox = codexWorkerSandbox(opts.permissionMode);
  // Aborted when the run ends for any reason, so no ask outlives its worker.
  const ended = new AbortController();
  let failed = false;
  /** Items put to the gate; a refusal of one of these is the gate's to count. */
  const asked = new Set<string>();
  let sandboxBlocked = 0;
  let failedCommands = 0;
  const ask: CodexWorkerApproval = async (request) => {
    try {
      return await opts.approve(request, ended.signal);
    } catch {
      return { approved: false };
    }
  };
  const runtime = new CodexRuntime(
    {
      cwd: opts.cwd,
      businessSessionId: "drive-agent-codex-worker",
      sandbox,
      approvalPolicy: CODEX_WORKER_APPROVAL_POLICY,
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.resumeSessionId ? { resumeRuntimeSessionId: opts.resumeSessionId } : {}),
      client: {
        command: opts.client?.command ?? "codex",
        ...(opts.client?.args ? { args: opts.client.args } : {}),
        env: { ...process.env, PATH: pathWithCommonBins() },
      },
    },
    {
      onNotification: (method, params) => {
        if (codexUnaskedRefusal(method, params, asked)) {
          sandboxBlocked += 1;
          progress = recordSandboxBlocked(progress, sandboxBlocked);
        }
        const record = codexExecRecord(method, params);
        if (codexCommandFailed(record)) failedCommands += 1;
        // A failed turn is recorded from `onEvent`, which also covers a dead transport.
        if (record) observe(record);
        else if (method === "turn/completed" && !failed) observe({ type: "turn.completed" });
        else observe();
      },
      onEvent: (event) => {
        if (event.type === "error") {
          failed = true;
          observe({ type: "error", message: event.error });
        } else if (event.type === "turn_complete" && event.reason === "model_error" && !failed) {
          failed = true;
          observe({ type: "turn.failed", error: { message: "Codex turn failed" } });
        }
      },
      onNativeApproval: async (request) => {
        const itemId = objectOf(request.params)?.itemId;
        if (typeof itemId === "string") asked.add(itemId);
        const { args } = codexNativeApprovalPresentation(
          request.method,
          request.params,
          request.fileChanges,
          request.fileChangeCount,
        );
        const toolName = APPROVAL_TOOL_NAMES[request.method] ?? "approval";
        return (await ask({ toolName, input: args })).approved ? "accept" : "decline";
      },
      onForeignMcpApproval: async (request) =>
        (
          await ask({
            toolName: `mcp__${request.serverName}__${request.toolName ?? "tool"}`,
            input: request.message ? { message: request.message } : {},
          })
        ).approved,
    },
  );

  const finishTrace = traceExternalAgentRun({
    kind: "codex",
    model: opts.model,
    prompt: opts.prompt,
    signal,
    parameters: {
      transport: "app-server",
      sandbox,
      approvalPolicy: "granular",
      launchCwd: opts.cwd,
      resumeExternalSessionId: opts.resumeSessionId,
      imagePaths: opts.imagePaths,
    },
  });
  if (opts.resumeSessionId) safely(() => opts.onSessionId?.(opts.resumeSessionId!));
  publishProgress();

  let sessionId = opts.resumeSessionId ?? "";
  let sandboxNetworkDisabled = false;
  const turn = async (): Promise<void> => {
    const starting = runtime.start();
    const pid = runtime.processId;
    if (pid) safely(() => opts.onProcess?.(pid));
    await starting;
    const threadId = runtime.runtimeSessionId ?? "";
    if (opts.resumeSessionId && threadId !== opts.resumeSessionId) {
      // The runtime falls back to a new thread; a worker asked to continue a
      // session must not quietly do the task without that session's context.
      // Which transport began the session does not matter: with codex-cli
      // 0.162.0 a `codex exec` session resumes here with its context and under
      // this run's sandbox, and a session begun here resumes with `codex exec`.
      throw new Error(
        `Codex session ${opts.resumeSessionId} could not be resumed (it may belong to another ` +
          "Codex home or have been removed). Omit resumeSessionId to start a new session.",
      );
    }
    sessionId = threadId;
    // Codex's own statement of the sandbox it applied, not the mode asked for:
    // user configuration can give `workspace-write` network access.
    sandboxNetworkDisabled = objectOf(runtime.threadSandbox)?.networkAccess === false;
    observe({ type: "thread.started", thread_id: threadId });
    safely(() => opts.onSessionId?.(threadId));
    const handle = await runtime.send({
      text: opts.prompt,
      attachments: (opts.imagePaths ?? []).map((path) => ({ path, kind: "image" as const })),
    });
    await handle.done;
  };
  const aborted = new Promise<"aborted">((resolve) => {
    signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
  });

  let missingBinary = false;
  try {
    const running = turn();
    // Left running on abort; its eventual rejection is nobody's to handle.
    running.catch(() => {});
    await Promise.race([running, aborted]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The client's own launch diagnostic, which carries the OS error code.
    missingBinary = message.includes("failed to start (ENOENT)");
    if (!failed) observe({ type: "error", message });
    failed = true;
  } finally {
    ended.abort();
    const pid = runtime.processId;
    if (signal?.aborted && pid) {
      // Commands Codex started must not outlive a cancelled worker.
      await terminateAttachedProcessTree({ pid, kill: (sig) => process.kill(pid, sig) });
    }
    await runtime.close().catch(() => {});
    if (progressTimer) publishProgress();
  }

  if (missingBinary) {
    const error = new Error(
      `未找到命令 "${opts.client?.command ?? "codex"}"。请先安装该 CLI 并确保它在 PATH 中（Codex CLI）。`,
    );
    finishTrace(undefined, error);
    throw error;
  }
  const parsed = runWithLines(codexAdapter, lines, signal?.aborted ? null : failed ? 1 : 0);
  const result = {
    ...parsed,
    sessionId: parsed.sessionId || sessionId,
    ...(sandboxBlocked ? { sandboxBlocked } : {}),
    ...(failedCommands ? { failedCommands } : {}),
    ...(sandboxNetworkDisabled ? { sandboxNetworkDisabled } : {}),
  };
  finishTrace(result);
  return result;
}
