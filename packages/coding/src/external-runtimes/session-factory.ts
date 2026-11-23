import type { ClaudeRuntimeOptions } from "./claude-code/runtime.js";
/**
 * The composition root for an external-runtime session.
 *
 * Until now every piece existed but nothing assembled them, so
 * `createSessionToolHost` had no production caller. That absence is exactly how a
 * real security defect slipped in earlier (an untrusted project could
 * self-authorize, because no caller was passing `projectTrusted`) — an options
 * object with no real caller is an options object nobody has had to get right.
 * This module is that caller.
 *
 * It owns the assembly order, which is not arbitrary:
 *
 *  1. bridge first — it mints the token and port the runtime will be told about;
 *  2. host second — it needs the exposure policy and the permission inputs;
 *  3. register the session in the store BEFORE the runtime starts, so a tool call
 *     on the runtime's very first turn can already be routed (§13.1);
 *  4. runtime last.
 *
 * Teardown reverses it, and unregisters before disposing the host so a late
 * request finds nothing rather than a disposed host (§13.4).
 */
import type { PermissionRule, StreamEvent, ToolDefinition } from "@cjhyy/code-shell-core/extension";
import {
  createSessionToolHost,
  deriveExternalToolExposure,
  intersectExternalToolExposure,
  type ExternalToolExposurePolicy,
  type SessionToolHost,
  type ToolVisibilityInputs,
} from "@cjhyy/code-shell-core/extension";
import {
  startLoopbackMcpBridge,
  type BridgeToolHost,
  type McpBridgeHandle,
} from "./shared/mcp-bridge.js";
import { SessionContextStore } from "./shared/session-context-store.js";
import type { ExternalHostMcpServer } from "./shared/host-mcp-servers.js";
import { CodexRuntime, type CodexRuntimeHooks, type CodexRuntimeOptions } from "./codex/runtime.js";
import { ClaudeCodeRuntime, type ClaudeRuntimeHooks } from "./claude-code/runtime.js";
import { CLAUDE_MCP_SERVER_NAME } from "./claude-code/mcp-config.js";
import {
  CLAUDE_PERMISSION_PROMPT_TOOL,
  claudeModeUsesPermissionPrompt,
  claudePermissionModeFor,
  rememberClaudePermissionGrants,
  withClaudePermissionPrompt,
  type ClaudePermissionMode,
} from "./claude-code/permissions.js";
import type { ExternalRuntimeTurnInput } from "./turn-input.js";

export type ExternalRuntimeKind = "codex" | "claude-code";

/**
 * Whether each runtime's model receives MCP image content from a tool result.
 *
 * Both runtimes drive vision-capable model families and forward MCP `image`
 * content to the model. Without a declaration the host has no `llmConfig` to
 * infer this from (the runtime picks and calls its own model), so image tools
 * such as browser_observe(vision) failed closed and never captured pixels.
 */
const RUNTIME_ACCEPTS_TOOL_IMAGES: Readonly<Record<ExternalRuntimeKind, boolean>> = Object.freeze({
  codex: true,
  "claude-code": true,
});

/**
 * Everything the host must decide. Deliberately no defaults for the
 * security-relevant fields: see `CreateSessionToolHostOptions`, where the same
 * rule is enforced and tested. A default here would reintroduce the fail-open
 * shape one layer up.
 */
type ProviderKeys = "runtimeSessionId" | "resolvedModel" | "send" | "interrupt" | "close";
export type CodexProvider = Pick<CodexRuntime, ProviderKeys | "start">;
export type ClaudeProvider = Pick<ClaudeCodeRuntime, ProviderKeys | "releaseIdle">;
/** A desktop Host may own provider processes while the same scoped MCP bridge authorizes tools. */
export interface ExternalProviderFactories {
  codex(
    options: CodexRuntimeOptions,
    hooks: CodexRuntimeHooks,
    disconnected: () => void,
  ): Promise<CodexProvider>;
  claude(
    options: ClaudeRuntimeOptions,
    hooks: ClaudeRuntimeHooks,
    disconnected: () => void,
  ): Promise<ClaudeProvider>;
}

export interface ExternalRuntimeSessionOptions {
  providerFactories?: ExternalProviderFactories;
  onProviderDisconnect?: () => void;
  kind: ExternalRuntimeKind;
  cwd: string;
  businessSessionId: string;
  /** Registry holding the tools that may be exposed. */
  registry: Parameters<typeof createSessionToolHost>[0]["registry"];
  permissionMode: Parameters<typeof createSessionToolHost>[0]["permissionMode"];
  /** Host-selected file access, independent of tool rules and exposure. */
  pathAccess?: Parameters<typeof createSessionToolHost>[0]["pathAccess"];
  presetRules: readonly PermissionRule[];
  /** Whether the user has trusted the project at `cwd`. No default — §12.2. */
  projectTrusted: boolean;
  planMode: boolean;
  visibility: ToolVisibilityInputs;
  /**
   * Optional further restriction on the composed registry's reviewed contracts.
   * The Host revalidates those contracts on every operation; this cannot grant
   * an undeclared, changed or unreviewed tool.
   */
  exposure?: ExternalToolExposurePolicy;
  approvalBackend?: Parameters<typeof createSessionToolHost>[0]["approvalBackend"];
  /** Host seams the tools need (panels, browser, askUser, …). */
  contextOverrides?: Parameters<typeof createSessionToolHost>[0]["contextOverrides"];
  captureRunContext?: Parameters<typeof createSessionToolHost>[0]["captureRunContext"];
  settingsScope?: Parameters<typeof createSessionToolHost>[0]["settingsScope"];
  /** Resolve the pinned Host Profile's current capability overrides for each tool operation. */
  getProfileOverrides?: Parameters<typeof createSessionToolHost>[0]["getProfileOverrides"];
  getVisibility?: Parameters<typeof createSessionToolHost>[0]["getVisibility"];
  mcpServers?: Parameters<typeof createSessionToolHost>[0]["mcpServers"];
  /** A Host-owned version-checked Goal controller is registered in this catalog. */
  goalController?: boolean;
  /** Host-owned Mimi executors (NotifyMe, ReportToMimi) are registered in this catalog. */
  mimiHost?: boolean;
  /**
   * Override the runtime's declared image capability (e.g. a host that knows
   * the selected model is text-only). Defaults per runtime kind.
   */
  modelSupportsVision?: boolean;
  model?: string;
  /** Runtime thread/session id recovered from durable Desktop state. */
  resumeRuntimeSessionId?: string;
  /** Context replayed only when resume is unavailable and a fresh thread starts. */
  initialContext?: string;
  /** Stable host guidance applied to new and resumed runtime threads. */
  developerInstructions?: string;
  /** Codex only. Kebab-case per protocol. */
  sandbox?: string;
  /** Codex only. Kebab-case per protocol. */
  approvalPolicy?: string;
  /** Restrict the external provider to the Host's reviewed bridge tools. */
  disableNativeTools?: boolean;
  /**
   * Host-owned stdio MCP servers offered beside the bridge (Desktop's gated
   * Computer Use proxy). They bypass `ToolExecutor`: the Host decides whether a
   * session gets one, the server enforces its own execution policy, and each
   * call is approved through `approvalBackend` (Codex) or the Claude permission
   * prompt. Never offered in plan mode or with `disableNativeTools`.
   */
  hostMcpServers?: readonly ExternalHostMcpServer[];
  /** Claude Code only: extra CLI args. */
  claudeExtraArgs?: readonly string[];
  /**
   * Claude Code only: `--permission-mode` for its native tools. Defaults to
   * `claudePermissionModeFor({ permissionMode, planMode })`. A host whose
   * user-facing selection differs from the host-tool `permissionMode` it passes
   * (Desktop maps full access to `acceptEdits` for host tools) passes it
   * explicitly.
   */
  claudePermissionMode?: ClaudePermissionMode;
  /**
   * Override how the runtime process is launched (Codex: app-server client
   * options; Claude: the `claude` binary). Exists so the assembly can be tested
   * against a fake runtime — a composition root that can only be exercised with a
   * logged-in binary is a composition root nobody tests.
   */
  codexClient?: CodexRuntimeOptions["client"];
  claudeCommand?: string;
  hooks?: CodexRuntimeHooks & ClaudeRuntimeHooks;
  log?: (event: string, data: Record<string, unknown>) => void;
}

export interface ExternalRuntimeSession {
  readonly kind: ExternalRuntimeKind;
  readonly businessSessionId: string;
  /** Runtime-side id (Codex thread / Claude session). Resume + routing only. */
  readonly runtimeSessionId: string | undefined;
  /** Latest CLI-reported model; requested model is the fallback when unavailable. */
  readonly resolvedModel?: string;
  /** Tools actually exposed, after the allowlist and visibility guards. */
  listTools(): readonly ToolDefinition[];
  send(
    input: ExternalRuntimeTurnInput,
    onEvent?: (event: StreamEvent) => void,
  ): Promise<{
    done: Promise<void>;
    /** Explicit provider start acknowledgement; spawning a process does not qualify. */
    accepted?: true;
  }>;
  interrupt(): Promise<void>;
  /**
   * End a provider process that finished its reply and only lingers for its own
   * background shell (Claude Code). True when one was ended. `sticky` ends the
   * running turn's process as soon as it reaches that state.
   */
  releaseIdle?(sticky?: boolean): Promise<boolean>;
  /** Reverses the assembly order; safe to call more than once. */
  close(): Promise<void>;
}

/**
 * Assemble and start an external-runtime session.
 *
 * The bridge is pinned to this one session for BOTH runtimes. Codex could share
 * one bridge across threads (it sends `_meta.threadId`), but its first
 * `tools/list` arrives before the thread exists and therefore cannot be routed —
 * measured, and when Codex does not re-list, the tool stays invisible for the
 * whole session. Claude Code sends no thread identity at all. One bridge per
 * session makes the port the attribution and removes both problems; §22.7's cost
 * (an extra port per session) is the price.
 */
export async function startExternalRuntimeSession(
  options: ExternalRuntimeSessionOptions,
): Promise<ExternalRuntimeSession> {
  const log = options.log ?? (() => {});
  const hostControllers = { goalController: options.goalController, mimiHost: options.mimiHost };
  const exposure = intersectExternalToolExposure(
    deriveExternalToolExposure(options.registry, hostControllers),
    options.exposure,
  );
  const pinnedThreadId = `codeshell-${options.businessSessionId}`;

  // 1. Bridge — mints the port and token the runtime is configured with.
  const store = new SessionContextStore<BridgeToolHost>();
  const bridge: McpBridgeHandle = await startLoopbackMcpBridge({
    store,
    singleSessionThreadId: pinnedThreadId,
    log,
  });

  let host: SessionToolHost | undefined;
  let runtime: CodexProvider | ClaudeProvider | undefined;
  let claudeGrants: ReturnType<typeof rememberClaudePermissionGrants> | undefined;
  let closed = false;
  let turnSink: ((event: StreamEvent) => void) | undefined;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Unregister BEFORE disposing: a late request must find nothing rather than a
    // disposed host (§13.4).
    store.unregister(pinnedThreadId);
    try {
      await runtime?.close();
    } finally {
      try {
        await host?.dispose();
      } finally {
        claudeGrants?.clear();
        await bridge.close();
      }
    }
  };

  const disconnected = () => {
    // Revoke the pinned MCP registration synchronously when its provider disappears.
    if (closed) return;
    try {
      options.onProviderDisconnect?.();
    } finally {
      void close().catch((error) =>
        log("runtime.disconnected_cleanup_failed", { error: String(error) }),
      );
    }
  };

  try {
    // 2. Host — the authorization boundary for every tool call the runtime makes.
    host = createSessionToolHost({
      businessSessionId: options.businessSessionId,
      cwd: options.cwd,
      registry: options.registry,
      permissionMode: options.permissionMode,
      pathAccess: options.pathAccess,
      presetRules: options.presetRules,
      projectTrusted: options.projectTrusted,
      planMode: options.planMode,
      exposure,
      getExposure: () =>
        intersectExternalToolExposure(
          deriveExternalToolExposure(options.registry, hostControllers),
          options.exposure,
        ),
      visibility: options.visibility,
      ...(options.approvalBackend ? { approvalBackend: options.approvalBackend } : {}),
      ...(options.contextOverrides ? { contextOverrides: options.contextOverrides } : {}),
      // Outside a concrete provider call there is no run output owner. Never
      // capture the lifetime callback and let it borrow a later active turn.
      getStreamCallback: () => turnSink,
      ...(options.captureRunContext ? { captureRunContext: options.captureRunContext } : {}),
      ...(options.settingsScope ? { settingsScope: options.settingsScope } : {}),
      ...(options.getProfileOverrides ? { getProfileOverrides: options.getProfileOverrides } : {}),
      ...(options.getVisibility ? { getVisibility: options.getVisibility } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      modelSupportsVision: options.modelSupportsVision ?? RUNTIME_ACCEPTS_TOOL_IMAGES[options.kind],
      // `hooks` is deliberately not passed: the host then loads the same
      // settings/plugin tool hooks a Native Engine registers for this cwd,
      // filtered by `projectTrusted` and `settingsScope`. The runtime's own
      // native hooks (Codex/Claude config) are separate and unaffected.
    });

    // Claude's NATIVE tools: an explicit mode always, and — only where the mode
    // asks and the host can answer — a prompt tool on this session's bridge.
    const claudePermissionMode =
      options.claudePermissionMode ??
      claudePermissionModeFor({
        permissionMode: options.permissionMode,
        planMode: options.planMode,
      });
    // "Allow for this session" on a native Claude tool lives as long as this
    // runtime session, like the Host Tool grants the host itself remembers.
    if (options.hooks?.onClaudePermissionPrompt)
      claudeGrants = rememberClaudePermissionGrants(options.hooks.onClaudePermissionPrompt, {
        sessionId: options.businessSessionId,
        cwd: options.cwd,
      });
    const onClaudePermissionPrompt = claudeGrants?.decide;
    const claudePromptTool =
      options.kind === "claude-code" &&
      onClaudePermissionPrompt &&
      claudeModeUsesPermissionPrompt(claudePermissionMode)
        ? CLAUDE_PERMISSION_PROMPT_TOOL
        : undefined;

    // 3. Register before the runtime starts, so a tool call on the very first
    //    turn is already routable (§13.1).
    store.register(
      pinnedThreadId,
      claudePromptTool && onClaudePermissionPrompt
        ? withClaudePermissionPrompt(host, onClaudePermissionPrompt, CLAUDE_MCP_SERVER_NAME)
        : host,
    );

    // 4. Runtime.
    const exposedToolNames = host.listTools().map((definition) => definition.name);
    // Restricted sessions keep the reviewed bridge as their only tool channel.
    const hostMcpServers =
      options.disableNativeTools || options.planMode ? [] : (options.hostMcpServers ?? []);
    const approvalBackend = options.approvalBackend;
    if (options.kind === "codex") {
      const createCodex =
        options.providerFactories?.codex ?? ((opts, hooks) => new CodexRuntime(opts, hooks));
      const codex = await createCodex(
        {
          cwd: options.cwd,
          businessSessionId: options.businessSessionId,
          bridge,
          ...(options.model ? { model: options.model } : {}),
          ...(options.resumeRuntimeSessionId
            ? { resumeRuntimeSessionId: options.resumeRuntimeSessionId }
            : {}),
          ...(options.initialContext ? { initialContext: options.initialContext } : {}),
          ...(options.developerInstructions
            ? { developerInstructions: options.developerInstructions }
            : {}),
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
          ...(options.disableNativeTools ? { disableNativeTools: true } : {}),
          ...(hostMcpServers.length ? { hostMcpServers } : {}),
          ...(options.codexClient ? { client: options.codexClient } : {}),
          log,
        },
        {
          // No approval backend means no hook: the runtime then declines.
          ...(approvalBackend
            ? {
                onHostMcpApproval: async (request) =>
                  (
                    await approvalBackend.requestApproval({
                      sessionId: options.businessSessionId,
                      toolName: `mcp__${request.serverName}__${request.toolName ?? "tool"}`,
                      args: request.args ?? {},
                      description:
                        request.message ??
                        `Codex wants to use ${request.toolName ?? "a tool"} on ${request.serverName}.`,
                      riskLevel: "high",
                    })
                  ).approved === true,
              }
            : {}),
          ...options.hooks,
        },
        disconnected,
      );
      // Own the process before its handshake can fail, so the catch path also
      // closes an app-server that launched but could not initialize a thread.
      runtime = codex;
      await codex.start();
    } else {
      const createClaude =
        options.providerFactories?.claude ?? ((opts, hooks) => new ClaudeCodeRuntime(opts, hooks));
      runtime = await createClaude(
        {
          cwd: options.cwd,
          businessSessionId: options.businessSessionId,
          bridge,
          exposedToolNames,
          ...(options.model ? { model: options.model } : {}),
          ...(options.resumeRuntimeSessionId
            ? { resumeRuntimeSessionId: options.resumeRuntimeSessionId }
            : {}),
          ...(options.initialContext ? { initialContext: options.initialContext } : {}),
          ...(options.developerInstructions
            ? { developerInstructions: options.developerInstructions }
            : {}),
          permissionMode: claudePermissionMode,
          ...(claudePromptTool ? { permissionPromptTool: claudePromptTool } : {}),
          ...(hostMcpServers.length ? { hostMcpServers } : {}),
          ...(options.disableNativeTools
            ? { extraArgs: [...(options.claudeExtraArgs ?? []), "--tools", ""] }
            : options.claudeExtraArgs
              ? { extraArgs: options.claudeExtraArgs }
              : {}),
          ...(options.claudeCommand ? { command: options.claudeCommand } : {}),
          log,
        },
        options.hooks ?? {},
        disconnected,
      );
      // Claude Code is one process per turn; the first send() is the start.
    }
  } catch (error) {
    // A runtime that failed to start must not leave an orphaned bridge holding a
    // port and a live token (§13.1).
    await close();
    throw error;
  }

  const activeHost = host;
  const activeRuntime = runtime;
  return {
    kind: options.kind,
    businessSessionId: options.businessSessionId,
    get runtimeSessionId() {
      return activeRuntime.runtimeSessionId;
    },
    get resolvedModel() {
      return activeRuntime.resolvedModel;
    },
    listTools: () => activeHost.listTools(),
    send: async (input, onEvent) => {
      if (turnSink) throw new Error("An external runtime turn is already running");
      const sink = onEvent ?? options.hooks?.onEvent;
      turnSink = sink;
      try {
        const turn = await activeRuntime.send(input, sink);
        return {
          ...("accepted" in turn && turn.accepted === true ? { accepted: true as const } : {}),
          done: turn.done.finally(() => {
            if (turnSink === sink) turnSink = undefined;
          }),
        };
      } catch (error) {
        if (turnSink === sink) turnSink = undefined;
        throw error;
      }
    },
    interrupt: () => activeRuntime.interrupt(),
    ...("releaseIdle" in activeRuntime
      ? { releaseIdle: (sticky?: boolean) => activeRuntime.releaseIdle(sticky) }
      : {}),
    close,
  };
}
