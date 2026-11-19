/**
 * Permissions of a DriveAgent worker (a one-turn `claude -p` / `codex exec`).
 *
 * Three things live here so `drive-agent.ts` only wires them:
 *
 *  1. Which mode a worker gets when the caller names none: the launching
 *     Session's own. A worker must not be wider than its parent by default, and
 *     must not be silently narrower either.
 *  2. Where a Claude Code worker's permission asks go. `claude -p` has no
 *     terminal, so without a prompt tool every ask is refused on the spot. The
 *     worker therefore gets a private loopback MCP server exposing exactly one
 *     tool, the permission prompt, answered by the launching Session's approval
 *     path. Every refusal passes through here, which is what makes a live count
 *     possible without reading the CLI's prose.
 *  3. What the run is called afterwards. A run that was refused operations did
 *     not complete; a run that could only be refused is stopped early so its
 *     parent hears about it in minutes rather than after it idles to the end.
 *
 * Codex has no per-tool asks: its mode is a spawn-time sandbox, so none of the
 * routing applies to it. Only the default-mode rule and the launch note do.
 */
import type { BackgroundJobProgress, ToolContext } from "@cjhyy/code-shell-core/extension";
import type { PermissionDenial, PermissionMode } from "../cc-orchestrator/agent-adapter.js";
import { writeClaudeMcpConfigFile } from "../external-runtimes/claude-code/mcp-config.js";
import {
  CLAUDE_PERMISSION_PROMPT_TOOL,
  withClaudePermissionPrompt,
  type ClaudePermissionPromptRequest,
} from "../external-runtimes/claude-code/permissions.js";
import {
  startLoopbackMcpBridge,
  type BridgeToolHost,
} from "../external-runtimes/shared/mcp-bridge.js";
import { SessionContextStore } from "../external-runtimes/shared/session-context-store.js";

/** Consecutive refused asks after which a worker is stopped and its parent woken. */
export const DRIVE_MAX_CONSECUTIVE_DENIALS = 3;
/** How long one ask may wait for the user before the worker is stopped. */
export const DRIVE_APPROVAL_WAIT_LIMIT_MS = 10 * 60_000;
/** MCP server name of the worker's private prompt bridge. */
export const DRIVE_PERMISSION_SERVER_NAME = "codeshell_approval";

export type DrivePermissionModeSource = "explicit" | "inherited" | "no-session";

/**
 * The mode a worker runs in.
 *
 * An explicit, valid `requested` always wins. Otherwise the launching Session's
 * mode is inherited without escalation: full access stays full access,
 * accept-edits stays accept-edits, and everything else (default, plan, the
 * legacy `auto`, `dontAsk`) becomes `default`, whose asks are then routed to
 * that Session. Only a call with no owning Session keeps the historical
 * defaults, because there is no mode to inherit.
 */
export function resolveDrivePermissionMode(input: {
  requested: unknown;
  parentMode: string | undefined;
  externalRuntime: boolean;
}): { mode: PermissionMode; source: DrivePermissionModeSource } {
  const { requested, parentMode } = input;
  if (requested === "default" || requested === "acceptEdits" || requested === "bypassPermissions")
    return { mode: requested, source: "explicit" };
  if (parentMode === undefined)
    return { mode: input.externalRuntime ? "default" : "bypassPermissions", source: "no-session" };
  if (parentMode === "bypassPermissions" || parentMode === "acceptEdits")
    return { mode: parentMode, source: "inherited" };
  return { mode: "default", source: "inherited" };
}

/** `Bash ×3, WebFetch ×1` — tool names only; arguments never leave the worker. */
export function describeDenials(denials: readonly PermissionDenial[]): string {
  const counts = new Map<string, number>();
  for (const denial of denials) counts.set(denial.toolName, (counts.get(denial.toolName) ?? 0) + 1);
  return [...counts].map(([tool, count]) => `${tool} ×${count}`).join(", ");
}

export type DriveApprovalRequester = NonNullable<ToolContext["requestDelegatedToolApproval"]>;

export interface DrivePermissionGate {
  decide(
    request: ClaudePermissionPromptRequest,
    signal?: AbortSignal,
  ): Promise<{ approved: boolean; reason?: string }>;
  /** Refusals this gate issued, oldest first. */
  denials(): readonly PermissionDenial[];
  /** Why the worker was stopped, once it has been. */
  blockedReason(): string | undefined;
  /** Permission fields for the job's progress record. */
  snapshot(): Pick<
    BackgroundJobProgress,
    "permissionDenials" | "awaitingApprovalSince" | "blocked"
  >;
  /** Called on every state change; at most one listener. */
  setListener(listener: (() => void) | undefined): void;
  /**
   * The worker ended: withdraw every ask still waiting for an answer, so its
   * approval prompt leaves the user's screen instead of outliving the worker.
   */
  withdrawPending(): void;
}

/**
 * Answers one worker's permission asks and keeps the count.
 *
 * `onBlocked` fires at most once, when the worker can evidently not proceed:
 * `maxConsecutiveDenials` refusals in a row, or one ask left unanswered past
 * `approvalWaitLimitMs`. The caller stops the worker; from then on every ask is
 * refused without consulting anyone.
 */
export function createDrivePermissionGate(options: {
  title: string;
  mode: PermissionMode;
  requestApproval?: DriveApprovalRequester;
  onBlocked: (reason: string) => void;
  maxConsecutiveDenials?: number;
  approvalWaitLimitMs?: number;
  now?: () => number;
}): DrivePermissionGate {
  const maxConsecutive = options.maxConsecutiveDenials ?? DRIVE_MAX_CONSECUTIVE_DENIALS;
  const waitLimit = options.approvalWaitLimitMs ?? DRIVE_APPROVAL_WAIT_LIMIT_MS;
  const now = options.now ?? Date.now;
  const denied: PermissionDenial[] = [];
  const waiting = new Set<{ since: number; withdrawal: AbortController }>();
  const withdrawPending = (): void => {
    for (const ask of waiting) ask.withdrawal.abort();
  };
  let consecutive = 0;
  let blocked: string | undefined;
  let listener: (() => void) | undefined;
  const changed = (): void => {
    try {
      listener?.();
    } catch {
      // Observation must never change a permission decision.
    }
  };
  const block = (reason: string): void => {
    if (blocked) return;
    blocked = reason;
    // The worker is being stopped: no other ask of its is awaited any more.
    withdrawPending();
    changed();
    try {
      options.onBlocked(reason);
    } catch {
      // Stopping is best effort; the refusals below still hold.
    }
  };
  const refuse = (toolName: string, reason: string): { approved: false; reason: string } => {
    denied.push({ toolName });
    consecutive += 1;
    changed();
    if (consecutive >= maxConsecutive) {
      block(
        `${consecutive} consecutive operations were denied (${describeDenials(denied.slice(-consecutive))}) ` +
          `under permissionMode "${options.mode}"`,
      );
    }
    return { approved: false, reason };
  };

  return {
    denials: () => denied,
    blockedReason: () => blocked,
    setListener: (next) => {
      listener = next;
    },
    withdrawPending,
    snapshot: () => ({
      ...(denied.length ? { permissionDenials: denied.length } : {}),
      ...(waiting.size
        ? { awaitingApprovalSince: Math.min(...[...waiting].map((ask) => ask.since)) }
        : {}),
      ...(blocked ? { blocked: "permission" as const } : {}),
    }),
    async decide(request, signal) {
      const { toolName } = request;
      if (blocked) {
        return refuse(toolName, "This background task was stopped because it was blocked.");
      }
      if (!options.requestApproval) {
        return refuse(
          toolName,
          `Denied: permissionMode "${options.mode}" requires approval for ${toolName}, and this ` +
            "background task has no approval path. Do not retry; report what could not be done.",
        );
      }
      // Aborted whenever this ask stops being awaited without an answer: the
      // host then retires the prompt on every client.
      const withdrawal = new AbortController();
      const ask = { since: now(), withdrawal };
      waiting.add(ask);
      changed();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;
      let outcome: { approved: boolean; reason?: string } | "timeout" | "cancelled";
      try {
        outcome = await Promise.race([
          options.requestApproval({
            // Same distinct name the main Claude Code runtime uses, so the card
            // is not mistaken for (or remembered as) CodeShell's own tool.
            toolName: `Claude Code ${toolName}`,
            args: request.input,
            reason: `Requested by background task «${options.title}» (DriveAgent worker).`,
            signal: withdrawal.signal,
          }),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), waitLimit);
            (timer as { unref?: () => void }).unref?.();
          }),
          // The worker went away (cancelled or stopped): nobody awaits the answer.
          new Promise<"cancelled">((resolve) => {
            onAbort = () => resolve("cancelled");
            if (signal?.aborted || withdrawal.signal.aborted) onAbort();
            else {
              signal?.addEventListener("abort", onAbort, { once: true });
              withdrawal.signal.addEventListener("abort", onAbort, { once: true });
            }
          }),
        ]);
      } catch {
        outcome = { approved: false, reason: "The CodeShell approval request failed." };
      } finally {
        if (timer) clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
        waiting.delete(ask);
      }
      const withdrawn = withdrawal.signal.aborted;
      // Timed out or cancelled with the prompt still up: take it down. After an
      // answer the prompt is already gone and this changes nothing.
      withdrawal.abort();
      if (outcome === "cancelled" || signal?.aborted || withdrawn) {
        // Not a refusal of the operation, so it is not counted as one.
        changed();
        return { approved: false, reason: "The permission request was cancelled." };
      }
      if (outcome === "timeout") {
        const minutes = Math.max(1, Math.round(waitLimit / 60_000));
        const refusal = refuse(toolName, "The approval request was not answered in time.");
        block(`an approval for ${toolName} went unanswered for ${minutes} min`);
        return refusal;
      }
      if (!outcome.approved) {
        return refuse(toolName, outcome.reason || "The CodeShell user denied this tool call.");
      }
      consecutive = 0;
      changed();
      return { approved: true };
    },
  };
}

export interface DrivePermissionPrompt {
  permissionPrompt: { mcpConfigPath: string; toolName: string };
  close(): Promise<void>;
}

/** Private loopback MCP server whose only tool is this worker's permission prompt. */
export async function startDrivePermissionPrompt(
  gate: Pick<DrivePermissionGate, "decide">,
): Promise<DrivePermissionPrompt> {
  const threadId = `codeshell-drive-${process.hrtime.bigint().toString(36)}`;
  const store = new SessionContextStore<BridgeToolHost>();
  const bridge = await startLoopbackMcpBridge({
    store,
    serverName: DRIVE_PERMISSION_SERVER_NAME,
    singleSessionThreadId: threadId,
  });
  const noTools: BridgeToolHost = {
    businessSessionId: threadId,
    listTools: () => [],
    execute: async (call) => ({ error: `Unknown tool: ${call.name}`, isError: true }),
  };
  let config: ReturnType<typeof writeClaudeMcpConfigFile>;
  try {
    store.register(
      threadId,
      withClaudePermissionPrompt(noTools, gate.decide, DRIVE_PERMISSION_SERVER_NAME),
    );
    config = writeClaudeMcpConfigFile({ bridge, serverName: DRIVE_PERMISSION_SERVER_NAME });
  } catch (error) {
    store.unregister(threadId);
    await bridge.close().catch(() => undefined);
    throw error;
  }
  let closed: Promise<void> | undefined;
  return {
    permissionPrompt: {
      mcpConfigPath: config.path,
      toolName: `mcp__${DRIVE_PERMISSION_SERVER_NAME}__${CLAUDE_PERMISSION_PROMPT_TOOL}`,
    },
    close: () =>
      (closed ??= (async () => {
        // Unregister first so a late ask finds nothing rather than a dead gate.
        store.unregister(threadId);
        config.cleanup();
        await bridge.close().catch(() => undefined);
      })()),
  };
}

export interface DriveRunPermissionOutcome {
  /** Refused operations: the CLI's own report, or the gate's count if larger. */
  denials: number;
  /** Set when the worker was stopped for being unable to proceed. */
  blocked?: string;
  /** Model-facing statement to put ahead of the worker's own final text. */
  note?: string;
}

export interface DriveRunPermissions {
  mode: PermissionMode;
  /** Present when asks are answered by the host instead of refused by the CLI. */
  permissionPrompt?: DrivePermissionPrompt["permissionPrompt"];
  /** Whether an ask can reach a user or policy of the launching Session. */
  routed: boolean;
  setListener(listener: (() => void) | undefined): void;
  /** Merge this run's permission state into a progress record. */
  progress<T extends BackgroundJobProgress>(progress: T): T;
  outcome(result?: {
    permissionDenials?: readonly PermissionDenial[];
    sessionId?: string;
  }): DriveRunPermissionOutcome;
  close(): Promise<void>;
}

/**
 * Set up one run's permission handling. `stop` is invoked when the worker has
 * to be stopped early; it must terminate the external process.
 *
 * Never throws: when the prompt bridge cannot start, the run proceeds without
 * routing and the CLI refuses asks itself. Those refusals are still counted
 * from its terminal report.
 */
export async function prepareDriveRunPermissions(options: {
  cli: "claude" | "codex";
  mode: PermissionMode;
  title: string;
  requestApproval?: DriveApprovalRequester;
  stop: () => void;
  startPrompt?: typeof startDrivePermissionPrompt;
}): Promise<DriveRunPermissions> {
  const { mode } = options;
  const gated = options.cli === "claude" && mode !== "bypassPermissions";
  const gate = gated
    ? createDrivePermissionGate({
        title: options.title,
        mode,
        ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
        onBlocked: () => options.stop(),
      })
    : undefined;
  let prompt: DrivePermissionPrompt | undefined;
  if (gate) {
    try {
      prompt = await (options.startPrompt ?? startDrivePermissionPrompt)(gate);
    } catch {
      prompt = undefined;
    }
  }
  const outcome: DriveRunPermissions["outcome"] = (result) => {
    const reported = result?.permissionDenials ?? [];
    const counted = gate?.denials() ?? [];
    const denials = reported.length >= counted.length ? reported : counted;
    const blocked = gate?.blockedReason();
    if (!denials.length && !blocked) return { denials: 0 };
    const resume = result?.sessionId
      ? ` Its session ${result.sessionId} is kept and can be resumed with a mode that permits them.`
      : "";
    const remedy =
      "The task is NOT complete: those operations did not run (typically shell commands such " +
      "as git, tests, installs or formatters). Check what is missing, then finish it yourself " +
      `or re-run with a suitable permissionMode.${resume}`;
    const tools = denials.length ? ` (${describeDenials(denials)})` : "";
    return {
      denials: denials.length,
      ...(blocked ? { blocked } : {}),
      note: blocked
        ? `[permissions] Stopped early: ${blocked}. ${remedy}`
        : `[permissions] Completed with ${denials.length} denied operation(s)${tools} under ` +
          `permissionMode "${mode}". ${remedy}`,
    };
  };
  return {
    mode,
    ...(prompt ? { permissionPrompt: prompt.permissionPrompt } : {}),
    routed: Boolean(prompt && options.requestApproval),
    setListener: (listener) => gate?.setListener(listener),
    progress: (progress) => {
      const own = gate?.snapshot() ?? {};
      const denials = Math.max(progress.permissionDenials ?? 0, own.permissionDenials ?? 0);
      return { ...progress, ...own, ...(denials ? { permissionDenials: denials } : {}) };
    },
    outcome,
    close: async () => {
      gate?.setListener(undefined);
      // However the run ended, a prompt it left behind must not outlive it.
      gate?.withdrawPending();
      await prompt?.close();
    },
  };
}

/**
 * One line for the tool result at launch, stating the mode and what it blocks.
 * A caller must be able to tell from the result alone that shell work will not
 * run, instead of discovering it when the worker returns empty-handed.
 */
export function drivePermissionLaunchNote(input: {
  cli: "claude" | "codex";
  mode: PermissionMode;
  source: DrivePermissionModeSource;
  routed: boolean;
}): string {
  const { cli, mode } = input;
  const origin =
    input.source === "explicit"
      ? "as requested"
      : input.source === "inherited"
        ? "inherited from this session"
        : "default without a session";
  const head = `Permission mode: ${mode} (${origin}).`;
  if (mode === "bypassPermissions") return `${head} The worker runs every tool unattended.`;
  if (cli === "codex") {
    return mode === "acceptEdits"
      ? `${head} Codex runs in a workspace-write sandbox: it can edit and run commands inside the workspace, without network access.`
      : `${head} Codex runs in a READ-ONLY sandbox: it cannot edit files or run commands that write. Pass permissionMode:"acceptEdits" for workspace writes.`;
  }
  const scope =
    mode === "acceptEdits"
      ? "File edits run unattended; Bash (git, tests, installs), web access and other tools need approval."
      : "Reads run unattended; file edits, Bash (git, tests, installs), web access and other tools need approval.";
  return input.routed
    ? `${head} ${scope} Those requests are sent to this session's approval prompt, labelled with the task title. The worker is stopped early if ${DRIVE_MAX_CONSECUTIVE_DENIALS} in a row are denied or one waits ${Math.round(DRIVE_APPROVAL_WAIT_LIMIT_MS / 60_000)} min unanswered.`
    : `${head} ${scope} NO approval path is available here, so every such operation is DENIED; the worker is stopped after ${DRIVE_MAX_CONSECUTIVE_DENIALS} consecutive denials. Pass permissionMode:"bypassPermissions" only if the user granted that level.`;
}
