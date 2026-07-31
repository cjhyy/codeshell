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
import type { PermissionRule, ToolDefinition } from "@cjhyy/code-shell-core/extension";
import {
  createSessionToolHost,
  FIRST_PHASE_EXPOSURE,
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
import { CodexRuntime, type CodexRuntimeHooks, type CodexRuntimeOptions } from "./codex/runtime.js";
import { ClaudeCodeRuntime, type ClaudeRuntimeHooks } from "./claude-code/runtime.js";

export type ExternalRuntimeKind = "codex" | "claude-code";

/**
 * Everything the host must decide. Deliberately no defaults for the
 * security-relevant fields: see `CreateSessionToolHostOptions`, where the same
 * rule is enforced and tested. A default here would reintroduce the fail-open
 * shape one layer up.
 */
export interface ExternalRuntimeSessionOptions {
  kind: ExternalRuntimeKind;
  cwd: string;
  businessSessionId: string;
  /** Registry holding the tools that may be exposed. */
  registry: Parameters<typeof createSessionToolHost>[0]["registry"];
  permissionMode: Parameters<typeof createSessionToolHost>[0]["permissionMode"];
  presetRules: readonly PermissionRule[];
  /** Whether the user has trusted the project at `cwd`. No default — §12.2. */
  projectTrusted: boolean;
  planMode: boolean;
  visibility: ToolVisibilityInputs;
  /**
   * Tool exposure. Defaults to the reviewed first-phase allowlist rather than to
   * "everything", so forgetting it cannot silently widen the surface.
   */
  exposure?: ExternalToolExposurePolicy;
  approvalBackend?: Parameters<typeof createSessionToolHost>[0]["approvalBackend"];
  /** Host seams the tools need (panels, browser, askUser, …). */
  contextOverrides?: Parameters<typeof createSessionToolHost>[0]["contextOverrides"];
  settingsScope?: Parameters<typeof createSessionToolHost>[0]["settingsScope"];
  model?: string;
  /** Codex only. Kebab-case per protocol. */
  sandbox?: string;
  /** Codex only. Kebab-case per protocol. */
  approvalPolicy?: string;
  /** Claude Code only: extra CLI args. */
  claudeExtraArgs?: readonly string[];
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
  /** Tools actually exposed, after the allowlist and visibility guards. */
  listTools(): readonly ToolDefinition[];
  send(text: string): Promise<{ done: Promise<void> }>;
  interrupt(): Promise<void>;
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
  const exposure = options.exposure ?? FIRST_PHASE_EXPOSURE;
  const pinnedThreadId = `codeshell-${options.businessSessionId}`;

  // 1. Bridge — mints the port and token the runtime is configured with.
  const store = new SessionContextStore<BridgeToolHost>();
  const bridge: McpBridgeHandle = await startLoopbackMcpBridge({
    store,
    singleSessionThreadId: pinnedThreadId,
    log,
  });

  let host: SessionToolHost | undefined;
  let runtime: CodexRuntime | ClaudeCodeRuntime | undefined;
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Unregister BEFORE disposing: a late request must find nothing rather than a
    // disposed host (§13.4).
    store.unregister(pinnedThreadId);
    await runtime?.close();
    await host?.dispose();
    await bridge.close();
  };

  try {
    // 2. Host — the authorization boundary for every tool call the runtime makes.
    host = createSessionToolHost({
      businessSessionId: options.businessSessionId,
      cwd: options.cwd,
      registry: options.registry,
      permissionMode: options.permissionMode,
      presetRules: options.presetRules,
      projectTrusted: options.projectTrusted,
      planMode: options.planMode,
      exposure,
      visibility: options.visibility,
      ...(options.approvalBackend ? { approvalBackend: options.approvalBackend } : {}),
      ...(options.contextOverrides ? { contextOverrides: options.contextOverrides } : {}),
      ...(options.settingsScope ? { settingsScope: options.settingsScope } : {}),
    });

    // 3. Register before the runtime starts, so a tool call on the very first
    //    turn is already routable (§13.1).
    store.register(pinnedThreadId, host);

    // 4. Runtime.
    const exposedToolNames = host.listTools().map((definition) => definition.name);
    if (options.kind === "codex") {
      const codex = new CodexRuntime(
        {
          cwd: options.cwd,
          businessSessionId: options.businessSessionId,
          bridge,
          ...(options.model ? { model: options.model } : {}),
          ...(options.sandbox ? { sandbox: options.sandbox } : {}),
          ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
          ...(options.codexClient ? { client: options.codexClient } : {}),
          log,
        },
        options.hooks ?? {},
      );
      await codex.start();
      runtime = codex;
    } else {
      runtime = new ClaudeCodeRuntime(
        {
          cwd: options.cwd,
          businessSessionId: options.businessSessionId,
          bridge,
          exposedToolNames,
          ...(options.model ? { model: options.model } : {}),
          ...(options.claudeExtraArgs ? { extraArgs: options.claudeExtraArgs } : {}),
          ...(options.claudeCommand ? { command: options.claudeCommand } : {}),
          log,
        },
        options.hooks ?? {},
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
    listTools: () => activeHost.listTools(),
    send: (text) => activeRuntime.send(text),
    interrupt: () => activeRuntime.interrupt(),
    close,
  };
}
