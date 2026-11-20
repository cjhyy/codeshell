/**
 * Claude Code as a CodeShell Agent Runtime.
 *
 * Drives `claude -p --output-format stream-json`, translates the stream into
 * `StreamEvent`, and wires the loopback MCP bridge so the model can reach
 * CodeShell tools mid-turn.
 *
 * Not an `LLMClientBase` (§6.1): Claude Code brings its own agent loop, tools and
 * permission layer. This sits beside the Engine.
 *
 * One structural difference from Codex worth stating plainly: Codex's app-server
 * is a long-lived process serving many turns, whereas `claude -p` is **one process
 * per turn**. Continuity therefore comes from `--resume <sessionId>`, using the id
 * learned from the first turn's `system/init` line — not from keeping a socket
 * open. That is why there is no `start()` here: the first `send()` IS the start.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { StreamEvent } from "@cjhyy/code-shell-core/extension";
import { ClaudeEventTranslator } from "./event-translator.js";
import {
  claudeBridgeArgs,
  CLAUDE_MCP_SERVER_NAME,
  writeClaudeSystemPromptFile,
} from "./mcp-config.js";
import { buildRuntimeSpawnEnv } from "../shared/spawn-env.js";
import {
  CLAUDE_PERMISSION_MODES,
  type ClaudePermissionMode,
  type ClaudePermissionPromptDecider,
} from "./permissions.js";
import type { McpBridgeHandle } from "../shared/mcp-bridge.js";
import type { ExternalHostMcpServer } from "../shared/host-mcp-servers.js";
import type { ExternalRuntimeTurnInput } from "../turn-input.js";
import { buildClaudeUserMessage } from "./user-message.js";

export interface ClaudeRuntimeOptions {
  cwd: string;
  /** CodeShell business session id — the authorization subject. */
  businessSessionId: string;
  bridge: McpBridgeHandle;
  /** CodeShell tool names the bridge exposes, for `--allowed-tools`. */
  exposedToolNames: readonly string[];
  /** Executable; defaults to `claude` on PATH. */
  command?: string;
  /** Extra args, inserted before the runtime's own. */
  extraArgs?: readonly string[];
  model?: string;
  resumeRuntimeSessionId?: string;
  initialContext?: string;
  /**
   * Stable host guidance, appended to Claude's system prompt on EVERY turn —
   * new and resumed alike, because each turn is a new process. Contrast
   * `initialContext`, a one-time transcript replay for a fresh conversation.
   */
  developerInstructions?: string;
  /**
   * `--permission-mode` for Claude's NATIVE tools. Derive it with
   * `claudePermissionModeFor`; see `permissions.ts` for why it is always sent.
   */
  permissionMode?: ClaudePermissionMode;
  /**
   * Plain name of the bridge tool that answers Claude's permission prompts
   * (`withClaudePermissionPrompt`). Qualified here as `mcp__<server>__<name>`.
   */
  permissionPromptTool?: string;
  serverName?: string;
  /** Host-owned stdio MCP servers declared beside the bridge; never pre-approved. */
  hostMcpServers?: readonly ExternalHostMcpServer[];
  /**
   * How long `interrupt()`/`close()` wait after SIGTERM before SIGKILL.
   * Defaults to {@link DEFAULT_INTERRUPT_GRACE_MS}.
   */
  interruptGraceMs?: number;
  /**
   * How long a process must stay silent after a `result` before it counts as
   * only lingering. Defaults to {@link DEFAULT_IDLE_GRACE_MS}.
   */
  idleGraceMs?: number;
  /** Clock for the idle grace period. Defaults to `Date.now`; tests inject one. */
  now?: () => number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

/**
 * Silence after a `result` before the process counts as only lingering. The
 * CLI may still have the submitted message queued behind a `result` it emitted
 * for something else, and starts on it without a line on stdout until the
 * model's stream opens; ending the process in that gap would drop the message.
 */
export const DEFAULT_IDLE_GRACE_MS = 10_000;
/** SIGTERM grace before escalating to SIGKILL. */
export const DEFAULT_INTERRUPT_GRACE_MS = 3_000;
/**
 * Bound on waiting for `exit` after SIGKILL. SIGKILL cannot be ignored, so this
 * only guards against a lost `exit` event; the turn is settled regardless.
 */
const KILL_SETTLE_MS = 2_000;

/** One running `claude -p` process — and therefore one turn. */
interface ActiveTurn {
  readonly child: ChildProcessWithoutNullStreams;
  /** Resolves once the turn is terminal and its resources are released. */
  readonly settled: Promise<void>;
  /** Settle now, even without an `exit` event. Idempotent. */
  finish(code?: number | null, error?: Error): void;
  /** Set by interrupt()/close(): the exit was requested, not a failure. */
  interrupted: boolean;
  failure?: Error;
  stopping?: Promise<void>;
  /**
   * Terminal events of the latest `result`, published when the process ends.
   * A `result` does not end the process: the CLI first answers a queued
   * task-notification with a `result` of its own before it reads the submitted
   * message, and it stays alive after a `result` while a background shell
   * runs, working again when that shell completes. Publishing the first
   * `result` as the end of the turn dropped everything that followed.
   */
  held?: StreamEvent[];
  /** When `held` arrived. */
  heldAt?: number;
  /**
   * The model or a tool produced output in this process. A `result` with none
   * before it answers a queued notification, never the submitted message, so
   * the process is not lingering yet.
   */
  worked?: boolean;
  /** End the process as soon as it only lingers after a `result`. */
  releaseWhenIdle?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function settlesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

export interface ClaudeRuntimeHooks {
  onEvent?: (event: StreamEvent) => void;
  /**
   * Answer Claude's permission prompts for its NATIVE tools (Bash, Edit, …).
   * Wired by the session factory through the bridge's permission-prompt tool;
   * without it every native ask is denied. CodeShell Host Tools never reach it.
   */
  onClaudePermissionPrompt?: ClaudePermissionPromptDecider;
}

export interface ClaudeTurnHandle {
  readonly done: Promise<void>;
}

export class ClaudeCodeRuntime {
  readonly kind = "claude-code" as const;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private active?: ActiveTurn;
  /** Set while send() reads attachments, before `active` exists. */
  private preparing = false;
  private claudeSessionId?: string;
  private reportedModel?: string;
  private closed = false;
  private firstTurn = true;
  private turnCount = 0;

  constructor(
    private readonly options: ClaudeRuntimeOptions,
    private readonly hooks: ClaudeRuntimeHooks = {},
  ) {
    // Typed, but also reachable from untyped callers: an unknown mode must not
    // reach the CLI, where e.g. `auto` would mean classifier auto-approval.
    if (
      options.permissionMode !== undefined &&
      !(CLAUDE_PERMISSION_MODES as readonly string[]).includes(options.permissionMode)
    ) {
      throw new Error(`Unsupported Claude permission mode: ${String(options.permissionMode)}`);
    }
    if (
      options.permissionPromptTool !== undefined &&
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(options.permissionPromptTool)
    ) {
      throw new Error("permissionPromptTool must be a plain bridge tool name");
    }
    this.log = options.log ?? (() => {});
    this.claudeSessionId = options.resumeRuntimeSessionId;
  }

  /** Claude session id, once the first turn has reported it. Resume key only. */
  get runtimeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  /** CLI-reported model, falling back to the requested model until reported. */
  get resolvedModel(): string | undefined {
    return this.reportedModel ?? this.options.model;
  }

  /**
   * Run one turn. Resolves when the process exits, which is also when the turn is
   * terminal — `claude -p` is one process per turn, and may emit more than one
   * `result` before it exits (see `ActiveTurn.held`).
   *
   * The prompt goes on **stdin**, not argv: `--mcp-config` is variadic, so a
   * positional prompt after it is swallowed as another config value (measured),
   * and a prompt on the command line would also be visible in `ps`.
   *
   * Every turn — text-only included — is ONE `--input-format stream-json` user
   * line, so image attachments ride as native content blocks. stdin is then
   * closed: `-p` runs that message to its result (tool calls included) and exits.
   */
  async send(
    input: ExternalRuntimeTurnInput,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<ClaudeTurnHandle> {
    if (this.closed) throw new Error("ClaudeCodeRuntime is closed");
    if (this.active || this.preparing) throw new Error("a turn is already running");
    this.preparing = true;
    let message: Awaited<ReturnType<typeof buildClaudeUserMessage>>;
    try {
      const replayContext =
        this.firstTurn && !this.options.resumeRuntimeSessionId
          ? this.options.initialContext
          : undefined;
      message = await buildClaudeUserMessage(input, (text) =>
        replayContext
          ? `${replayContext}\n\n<current_user_request>\n${text}\n</current_user_request>`
          : text,
      );
    } finally {
      this.preparing = false;
    }
    if (this.closed) throw new Error("ClaudeCodeRuntime is closed");
    if (message.inlineImages > 0 || message.imageFallbacks.length > 0) {
      // Counts and reasons only: never image data or paths.
      this.log("claude.image_attachments", {
        inline: message.inlineImages,
        fallbacks: message.imageFallbacks.map((fallback) => fallback.reason),
      });
    }
    let terminalSeen = false;
    const turnNumber = ++this.turnCount;
    const translator = new ClaudeEventTranslator({
      sessionId: this.options.businessSessionId,
      codeshellServerName: this.options.serverName ?? CLAUDE_MCP_SERVER_NAME,
    });
    translator.beginTurn();

    const wiring = claudeBridgeArgs({
      bridge: this.options.bridge,
      exposedToolNames: this.options.exposedToolNames,
      ...(this.options.serverName ? { serverName: this.options.serverName } : {}),
      ...(this.options.hostMcpServers ? { hostMcpServers: this.options.hostMcpServers } : {}),
    });

    // Per turn: each `claude -p` is a new process, and `--resume` does not carry a
    // previous invocation's appended system prompt forward.
    const systemPrompt = this.options.developerInstructions?.trim()
      ? writeClaudeSystemPromptFile(this.options.developerInstructions)
      : undefined;
    const cleanupTurnFiles = (): void => {
      wiring.cleanup();
      systemPrompt?.cleanup();
    };

    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      // stream-json output requires --verbose; without it the CLI refuses.
      "--verbose",
      ...(this.options.model ? ["--model", this.options.model] : []),
      // Continuity across turns: a fresh process per turn means the session id is
      // the only thread of memory.
      ...(this.claudeSessionId ? ["--resume", this.claudeSessionId] : []),
      ...(systemPrompt ? ["--append-system-prompt-file", systemPrompt.path] : []),
      ...(this.options.permissionMode ? ["--permission-mode", this.options.permissionMode] : []),
      ...(this.options.permissionPromptTool
        ? [
            "--permission-prompt-tool",
            `mcp__${this.options.serverName ?? CLAUDE_MCP_SERVER_NAME}__${this.options.permissionPromptTool}`,
          ]
        : []),
      ...(this.options.extraArgs ?? []),
      ...wiring.args,
    ];

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.options.command ?? "claude", args, {
        cwd: this.options.cwd,
        env: buildRuntimeSpawnEnv({
          bridgeToken: {
            name: this.options.bridge.tokenEnvVar,
            value: this.options.bridge.token,
          },
        }),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      // A synchronous spawn failure never reaches the exit/error handlers below.
      cleanupTurnFiles();
      throw error;
    }

    child.stdout.setEncoding("utf8");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const publish = (event: StreamEvent): void => {
      if (event.type === "turn_complete") terminalSeen = true;
      this.emit(event.type === "stream_request_start" ? { ...event, turnNumber } : event, onEvent);
    };
    lines.on("line", (line) => {
      const { type, events } = this.onLine(line, translator);
      if (events.some((event) => event.type === "turn_complete")) {
        active.held = events;
        active.heldAt = this.now();
        if (active.releaseWhenIdle) this.releaseOnceIdle(active);
        return;
      }
      const activity = type === "stream_event" || type === "assistant" || type === "user";
      if (activity) active.worked = true;
      // Model or tool activity after a `result`: that result was not the end.
      if (active.held && activity) {
        active.held = undefined;
        clearTimeout(active.idleTimer);
        translator.reopenTurn();
        this.log("claude.result_superseded", {});
      }
      for (const event of events) publish(event);
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed) this.log("claude.stderr", { bytes: trimmed.length });
    });

    this.firstTurn = false;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => (resolveSettled = resolve));
    let finished = false;
    const active: ActiveTurn = {
      child,
      settled,
      interrupted: false,
      finish: (code, error) => {
        if (finished) return;
        finished = true;
        lines.close();
        // Clean up the config file that carried the bearer token, and the
        // system-prompt file.
        cleanupTurnFiles();
        if (this.active === active) this.active = undefined;
        clearTimeout(active.idleTimer);
        for (const event of active.held ?? []) publish(event);
        active.held = undefined;
        if (!terminalSeen) {
          if (active.interrupted) {
            // A stop the user asked for is not a model failure. Same terminal
            // reason Codex reports for an interrupted turn.
            this.emit({ type: "turn_complete", reason: "aborted_streaming" }, onEvent);
          } else {
            const detail =
              (error ?? active.failure)?.message ??
              `Claude Code exited without a terminal result (code ${code ?? "unknown"})`;
            this.emit({ type: "error", error: detail }, onEvent);
            this.emit({ type: "turn_complete", reason: "model_error" }, onEvent);
          }
        }
        resolveSettled();
      },
    };
    this.active = active;
    child.once("exit", (code) => active.finish(code));
    child.once("error", (error) => {
      this.log("claude.spawn_failed", { error: error.message.slice(0, 200) });
      active.finish(undefined, error);
    });
    // ChildProcess's error event does not own stdin's asynchronous EPIPE. Keep
    // this listener after exit too: buffered writes can fail during teardown.
    child.stdin.on("error", (error) => {
      if (finished) return;
      active.failure ??= new Error(`Claude Code input pipe closed: ${error.message}`);
      // A broken input transport cannot finish this turn. Reap even a CLI that
      // ignores SIGTERM before releasing the turn to a retry.
      active.stopping ??= this.terminate(active);
    });
    child.stdin.end(message.line);

    return { done: settled };
  }

  private onLine(
    line: string,
    translator: ClaudeEventTranslator,
  ): { type?: unknown; events: StreamEvent[] } {
    if (!line.trim()) return { events: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The CLI may print non-JSON diagnostics; one bad line is not fatal.
      this.log("claude.unparsable_line", { bytes: line.length });
      return { events: [] };
    }
    // Capture identity before publishing terminal output so post-turn work sees
    // the model this process actually used, including aliases resolved by Claude.
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const message = parsed as Record<string, any>;
      // Sub-agent assistant output can name a different model from the root CLI.
      if (message.parent_tool_use_id == null) {
        const model =
          message.type === "system" && message.subtype === "init"
            ? message.model
            : message.type === "assistant"
              ? message.message?.model
              : message.type === "stream_event" && message.event?.type === "message_start"
                ? message.event.message?.model
                : undefined;
        if (typeof model === "string") {
          const identity = model.trim();
          if (identity && identity !== "<synthetic>") this.reportedModel = identity;
        }
      }
    }
    const events = translator.translate(parsed);
    if (!this.claudeSessionId && translator.runtimeSessionId) {
      this.claudeSessionId = translator.runtimeSessionId;
      this.log("claude.session_started", {
        businessSessionId: this.options.businessSessionId,
        runtimeSessionIdPrefix: this.claudeSessionId.slice(0, 8),
      });
    }
    return { type: (parsed as { type?: unknown } | null)?.type, events };
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** Milliseconds until `active` counts as only lingering; undefined while it works. */
  private idleIn(active: ActiveTurn): number | undefined {
    if (!active.held || !active.worked) return undefined;
    const grace = this.options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    return Math.max(0, (active.heldAt ?? 0) + grace - this.now());
  }

  /**
   * The one place a sticky release is decided: end the process if it is idle
   * now, otherwise check again when it could be. Called on a held `result`, on
   * the request itself, and from its own timer — which re-arms rather than
   * gives up when it fires before the clock says the grace has passed (timers
   * and the wall clock disagree by a millisecond or more, more on a loaded
   * machine). Giving up there lost the request: the lingering process was never
   * ended and the queued message never ran.
   */
  private releaseOnceIdle(active: ActiveTurn): void {
    clearTimeout(active.idleTimer);
    active.idleTimer = undefined;
    if (this.active !== active || active.stopping) return;
    const wait = this.idleIn(active);
    if (wait === undefined) return;
    if (wait === 0) {
      active.stopping = this.terminate(active);
      return;
    }
    active.idleTimer = setTimeout(() => this.releaseOnceIdle(active), wait);
    active.idleTimer.unref?.();
  }

  /**
   * End a process that has delivered its `result` and only lingers for a
   * background shell, so the next submission does not wait behind it. The turn
   * settles as the completed turn it was. A working turn is left alone; with
   * `sticky` it is ended as soon as it reaches that idle state. Background
   * shells of the process end with it, and the CLI reports them as stopped on
   * the next resume.
   */
  async releaseIdle(sticky = false): Promise<boolean> {
    const active = this.active;
    if (!active) return false;
    if (this.idleIn(active) !== 0) {
      if (sticky) {
        active.releaseWhenIdle = true;
        this.releaseOnceIdle(active);
      }
      return false;
    }
    active.stopping ??= this.terminate(active);
    await active.stopping;
    return true;
  }

  private emit(event: StreamEvent, onEvent?: (event: StreamEvent) => void): void {
    try {
      (onEvent ?? this.hooks.onEvent)?.(event);
    } catch (error) {
      this.log("claude.event_handler_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  /**
   * Interrupt the active turn and wait until its process is gone.
   *
   * `claude -p` has no interrupt RPC, so this is a signal: SIGTERM, then SIGKILL
   * after the grace period. Returning while the process still runs would let a
   * CLI that ignores SIGTERM keep working — and keep the turn pending — after
   * the host believes it stopped. The turn settles with `aborted_streaming`.
   *
   * As with Codex, it cannot retract side effects already dispatched — it only
   * stops further steps.
   */
  async interrupt(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.interrupted = true;
    active.stopping ??= this.terminate(active);
    await active.stopping;
  }

  private async terminate(active: ActiveTurn): Promise<void> {
    const { child } = active;
    const running = (): boolean => child.exitCode === null && child.signalCode === null;
    if (running()) child.kill("SIGTERM");
    const grace = this.options.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    if (await settlesWithin(active.settled, grace)) return;
    this.log("claude.sigkill", { graceMs: grace });
    if (running()) child.kill("SIGKILL");
    if (await settlesWithin(active.settled, KILL_SETTLE_MS)) return;
    // No `exit` event even after SIGKILL (or the spawn never produced a process).
    // Settle the turn anyway so neither the caller nor the session hangs.
    this.log("claude.exit_not_observed", {});
    active.finish(null);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.interrupt();
  }

  /** Start a fresh conversation on the next `send()`, discarding resume state. */
  resetConversation(): void {
    this.claudeSessionId = undefined;
    this.turnCount = 0;
  }
}
