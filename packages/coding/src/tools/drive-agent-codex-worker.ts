/**
 * A DriveAgent Codex worker that can ask.
 *
 * `codex exec` has no approval channel: outside full access a worker launched
 * with it is confined to its sandbox and whatever the sandbox refuses simply
 * does not happen. The app-server protocol does have one, so a worker that is
 * not in full access runs as a one-turn app-server thread instead, through the
 * same `CodexRuntime` the main Codex runtime uses:
 *
 *   default      → `read-only` sandbox, `on-request` approvals
 *   acceptEdits  → `workspace-write` sandbox rooted at the worker's cwd, `on-request`
 *
 * Every approval request Codex sends (command, patch, extra permissions, a
 * user-configured MCP tool) is put to `approve`, which is the launching
 * Session's gate (`drive-agent-permissions.ts`). The run is reported in the
 * shape of a `codex exec --json` run so the rest of DriveAgent needs no second
 * result or progress model.
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
  initialAgentProgress,
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
      ...(Array.isArray(item.changes)
        ? { changes: item.changes.map((change) => ({ path: objectOf(change)?.path })) }
        : {}),
    },
  };
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
      approvalPolicy: "on-request",
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
        const record = codexExecRecord(method, params);
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
      approvalPolicy: "on-request",
      launchCwd: opts.cwd,
      resumeExternalSessionId: opts.resumeSessionId,
      imagePaths: opts.imagePaths,
    },
  });
  if (opts.resumeSessionId) safely(() => opts.onSessionId?.(opts.resumeSessionId!));
  publishProgress();

  let sessionId = opts.resumeSessionId ?? "";
  const turn = async (): Promise<void> => {
    const starting = runtime.start();
    const pid = runtime.processId;
    if (pid) safely(() => opts.onProcess?.(pid));
    await starting;
    const threadId = runtime.runtimeSessionId ?? "";
    if (opts.resumeSessionId && threadId !== opts.resumeSessionId) {
      // The runtime falls back to a new thread; a worker asked to continue a
      // session must not quietly do the task without that session's context.
      throw new Error(
        `Codex session ${opts.resumeSessionId} could not be resumed (it may belong to another ` +
          "Codex home or have been removed). Omit resumeSessionId to start a new session.",
      );
    }
    sessionId = threadId;
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
  const result = { ...parsed, sessionId: parsed.sessionId || sessionId };
  finishTrace(result);
  return result;
}
