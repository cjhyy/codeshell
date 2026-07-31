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
import { claudeBridgeArgs, CLAUDE_MCP_SERVER_NAME } from "./mcp-config.js";
import { buildRuntimeSpawnEnv } from "../shared/spawn-env.js";
import type { McpBridgeHandle } from "../shared/mcp-bridge.js";

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
  serverName?: string;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface ClaudeRuntimeHooks {
  onEvent?: (event: StreamEvent) => void;
}

export interface ClaudeTurnHandle {
  readonly done: Promise<void>;
}

export class ClaudeCodeRuntime {
  readonly kind = "claude-code" as const;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private translator: ClaudeEventTranslator;
  private child?: ChildProcessWithoutNullStreams;
  private claudeSessionId?: string;
  private closed = false;

  constructor(
    private readonly options: ClaudeRuntimeOptions,
    private readonly hooks: ClaudeRuntimeHooks = {},
  ) {
    this.log = options.log ?? (() => {});
    this.translator = new ClaudeEventTranslator({
      sessionId: options.businessSessionId,
      codeshellServerName: options.serverName ?? CLAUDE_MCP_SERVER_NAME,
    });
  }

  /** Claude session id, once the first turn has reported it. Resume key only. */
  get runtimeSessionId(): string | undefined {
    return this.claudeSessionId;
  }

  /**
   * Run one turn. Resolves when the process exits, which is also when the turn is
   * terminal — `claude -p` is one process per turn.
   *
   * The prompt goes on **stdin**, not argv: `--mcp-config` is variadic, so a
   * positional prompt after it is swallowed as another config value (measured),
   * and a prompt on the command line would also be visible in `ps`.
   */
  async send(text: string): Promise<ClaudeTurnHandle> {
    if (this.closed) throw new Error("ClaudeCodeRuntime is closed");
    if (this.child) throw new Error("a turn is already running");

    const wiring = claudeBridgeArgs({
      bridge: this.options.bridge,
      exposedToolNames: this.options.exposedToolNames,
      ...(this.options.serverName ? { serverName: this.options.serverName } : {}),
    });

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
      ...(this.options.extraArgs ?? []),
      ...wiring.args,
    ];

    const child = spawn(this.options.command ?? "claude", args, {
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
    this.child = child;

    child.stdout.setEncoding("utf8");
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.onLine(line));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const trimmed = chunk.trim();
      if (trimmed) this.log("claude.stderr", { bytes: trimmed.length });
    });

    child.stdin.end(text);

    const done = new Promise<void>((resolve) => {
      const finish = (): void => {
        lines.close();
        // Clean up the config file that carried the bearer token.
        wiring.cleanup();
        this.child = undefined;
        resolve();
      };
      child.once("exit", finish);
      child.once("error", (error) => {
        this.log("claude.spawn_failed", { error: error.message.slice(0, 200) });
        finish();
      });
    });

    return { done };
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // The CLI may print non-JSON diagnostics; one bad line is not fatal.
      this.log("claude.unparsable_line", { bytes: line.length });
      return;
    }
    for (const event of this.translator.translate(parsed)) {
      try {
        this.hooks.onEvent?.(event);
      } catch (error) {
        this.log("claude.event_handler_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
    if (!this.claudeSessionId && this.translator.runtimeSessionId) {
      this.claudeSessionId = this.translator.runtimeSessionId;
      this.log("claude.session_started", {
        businessSessionId: this.options.businessSessionId,
        runtimeSessionIdPrefix: this.claudeSessionId.slice(0, 8),
      });
    }
  }

  /**
   * Interrupt the active turn.
   *
   * `claude -p` has no interrupt RPC, so this is a signal. As with Codex, it
   * cannot retract side effects already dispatched — it only stops further steps.
   */
  async interrupt(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.interrupt();
  }

  /** Start a fresh conversation on the next `send()`, discarding resume state. */
  resetConversation(): void {
    this.claudeSessionId = undefined;
    this.translator = new ClaudeEventTranslator({
      sessionId: this.options.businessSessionId,
      codeshellServerName: this.options.serverName ?? CLAUDE_MCP_SERVER_NAME,
    });
  }
}
