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
import {
  codexHostMcpServerArgs,
  hostMcpSecretEnv,
  validateExternalHostMcpServers,
  type ExternalHostMcpServer,
} from "../shared/host-mcp-servers.js";
import { textWithAttachmentReferences, type ExternalRuntimeTurnInput } from "../turn-input.js";

/** A thread/start or turn/start that hangs is worse than one that fails. */
const CRITICAL_RPC_TIMEOUT_MS = 60_000;
/** Interrupt is a fail-safe; an unbounded wait silently defeats it. */
const INTERRUPT_TIMEOUT_MS = 10_000;

export interface CodexRuntimeOptions {
  cwd: string;
  /** CodeShell business session id — the authorization subject, never the thread id. */
  businessSessionId: string;
  /**
   * Loopback MCP bridge the model reaches CodeShell tools through. Absent for a
   * thread that gets no CodeShell tools (a delegated one-turn worker): nothing
   * is advertised, and no MCP elicitation is accepted as CodeShell's own.
   */
  bridge?: McpBridgeHandle;
  /**
   * MCP server name CodeShell's tools are advertised under. Used to decide which
   * approval elicitations are ours to accept — a name mismatch means the request
   * belongs to some other server and must be declined.
   */
  bridgeServerName?: string;
  /**
   * Host-owned stdio MCP servers declared beside the bridge. Their approval
   * elicitations go to `onHostMcpApproval`; ignored with `disableNativeTools`.
   */
  hostMcpServers?: readonly ExternalHostMcpServer[];
  model?: string;
  resumeRuntimeSessionId?: string;
  initialContext?: string;
  developerInstructions?: string;
  /** Codex sandbox mode. Kebab-case per protocol (`workspace-write`, …). */
  sandbox?: string;
  /** Codex approval policy: a kebab-case name, or the protocol's `{ granular: … }` object. */
  approvalPolicy?: string | { readonly granular: Readonly<Record<string, boolean>> };
  /** Host-only manager mode: expose the reviewed bridge without native execution tools. */
  disableNativeTools?: boolean;
  client?: AppServerClientOptions;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface CodexTurnHandle {
  /** The app-server acknowledged turn/start, even if output has not arrived. */
  readonly accepted: true;
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

/** One file a pending Codex patch touches (`FileUpdateChange` without its diff). */
export interface CodexFileChangeSummary {
  path: string;
  /** `add` / `delete` / `update`; an update that moves the file names the new path. */
  kind: string;
  movePath?: string;
}

export interface CodexRuntimeHooks {
  onEvent?: (event: StreamEvent) => void;
  /** Called for Codex's native tool approvals. Defaults to `decline`. */
  onNativeApproval?: (request: {
    method: string;
    params: unknown;
    /**
     * `item/fileChange/requestApproval` carries no file list: the files of the
     * patch under review, as its `fileChange` item announced them (at most 50).
     */
    fileChanges?: CodexFileChangeSummary[];
    /** How many files the patch touches in all; more than `fileChanges` lists when truncated. */
    fileChangeCount?: number;
  }) => Promise<NativeApprovalDecision> | NativeApprovalDecision;
  /**
   * Called for an approval elicitation from one of `hostMcpServers`. These tools
   * bypass `ToolExecutor`, so nothing else authorizes the call. Defaults to decline.
   */
  onHostMcpApproval?: (request: {
    serverName: string;
    toolName?: string;
    /** The call's arguments, as Codex reports them for the prompt. */
    args?: Record<string, unknown>;
    message?: string;
  }) => Promise<boolean> | boolean;
  /**
   * Called for a tool-call approval elicitation from an MCP server that is
   * neither the bridge nor a declared Host server (one the user configured for
   * Codex itself). Defaults to decline.
   */
  onForeignMcpApproval?: (request: {
    serverName: string;
    toolName?: string;
    args?: Record<string, unknown>;
    message?: string;
  }) => Promise<boolean> | boolean;
  /**
   * Every app-server notification as received, before translation. Observation
   * only: for a host that needs item boundaries `StreamEvent` does not carry.
   */
  onNotification?: (method: string, params: unknown) => void;
  /** Answer Codex's request_user_input tool through the owning CodeShell UI. */
  onUserInput?: (request: { method: string; params: unknown }) => Promise<unknown> | unknown;
}

/** A Stop requested while the turn id was still unknown. */
interface DeferredInterrupt {
  readonly promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** The one turn this runtime is driving. */
interface ActiveTurn {
  /** Codex turn id — from `turn/started` or the `turn/start` response, whichever lands first. */
  id?: string;
  resolve: () => void;
  onEvent?: (event: StreamEvent) => void;
  /** `turn/start` has been sent and not yet answered. */
  starting: boolean;
  /** Stop arrived before the id; sent as soon as the id is known. */
  pendingInterrupt?: DeferredInterrupt;
  /** The deferred Stop has been sent; it must not be sent a second time. */
  interruptSent: boolean;
}

/** Patches remembered for their approval prompt; older ones are dropped first. */
const MAX_TRACKED_FILE_CHANGES = 64;
/** Files listed per patch; the rest are counted (`fileChangeCount`), not listed. */
const MAX_FILE_CHANGES_LISTED = 50;

/**
 * Codex 0.162's empty environment selection removes shell, apply_patch and
 * view_image handlers. StableEnvironmentTools must also stay off: it otherwise
 * advertises environment tools even when no environment was selected.
 */
const NATIVE_TOOLS_DISABLED_CONFIG = Object.freeze({
  "features.shell_tool": false,
  "features.stable_environment_tools": false,
  "features.view_image": false,
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.remote_plugin": false,
  "features.browser_use": false,
  "features.browser_use_external": false,
  "features.computer_use": false,
  "features.image_generation": false,
  "features.hooks": false,
  "features.memories": false,
  "features.goals": false,
  "features.code_mode.enabled": false,
  "features.standalone_web_search": false,
  "tools.update_plan.enabled": false,
  "tools.experimental_request_user_input.enabled": false,
  web_search: "disabled",
});

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** A patch's files for its approval prompt: the first ones listed, all of them counted. */
interface TrackedFileChanges {
  files: CodexFileChangeSummary[];
  total: number;
}

/** `FileUpdateChange[]` → paths and kinds (the diffs stay out of prompts). */
function summarizeFileChanges(changes: unknown): TrackedFileChanges | undefined {
  if (!Array.isArray(changes)) return undefined;
  const all = changes.flatMap((change) => {
    const entry = objectOf(change);
    if (!entry || typeof entry.path !== "string") return [];
    const kind = objectOf(entry.kind);
    const type = typeof kind?.type === "string" ? kind.type : "update";
    const movePath = typeof kind?.move_path === "string" ? kind.move_path : undefined;
    return [{ path: entry.path, kind: type, ...(movePath ? { movePath } : {}) }];
  });
  return { files: all.slice(0, MAX_FILE_CHANGES_LISTED), total: all.length };
}

/**
 * `item/permissions/requestApproval` answers with the permissions granted, not
 * a decision: exactly the requested profile for this turn on accept, nothing
 * on anything else.
 */
function permissionsResponse(params: unknown, decision: NativeApprovalDecision): unknown {
  const requested = objectOf(objectOf(params)?.permissions);
  const granted: Record<string, unknown> = {};
  if (decision === "accept" || decision === "acceptForSession") {
    const network = objectOf(requested?.network);
    const fileSystem = objectOf(requested?.fileSystem);
    if (network) granted.network = network;
    if (fileSystem) granted.fileSystem = fileSystem;
  }
  return { permissions: granted, scope: "turn" };
}

/** Read a turn id from a `turn/started` / `turn/completed` notification. */
function notificationTurnId(params: unknown): string | undefined {
  if (!params || typeof params !== "object") return undefined;
  const record = params as Record<string, unknown>;
  const turn =
    record.turn && typeof record.turn === "object" ? (record.turn as Record<string, unknown>) : {};
  if (typeof turn.id === "string" && turn.id) return turn.id;
  return typeof record.turnId === "string" && record.turnId ? record.turnId : undefined;
}

export class CodexRuntime {
  readonly kind = "codex" as const;
  private readonly client: CodexAppServerClient;
  private readonly log: (event: string, data: Record<string, unknown>) => void;
  private translator?: CodexEventTranslator;
  private threadId?: string;
  private reportedModel?: string;
  private reportedSandbox?: unknown;
  private started = false;
  private resumed = false;
  private firstTurn = true;
  private readonly hostMcpServers: readonly ExternalHostMcpServer[];
  private activeTurn?: ActiveTurn;
  /** Files of each `fileChange` item still in flight, by item id (for its approval prompt). */
  private readonly fileChanges = new Map<string, TrackedFileChanges>();
  /**
   * `mcpToolCall` items still in flight, by item id. An approval elicitation
   * names the server but not the tool (measured, codex 0.162.0), so the tool
   * is read from the call it belongs to.
   */
  private readonly mcpToolCalls = new Map<string, { server: string; tool: string }>();

  constructor(
    private readonly options: CodexRuntimeOptions,
    private readonly hooks: CodexRuntimeHooks = {},
  ) {
    this.log = options.log ?? (() => {});
    // A manager-mode thread is restricted to the reviewed bridge: no other server.
    this.hostMcpServers = options.disableNativeTools
      ? []
      : validateExternalHostMcpServers(
          options.hostMcpServers,
          options.bridgeServerName ?? "codeshell_tools",
        );
    this.client = new CodexAppServerClient({
      ...options.client,
      cwd: options.cwd,
      // Loopback must bypass any HTTP proxy, or Codex's Rust MCP client routes
      // 127.0.0.1 through it and every tool call dies as UnexpectedContentType.
      env: buildRuntimeSpawnEnv({
        base: options.client?.env,
        ...(options.bridge
          ? { bridgeToken: { name: options.bridge.tokenEnvVar, value: options.bridge.token } }
          : {}),
        secrets: hostMcpSecretEnv(this.hostMcpServers),
      }),
      // Point the thread at the bridge. The token travels by env var, not argv.
      args: [
        ...(options.client?.args ?? ["app-server"]),
        ...(options.bridge ? codexBridgeConfigArgs(options.bridge, options.bridgeServerName) : []),
        ...codexHostMcpServerArgs(this.hostMcpServers),
      ],
      log: this.log,
    });
  }

  /** Codex thread id, once the thread exists. Protocol routing only — never the
   *  authorization subject (§8.1). */
  get runtimeSessionId(): string | undefined {
    return this.threadId;
  }

  /** OS pid of the app-server process, once spawned. */
  get processId(): number | undefined {
    return this.client.processId;
  }

  /** CLI-reported model, falling back to the requested model until reported. */
  get resolvedModel(): string | undefined {
    return this.reportedModel ?? this.options.model;
  }

  /** The `sandbox` policy Codex answered thread/start or thread/resume with. */
  get threadSandbox(): unknown {
    return this.reportedSandbox;
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
    this.client.onClose((reason) => this.onTransportClosed(reason));
    this.client.start();

    const initialized = await this.client.request(
      "initialize",
      {
        clientInfo: { name: "codeshell", title: "CodeShell", version: "1" },
        capabilities: { experimentalApi: true },
      },
      CRITICAL_RPC_TIMEOUT_MS,
    );
    const nativeToolConfig = this.options.disableNativeTools
      ? await this.nativeToolsDisabledConfig(initialized)
      : undefined;

    let thread: { thread?: { id?: string }; model?: unknown; sandbox?: unknown } | undefined;
    if (this.options.resumeRuntimeSessionId) {
      try {
        thread = (await this.client.request(
          "thread/resume",
          {
            threadId: this.options.resumeRuntimeSessionId,
            cwd: this.options.cwd,
            ...(this.options.model ? { model: this.options.model } : {}),
            ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
            ...(this.options.approvalPolicy ? { approvalPolicy: this.options.approvalPolicy } : {}),
            ...(nativeToolConfig ? { config: nativeToolConfig } : {}),
            ...(this.options.developerInstructions
              ? { developerInstructions: this.options.developerInstructions }
              : {}),
          },
          CRITICAL_RPC_TIMEOUT_MS,
        )) as { thread?: { id?: string }; model?: unknown };
        this.resumed = true;
      } catch (error) {
        this.log("runtime.thread_resume_failed", {
          businessSessionId: this.options.businessSessionId,
          error: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        });
      }
    }
    thread ??= (await this.client.request(
      "thread/start",
      {
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.sandbox ? { sandbox: this.options.sandbox } : {}),
        ...(this.options.approvalPolicy ? { approvalPolicy: this.options.approvalPolicy } : {}),
        ...(nativeToolConfig ? { config: nativeToolConfig, environments: [] } : {}),
        ...(this.options.developerInstructions
          ? { developerInstructions: this.options.developerInstructions }
          : {}),
      },
      CRITICAL_RPC_TIMEOUT_MS,
    )) as { thread?: { id?: string }; model?: unknown };

    const threadId = thread?.thread?.id;
    if (!threadId) {
      throw new Error(`${this.resumed ? "thread/resume" : "thread/start"} returned no thread id`);
    }
    this.threadId = threadId;
    this.reportedSandbox = thread?.sandbox;
    const reportedModel = thread?.model;
    if (typeof reportedModel === "string" && reportedModel.trim()) {
      this.reportedModel = reportedModel.trim();
    }
    this.translator = new CodexEventTranslator({
      threadId,
      sessionId: this.options.businessSessionId,
    });
    this.log("runtime.thread_started", {
      businessSessionId: this.options.businessSessionId,
      threadIdPrefix: threadId.slice(0, 8),
      resumed: this.resumed,
    });
    // Announce the host identity after a successful start/resume. Codex may
    // deliver thread/started before this RPC settles (and before the translator
    // exists), so that notification cannot reliably establish the UI binding.
    this.emitEvent({
      type: "session_started",
      sessionId: this.options.businessSessionId,
      promptTokens: 0,
    });
  }

  private async nativeToolsDisabledConfig(initialized: unknown): Promise<Record<string, unknown>> {
    const userAgent = objectOf(initialized)?.userAgent;
    // initialize reports the CLI build version after its originator prefix,
    // independently of the clientInfo version supplied by CodeShell.
    const version =
      typeof userAgent === "string"
        ? /^[^/\s]+\/(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(userAgent)
        : undefined;
    if (!version || (Number(version[1]) === 0 && Number(version[2]) < 162)) {
      throw new Error(
        "Mimi requires Codex CLI 0.162.0 or newer to disable native execution tools. " +
          "Update Codex and retry; no model request was started.",
      );
    }

    // An empty mcp_servers table merges with the user's config; it does not
    // remove inherited servers. Read names only, then disable every server
    // except this Host-owned bridge. Never log or expose configuration values.
    let config: Record<string, unknown> | undefined;
    try {
      const response = await this.client.request(
        "config/read",
        { includeLayers: false, cwd: this.options.cwd },
        CRITICAL_RPC_TIMEOUT_MS,
      );
      config = objectOf(objectOf(response)?.config);
    } catch {
      throw new Error(
        "Could not verify Codex native-tool isolation configuration; no model request was started.",
      );
    }
    const servers = objectOf(config?.mcp_servers);
    const bridgeName = this.options.bridgeServerName ?? "codeshell_tools";
    if (!servers || !Object.prototype.hasOwnProperty.call(servers, bridgeName)) {
      throw new Error(
        "Could not verify the CodeShell MCP bridge in Codex configuration; " +
          "no model request was started.",
      );
    }
    return {
      ...NATIVE_TOOLS_DISABLED_CONFIG,
      mcp_servers: Object.fromEntries(
        Object.keys(servers).map((name) => [name, { enabled: name === bridgeName }]),
      ),
    };
  }

  /**
   * Run one turn. Resolves when the turn is terminal.
   *
   * A `turn/start` that times out does NOT mean the turn was not created — the
   * daemon may have accepted it and lost the response. The translator's
   * tombstones are what keep a late `turn/started` from reactivating a session
   * that already reported terminal.
   */
  async send(
    input: ExternalRuntimeTurnInput,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<CodexTurnHandle> {
    if (!this.threadId) throw new Error("CodexRuntime.send() before start()");
    // A dead app-server can never run another turn. Fail now, before any turn
    // state exists, so the host rebuilds the runtime instead of waiting.
    if (this.client.isClosed) {
      throw new Error(
        `Codex app-server is not running (${this.client.closedReason ?? "closed"}); ` +
          `the runtime must be restarted`,
      );
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => (resolveDone = resolve));
    const turn: ActiveTurn = {
      resolve: resolveDone,
      onEvent,
      starting: true,
      interruptSent: false,
    };
    this.activeTurn = turn;

    let text = textWithAttachmentReferences(input);
    if (this.firstTurn && !this.resumed && this.options.initialContext) {
      text = `${this.options.initialContext}\n\n<current_user_request>\n${text}\n</current_user_request>`;
    }
    this.firstTurn = false;
    const imageInputs = (input.attachments ?? [])
      .filter(
        (attachment) =>
          attachment.kind === "image" || attachment.mime?.toLowerCase().startsWith("image/"),
      )
      .map((attachment) => ({
        type: "localImage" as const,
        path: attachment.path,
        ...(attachment.detail === "low" || attachment.detail === "high"
          ? { detail: attachment.detail }
          : {}),
      }));
    let response: { turn?: { id?: string } } | undefined;
    try {
      response = (await this.client.request(
        "turn/start",
        {
          threadId: this.threadId,
          ...(input.clientMessageId ? { clientUserMessageId: input.clientMessageId } : {}),
          // `text_elements` is required by the protocol even when empty.
          input: [{ type: "text", text, text_elements: [] }, ...imageInputs],
          // Resume has no environment field, so fence every turn as well.
          ...(this.options.disableNativeTools ? { environments: [] } : {}),
        },
        CRITICAL_RPC_TIMEOUT_MS,
      )) as { turn?: { id?: string } } | undefined;
    } catch (error) {
      // The rejection is the caller's terminal signal for this turn. Release the
      // turn state so a Stop waiting on its id, or a later close, does not hang
      // on a turn the caller never received.
      turn.starting = false;
      if (this.activeTurn === turn) this.activeTurn = undefined;
      turn.pendingInterrupt?.resolve();
      turn.pendingInterrupt = undefined;
      turn.resolve();
      throw error;
    }
    turn.starting = false;

    // The response is authoritative for the id, but `turn/started` may already
    // have supplied it (and already delivered a deferred Stop).
    const turnId = response?.turn?.id;
    if (turnId) this.bindTurnId(turn, turnId);
    return {
      accepted: true,
      get turnId() {
        return turn.id;
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
    const turn = this.activeTurn;
    if (!this.threadId || !turn) return;
    if (turn.id) return this.requestInterrupt(turn.id);
    // Stop between sending turn/start and learning the turn id: Codex may
    // already be running the turn, so returning here would silently drop the
    // Stop. Remember it, and send turn/interrupt the moment the id is known.
    if (!turn.starting) return;
    if (!turn.pendingInterrupt) {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // Every caller awaits through the bounded race below; this only keeps a
      // rejection that arrives after that race from becoming unhandled.
      promise.catch(() => {});
      turn.pendingInterrupt = { promise, resolve, reject };
    }
    // Bounded like the RPC itself. A timeout leaves the Stop recorded: it is
    // still delivered if the id arrives later, but the caller learns now that
    // the stop has not landed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(
              `Codex did not report the turn id within ${INTERRUPT_TIMEOUT_MS}ms; ` +
                `the interrupt has not been delivered yet`,
            ),
          ),
        INTERRUPT_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([turn.pendingInterrupt.promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async requestInterrupt(turnId: string): Promise<void> {
    if (!this.threadId) return;
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
    const turn = this.activeTurn;
    this.activeTurn = undefined;
    turn?.pendingInterrupt?.resolve();
    turn?.resolve();
    await this.client.close();
  }

  /** Learn the active turn's id; deliver a Stop that was waiting for it, once. */
  private bindTurnId(turn: ActiveTurn, turnId: string): void {
    turn.id = turnId;
    const waiter = turn.pendingInterrupt;
    if (!waiter || turn.interruptSent) return;
    turn.interruptSent = true;
    turn.pendingInterrupt = undefined;
    this.requestInterrupt(turnId).then(waiter.resolve, waiter.reject);
  }

  /**
   * The app-server is gone (exited, failed, broken stream). A turn Codex already
   * accepted would otherwise wait forever for a `turn/completed` that can never
   * arrive, so report it terminal now as a model error. A turn whose
   * `turn/start` is still unanswered is NOT reported here: that RPC rejects, and
   * the rejected `send()` is its caller's terminal signal.
   */
  private onTransportClosed(reason: string): void {
    const turn = this.activeTurn;
    if (!turn) return;
    this.activeTurn = undefined;
    turn.pendingInterrupt?.resolve();
    turn.pendingInterrupt = undefined;
    if (!turn.starting) {
      this.log("runtime.turn_lost", {
        businessSessionId: this.options.businessSessionId,
        reason: reason.slice(0, 200),
      });
      const sink = turn.onEvent ?? this.hooks.onEvent;
      this.emitEvent(
        { type: "error", error: `Codex app-server stopped before the turn finished: ${reason}` },
        sink,
      );
      this.emitEvent({ type: "turn_complete", reason: "model_error" }, sink);
    }
    turn.resolve();
  }

  private onNotification(method: string, params: unknown): void {
    this.trackFileChanges(method, params);
    this.trackMcpToolCalls(method, params);
    try {
      this.hooks.onNotification?.(method, params);
    } catch (error) {
      this.log("runtime.notification_hook_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    const events = this.translator?.translate({ method, params }) ?? [];
    for (const event of events) {
      // A fresh turn announced while ours has no id yet IS ours: the translator
      // already discarded orphans of finished turns. This is the earliest point
      // the id is known, and a Stop pressed before the RPC answers depends on it.
      if (event.type === "stream_request_start" && method === "turn/started") {
        const turn = this.activeTurn;
        const turnId = notificationTurnId(params);
        if (turn && !turn.id && turnId) this.bindTurnId(turn, turnId);
      }
      this.emitEvent(event);
      if (event.type === "turn_complete") {
        const turn = this.activeTurn;
        this.activeTurn = undefined;
        turn?.pendingInterrupt?.resolve();
        turn?.resolve();
      }
    }
  }

  /** Remember an MCP tool call from `item/started` until `item/completed`. */
  private trackMcpToolCalls(method: string, params: unknown): void {
    if (method !== "item/started" && method !== "item/completed") return;
    const item = objectOf(objectOf(params)?.item);
    if (item?.type !== "mcpToolCall" || typeof item.id !== "string") return;
    this.mcpToolCalls.delete(item.id);
    if (method === "item/completed") return;
    if (typeof item.server !== "string" || typeof item.tool !== "string") return;
    this.mcpToolCalls.set(item.id, { server: item.server, tool: item.tool });
    for (const oldest of this.mcpToolCalls.keys()) {
      if (this.mcpToolCalls.size <= MAX_TRACKED_FILE_CHANGES) break;
      this.mcpToolCalls.delete(oldest);
    }
  }

  /** The tool an approval for `server` is about: named by Codex, else the one call in flight. */
  private approvalToolName(meta: Record<string, unknown>, server: string): string | undefined {
    if (typeof meta.tool_name === "string") return meta.tool_name;
    const tools = new Set(
      [...this.mcpToolCalls.values()]
        .filter((call) => call.server === server)
        .map((call) => call.tool),
    );
    // Several different tools in flight: naming one would be a guess.
    return tools.size === 1 ? [...tools][0] : undefined;
  }

  /** Remember a patch's files from `item/started` / `patchUpdated` until `item/completed`. */
  private trackFileChanges(method: string, params: unknown): void {
    const record = objectOf(params);
    const item = objectOf(record?.item);
    let itemId: string | undefined;
    let changes: unknown;
    if ((method === "item/started" || method === "item/completed") && item?.type === "fileChange") {
      itemId = typeof item.id === "string" ? item.id : undefined;
      if (method === "item/completed") {
        if (itemId) this.fileChanges.delete(itemId);
        return;
      }
      changes = item.changes;
    } else if (method === "item/fileChange/patchUpdated") {
      itemId = typeof record?.itemId === "string" ? record.itemId : undefined;
      changes = record?.changes;
    } else return;
    const summary = summarizeFileChanges(changes);
    if (!itemId || !summary) return;
    this.fileChanges.delete(itemId);
    this.fileChanges.set(itemId, summary);
    for (const oldest of this.fileChanges.keys()) {
      if (this.fileChanges.size <= MAX_TRACKED_FILE_CHANGES) break;
      this.fileChanges.delete(oldest);
    }
  }

  private emitEvent(
    event: StreamEvent,
    sink: ((event: StreamEvent) => void) | undefined = this.activeTurn?.onEvent ??
      this.hooks.onEvent,
  ): void {
    try {
      sink?.(event);
    } catch (error) {
      this.log("runtime.event_handler_failed", {
        error: error instanceof Error ? error.name : "unknown",
      });
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
    if (method === "item/tool/requestUserInput") {
      return this.hooks.onUserInput
        ? await this.hooks.onUserInput({ method, params })
        : { answers: {} };
    }
    if (!method.includes("requestApproval")) {
      // Some other server request (user input, …). Leave unhandled so the client
      // answers method-not-found rather than inventing consent.
      return undefined;
    }
    const itemId = objectOf(params)?.itemId;
    const tracked =
      method === "item/fileChange/requestApproval" && typeof itemId === "string"
        ? this.fileChanges.get(itemId)
        : undefined;
    const decision =
      !this.options.disableNativeTools && this.hooks.onNativeApproval
        ? await this.hooks.onNativeApproval({
            method,
            params,
            ...(tracked ? { fileChanges: tracked.files, fileChangeCount: tracked.total } : {}),
          })
        : "decline";
    this.log("runtime.native_approval", { method, decision });
    if (method === "item/permissions/requestApproval") return permissionsResponse(params, decision);
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
   * A declared Host MCP server (`hostMcpServers`) is the opposite case: its tools
   * do NOT pass through `ToolExecutor`, so this elicitation is the only approval
   * the call gets. It is put to `onHostMcpApproval` and declined without one.
   *
   * Everything else is declined. An elicitation from a THIRD-PARTY MCP server, or
   * one whose kind we do not recognise, is not ours to consent to — and a blanket
   * accept here would hand the runtime a yes for any server it can name.
   */
  private async answerMcpElicitation(params: unknown): Promise<unknown> {
    const record = params && typeof params === "object" ? (params as Record<string, unknown>) : {};
    const meta =
      record._meta && typeof record._meta === "object"
        ? (record._meta as Record<string, unknown>)
        : {};
    const kind =
      typeof meta.codex_approval_kind === "string" ? meta.codex_approval_kind : undefined;
    const server = typeof record.serverName === "string" ? record.serverName : undefined;
    const expected = this.options.bridgeServerName ?? "codeshell_tools";
    let ours = Boolean(this.options.bridge) && kind === "mcp_tool_call" && server === expected;
    if (kind === "mcp_tool_call" && server !== undefined && !ours) {
      const declared = this.hostMcpServers.some((host) => host.name === server);
      const ask = declared ? this.hooks.onHostMcpApproval : this.hooks.onForeignMcpApproval;
      const toolName = this.approvalToolName(meta, server);
      const args = objectOf(meta.tool_params);
      try {
        ours =
          (await ask?.({
            serverName: server,
            ...(toolName ? { toolName } : {}),
            ...(args ? { args } : {}),
            ...(typeof record.message === "string" ? { message: record.message } : {}),
          })) === true;
      } catch {
        ours = false;
      }
    }

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
