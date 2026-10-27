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
import { textWithAttachmentReferences, type ExternalRuntimeTurnInput } from "../turn-input.js";

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
  /**
   * How long `interrupt()`/`close()` wait after SIGTERM before SIGKILL.
   * Defaults to {@link DEFAULT_INTERRUPT_GRACE_MS}.
   */
  interruptGraceMs?: number;
  log?: (event: string, data: Record<string, unknown>) => void;
}

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
   * terminal — `claude -p` is one process per turn.
   *
   * The prompt goes on **stdin**, not argv: `--mcp-config` is variadic, so a
   * positional prompt after it is swallowed as another config value (measured),
   * and a prompt on the command line would also be visible in `ps`.
   */
  async send(
    input: ExternalRuntimeTurnInput,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<ClaudeTurnHandle> {
    if (this.closed) throw new Error("ClaudeCodeRuntime is closed");
    if (this.active) throw new Error("a turn is already running");
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
    lines.on("line", (line) => {
      this.onLine(line, translator, (event) => {
        if (event.type === "turn_complete") terminalSeen = true;
        this.emit(
          event.type === "stream_request_start" ? { ...event, turnNumber } : event,
          onEvent,
        );
      });
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed) this.log("claude.stderr", { bytes: trimmed.length });
    });

    let text = textWithAttachmentReferences(input);
    if (this.firstTurn && !this.options.resumeRuntimeSessionId && this.options.initialContext) {
      text = `${this.options.initialContext}\n\n<current_user_request>\n${text}\n</current_user_request>`;
    }
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
    child.stdin.end(text);

    return { done: settled };
  }

  private onLine(
    line: string,
    translator: ClaudeEventTranslator,
    emit: (event: StreamEvent) => void,
  ): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The CLI may print non-JSON diagnostics; one bad line is not fatal.
      this.log("claude.unparsable_line", { bytes: line.length });
      return;
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
    for (const event of translator.translate(parsed)) emit(event);
    if (!this.claudeSessionId && translator.runtimeSessionId) {
      this.claudeSessionId = translator.runtimeSessionId;
      this.log("claude.session_started", {
        businessSessionId: this.options.businessSessionId,
        runtimeSessionIdPrefix: this.claudeSessionId.slice(0, 8),
      });
    }
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
