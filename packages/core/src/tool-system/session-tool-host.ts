/**
 * Session-scoped tool host for external Agent Runtimes.
 *
 * An external runtime (Codex, Claude Code) drives its own agent loop and its own
 * native tools. When it wants a CODESHELL tool it comes back in over MCP, and
 * this is what it reaches: a narrow, per-business-session surface that exposes an
 * explicitly allowlisted subset of the registry.
 *
 * The single rule that matters: **every call goes through
 * `ToolExecutor.executeSingle()`**. `ToolRegistry` is not a security boundary —
 * calling it directly would skip visibility, plan mode, argument validation, path
 * policy, permission, sandbox, hooks, and result redaction. The MCP transport,
 * the model's chosen tool name, and its arguments are all untrusted; the business
 * session context is bound here by the host, out of band.
 *
 * Deliberately domain-agnostic: no Claude/Codex/Electron/coding literals. The
 * runtime adapters live in the coding capability and talk to this through the
 * `SessionToolHost` interface.
 */
import type { PermissionMode, ToolDefinition, ToolResult } from "../types.js";
import type { ToolContext } from "./context.js";
import { ToolExecutor } from "./executor.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier, type ApprovalBackend } from "./permission.js";
import { HookRegistry } from "../hooks/registry.js";
import { buildToolVisibility, type ToolVisibilityInputs } from "../engine/run-tooling.js";

/**
 * Permission modes an external session may use.
 *
 * `bypassPermissions` and `dontAsk` are excluded at the type level because they
 * short-circuit `PermissionClassifier` entirely (it returns allow / deny before
 * consulting any rule). Under either one, "the call went through ToolExecutor"
 * becomes true but meaningless. The external runtime's OWN permission mode is a
 * separate thing and is unaffected by this — it governs that runtime's native
 * tools, not CodeShell's.
 */
export type ExternalSessionPermissionMode = Exclude<
  PermissionMode,
  "bypassPermissions" | "dontAsk"
>;

const FORBIDDEN_MODES: ReadonlySet<string> = new Set(["bypassPermissions", "dontAsk"]);

/**
 * Which tools an external runtime may see and call.
 *
 * Allowlist only — no "everything in the registry", no prefix matching. A tool
 * that is not named here does not exist as far as the runtime is concerned, and
 * naming it anyway is an error rather than a silent no-op.
 */
export interface ExternalToolExposurePolicy {
  mode: "allowlist";
  toolNames: ReadonlySet<string>;
  /**
   * Optional per-tool argument narrowing, for tools that multiplex several
   * operations behind one name (e.g. a Panel tool with list/open/tools/invoke).
   * Values are regex sources matched against the stringified argument.
   *
   * This binds on `execute()` as well as `listTools()`: describing a limit only
   * in the advertised schema would leave it advisory, and the arguments come
   * from the model.
   */
  argsPatterns?: ReadonlyMap<string, Readonly<Record<string, string>>>;
}

export interface SessionToolHost {
  readonly businessSessionId: string;
  /**
   * The assembled session ToolContext.
   *
   * Exposed read-only so a host can inspect what the executor will actually see
   * — most usefully `toolVisibility` (absent means ToolExecutor SKIPS its
   * availability guard) and `allowedToolNames`. Do not mutate it; narrow the
   * exposure policy instead.
   */
  readonly toolContext: ToolContext;
  listTools(): readonly ToolDefinition[];
  execute(
    call: { id: string; name: string; input: unknown },
    signal?: AbortSignal,
  ): Promise<ToolResult>;
  dispose(): Promise<void>;
}

export interface CreateSessionToolHostOptions {
  businessSessionId: string;
  cwd: string;
  registry: ToolRegistry;
  permissionMode: ExternalSessionPermissionMode;
  planMode: boolean;
  exposure: ExternalToolExposurePolicy;
  /**
   * Availability-guard inputs. Required, not optional: `ToolExecutor` SKIPS its
   * visibility gate when `toolCtx.toolVisibility` is absent, so omitting this
   * would not merely under-expose tools — it would make host-gated tools
   * callable in a context their guard was written to exclude.
   */
  visibility: ToolVisibilityInputs;
  approvalBackend?: ApprovalBackend;
  hooks?: HookRegistry;
  /** Extra ToolContext seams the host supplies (panels, browser, askUser, …). */
  contextOverrides?: Partial<ToolContext>;
  signal?: AbortSignal;
}

function argsMatch(
  patterns: Readonly<Record<string, string>> | undefined,
  input: Record<string, unknown>,
): boolean {
  if (!patterns) return true;
  for (const [key, source] of Object.entries(patterns)) {
    const value = input[key];
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return false;
    }
    let re: RegExp;
    try {
      re = new RegExp(source);
    } catch {
      return false;
    }
    if (!re.test(String(value))) return false;
  }
  return true;
}

export function createSessionToolHost(options: CreateSessionToolHostOptions): SessionToolHost {
  if (FORBIDDEN_MODES.has(options.permissionMode)) {
    throw new Error(
      `SessionToolHost refuses permission mode '${options.permissionMode}': it short-circuits ` +
        `PermissionClassifier, so CodeShell tool authorization would not actually run. ` +
        `An external runtime's own permission mode is separate and unaffected.`,
    );
  }

  const { registry, exposure } = options;
  const hooks = options.hooks ?? new HookRegistry();
  const permission = new PermissionClassifier([], options.permissionMode, options.approvalBackend);

  const toolCtx = {
    cwd: options.cwd,
    sessionId: options.businessSessionId,
    toolRegistry: registry,
    planMode: options.planMode,
    permissionMode: options.permissionMode,
    signal: options.signal,
    toolVisibility: buildToolVisibility(options.visibility),
    // Belt and braces with the exposure check in execute(): the executor
    // enforces this too, so a future refactor that loses one still fails closed.
    allowedToolNames: new Set(exposure.toolNames),
    ...options.contextOverrides,
  } as unknown as ToolContext;

  const executor = new ToolExecutor(registry, permission, hooks);
  executor.setContext(toolCtx);
  if (options.signal) executor.setSignal(options.signal);

  let disposed = false;

  const failClosed = (id: string, name: string, error: string): ToolResult => ({
    id,
    toolName: name,
    error,
    isError: true,
  });

  return {
    businessSessionId: options.businessSessionId,
    toolContext: toolCtx,

    listTools(): readonly ToolDefinition[] {
      if (disposed) return [];
      return registry
        .getToolDefinitions()
        .filter((definition) => exposure.toolNames.has(definition.name));
    },

    async execute(call, signal): Promise<ToolResult> {
      if (disposed) {
        return failClosed(call.id, call.name, "This tool session has been closed.");
      }
      if (!exposure.toolNames.has(call.name)) {
        // Fail closed on a KNOWN-but-unexposed name too. Not listing a tool is a
        // boundary, not a hint to the model.
        return failClosed(
          call.id,
          call.name,
          `Tool ${call.name} is not exposed to this session. Do NOT retry this tool call.`,
        );
      }
      const input =
        call.input && typeof call.input === "object" && !Array.isArray(call.input)
          ? (call.input as Record<string, unknown>)
          : {};
      if (!argsMatch(exposure.argsPatterns?.get(call.name), input)) {
        return failClosed(
          call.id,
          call.name,
          `Tool ${call.name} was called with arguments outside the scope exposed to this ` +
            `session. Do NOT retry this tool call with the same arguments.`,
        );
      }
      if (signal?.aborted || options.signal?.aborted) {
        return failClosed(call.id, call.name, `Tool aborted before execution: ${call.name}`);
      }

      // The one authorized path. Everything above only NARROWS what may reach it.
      return await executor.executeSingle({
        id: call.id,
        toolName: call.name,
        args: input,
      });
    },

    async dispose(): Promise<void> {
      disposed = true;
      executor.setContext(undefined);
    },
  };
}
