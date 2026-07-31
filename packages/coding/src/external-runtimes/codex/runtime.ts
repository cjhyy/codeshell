/**
 * Codex as a CodeShell Agent Runtime.
 *
 * This is the piece that makes Codex usable as an execution backend rather than
 * just a caller of CodeShell tools: it owns the app-server process, starts a
 * thread, runs turns, translates notifications into `StreamEvent`, and wires the
 * loopback MCP bridge so the model can reach CodeShell tools mid-turn.
 *
 * Deliberately NOT an `LLMClientBase` (§6.1, §22.1): Codex brings its own agent
 * loop, tools, session and approval protocol. Wrapping it as a model client would
 * nest two agent loops. This sits beside the Engine, not inside it.
 *
 * Timeouts follow §13.3's ordering and Cindy's measurements: the client has no
 * global timeout (a late response is protocol-legal, and a global timeout
 * manufactures orphan turns), so only the calls where hanging is worse than
 * failing opt in.
 */
import type { StreamEvent } from "@cjhyy/code-shell-core/extension";
import { CodexAppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import { CodexEventTranslator } from "./event-translator.js";
import { buildRuntimeSpawnEnv } from "../shared/spawn-env.js";
import { codexBridgeConfigArgs, type McpBridgeHandle } from "../shared/mcp-bridge.js";

/** A thread/start or turn/start that hangs is worse than one that fails. */
const CRITICAL_RPC_TIMEOUT_MS = 60_000;
/** Interrupt is a fail-safe; an unbounded wait silently defeats it. */
const INTERRUPT_TIMEOUT_MS = 10_000;

export interface CodexRuntimeOptions {
  cwd: string;
  /** CodeShell business session id — the authorization subject, never the thread id. */
  businessSessionId: string;
  /** Loopback MCP bridge the model reaches CodeShell tools through. */
  bridge: McpBridgeHandle;
  /**
   * MCP server name CodeShell's tools are advertised under. Used to decide which
   * approval elicitations are ours to accept — a name mismatch means the request
   * belongs to some other server and must be declined.
   */
  bridgeServerName?: string;
  model?: string;
  /** Codex sandbox mode. Kebab-case per protocol (`workspace-write`, …). */
  sandbox?: string;
  /** Codex approval policy. Also kebab-case. */
  approvalPolicy?: string;
  client?: AppServerClientOptions;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface CodexTurnHandle {
  /** Codex turn id, once known. */
  readonly turnId: string | undefined;
  /** Resolves when the turn reaches a terminal state. */
  readonly done: Promise<void>;
}

/**
 * How the host answers Codex's own approval requests for its NATIVE tools.
 *
 * CodeShell Host Tools are NOT routed here — they go through the MCP bridge and
 * are authorized by `ToolExecutor` (§10.3/§11.4). Answering native approvals here
 * as well is what keeps a single operation from being approved twice.
 */
export type NativeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CodexRuntimeHooks {
  onEvent?: (event: StreamEvent) => void;
  /** Called for Codex's native tool approvals. Defaults to `decline`. */
  onNativeApproval?: (request: {
    method: string;
    params: unknown;
  }) => Promise<NativeApprovalDecision> | NativeApprovalDecision;
}

export class CodexRuntime {
  readonly kind = "codex" as const;
  private readonly client: CodexAppServerClient;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private translator?: CodexEventTranslator;
  private threadId?: string;
  private started = false;
  private activeTurn?: { id?: string; resolve: () => void };

  constructor(
    private readonly options: CodexRuntimeOptions,
    private readonly hooks: CodexRuntimeHooks = {},
  ) {
    this.log = options.log ?? (() => {});
    this.client = new CodexAppServerClient({
      ...options.client,
      cwd: options.cwd,
      // Loopback must bypass any HTTP proxy, or Codex's Rust MCP client routes
      // 127.0.0.1 through it and every tool call dies as UnexpectedContentType.
      env: buildRuntimeSpawnEnv({
        base: options.client?.env,
        bridgeToken: { name: options.bridge.tokenEnvVar, value: options.bridge.token },
      }),
      // Point the thread at the bridge. The token travels by env var, not argv.
      args: [...(options.client?.args ?? ["app-server"]), ...codexBridgeConfigArgs(options.bridge)],
      log: this.log,
    });
  }

  /** Codex thread id, once the thread exists. Protocol routing only — never the
   *  authorization subject (§8.1). */
  get runtimeSessionId(): string | undefined {
    return this.threadId;
  }

  /**
   * Spawn the app-server, handshake, and open a thread.
   *
   * Handler registration happens BEFORE `start()`: the server pushes
   * notifications as soon as the transport is up, and registering later drops
   * them (there is no readiness banner — the `initialize` reply is readiness).
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.client.onNotification((method, params) => this.onNotification(method, params));
    this.client.onServerRequest((method, params) => this.onServerRequest(method, params));
    this.client.start();

    await this.client.request(
      "initialize",
      {
        clientInfo: { name: "codeshell", title: "CodeShell", version: "1" },
        capabilities: { experimentalApi: true },
      },
      CRITICAL_RPC_TIMEOUT_MS,
    );

    const thread = (await this.client.request(
      "thread/start",
      {
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
        ...(this.options.approvalPolicy ? { approvalPolicy: this.options.approvalPolicy } : {}),
      },
      CRITICAL_RPC_TIMEOUT_MS,
    )) as { thread?: { id?: string } };

    const threadId = thread?.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    this.threadId = threadId;
    this.translator = new CodexEventTranslator({
      threadId,
      sessionId: this.options.businessSessionId,
    });
    this.log("runtime.thread_started", {
      businessSessionId: this.options.businessSessionId,
      threadIdPrefix: threadId.slice(0, 8),
    });
  }

  /**
   * Run one turn. Resolves when the turn is terminal.
   *
   * A `turn/start` that times out does NOT mean the turn was not created — the
   * daemon may have accepted it and lost the response. The translator's
   * tombstones are what keep a late `turn/started` from reactivating a session
   * that already reported terminal.
   */
  async send(text: string): Promise<CodexTurnHandle> {
    if (!this.threadId) throw new Error("CodexRuntime.send() before start()");
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    this.activeTurn = { resolve: resolveDone };

    const response = (await this.client.request(
      "turn/start",
      {
        threadId: this.threadId,
        // `text_elements` is required by the protocol even when empty.
        input: [{ type: "text", text, text_elements: [] }],
      },
      CRITICAL_RPC_TIMEOUT_MS,
    )) as { turn?: { id?: string } };

    const turnId = response?.turn?.id;
    if (this.activeTurn) this.activeTurn.id = turnId;
    return {
      get turnId() {
        return turnId;
      },
      done,
    };
  }

  /**
   * Interrupt the active turn.
   *
   * Bounded on purpose: a hung app-server would otherwise leave this RPC pending
   * forever, which silently defeats a stop request. Note what interrupt does NOT
   * do — it cannot retract side effects already dispatched, so it promises only
   * that no further step starts (§13.3).
   */
  async interrupt(): Promise<void> {
    const turnId = this.activeTurn?.id;
    if (!this.threadId || !turnId) return;
    try {
      await this.client.request(
        "turn/interrupt",
        { threadId: this.threadId, turnId },
        INTERRUPT_TIMEOUT_MS,
      );
    } catch (error) {
      // Surface rather than swallow: a stop the user asked for that did not land
      // must not look like it did.
      this.log("runtime.interrupt_failed", {
        error: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
      throw error;
    }
  }

  async close(): Promise<void> {
    // Settle any waiter first, so a close during a live turn cannot leave the
    // caller awaiting forever (§13.4).
    this.activeTurn?.resolve();
    this.activeTurn = undefined;
    await this.client.close();
  }

  private onNotification(method: string, params: unknown): void {
    const events = this.translator?.translate({ method, params }) ?? [];
    for (const event of events) {
      try {
        this.hooks.onEvent?.(event);
      } catch (error) {
        this.log("runtime.event_handler_failed", {
          error: error instanceof Error ? error.name : "unknown",
        });
      }
      if (event.type === "turn_complete") {
        this.activeTurn?.resolve();
        this.activeTurn = undefined;
      }
    }
  }

  /**
   * Codex's native-tool approvals. CodeShell Host Tools never arrive here —
   * they come in over the MCP bridge and are authorized by `ToolExecutor`, which
   * is precisely how the same operation avoids being approved twice.
   *
   * Default is `decline`: an unanswered or unknown approval must not become an
   * implicit yes.
   */
  private async onServerRequest(method: string, params: unknown): Promise<unknown> {
    // Codex asks for approval of OUR OWN MCP server's tools through
    // `mcpServer/elicitation/request`, NOT through `item/permissions/requestApproval`.
    // Measured: leaving it unhandled makes the app-server log
    // `unhandled: mcpServer/elicitation/request` and the model report the tool call
    // as "rejected" — so the reverse channel silently never fires. The distinguishing
    // marker is `_meta.codex_approval_kind === "mcp_tool_call"`.
    if (method === "mcpServer/elicitation/request") {
      return this.answerMcpElicitation(params);
    }
    if (!method.includes("requestApproval")) {
      // Some other server request (user input, …). Leave unhandled so the client
      // answers method-not-found rather than inventing consent.
      return undefined;
    }
    const decision = this.hooks.onNativeApproval
      ? await this.hooks.onNativeApproval({ method, params })
      : "decline";
    this.log("runtime.native_approval", { method, decision });
    return { decision };
  }

  /**
   * Accept an approval elicitation for CodeShell's own MCP server, and only that.
   *
   * This is the §10.3/§11.4 "no double approval" rule in practice: the call is
   * about to reach `SessionToolHost` → `ToolExecutor`, which applies the exposure
   * allowlist, the permission rules and the approval backend. Asking the user here
   * as well would prompt twice for one operation; declining here would make
   * CodeShell tools permanently unreachable.
   *
   * Everything else is declined. An elicitation from a THIRD-PARTY MCP server, or
   * one whose kind we do not recognise, is not ours to consent to — and a blanket
   * accept here would hand the runtime a yes for any server it can name.
   */
  private answerMcpElicitation(params: unknown): unknown {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const meta =
      record._meta && typeof record._meta === "object"
        ? (record._meta as Record<string, unknown>)
        : {};
    const kind =
      typeof meta.codex_approval_kind === "string" ? meta.codex_approval_kind : undefined;
    const server = typeof record.serverName === "string" ? record.serverName : undefined;
    const expected = this.options.bridgeServerName ?? "codeshell_tools";
    const ours = kind === "mcp_tool_call" && server === expected;

    this.log("runtime.mcp_elicitation", {
      kind,
      serverName: server,
      decision: ours ? "accept" : "decline",
    });
    // `content`/`_meta` null: no form input, and no session-level persistence —
    // each call is authorized on its own merits by ToolExecutor.
    return { action: ours ? "accept" : "decline", content: null, _meta: null };
  }
}
