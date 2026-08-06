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
import { composePermissionRules } from "../engine/permission-controller.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "./plan-mode-allowlist.js";

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
   * Each value is a regex source matched against the whole argument value —
   * patterns are anchored for you, see {@link matchesWholeValue}.
   *
   * This binds on `execute()`, not just `listTools()`: describing a limit only in
   * the advertised schema would leave it advisory, and the arguments come from
   * the model.
   *
   * **Scope, stated plainly:** this constrains only the keys it names. Keys the
   * pattern does not mention pass through untouched, so it is a good fit for
   * "which action may run" and a poor one for "what may that action do".
   * Restricting a nested payload (e.g. the arguments a Panel tool forwards to a
   * Panel App) is the tool's own schema validation, not this. Do not treat an
   * `argsPatterns` entry as a sandbox for everything a tool might accept.
   */
  argsPatterns?: ReadonlyMap<
    string,
    Readonly<Record<string, string>> | readonly Readonly<Record<string, string>>[]
  >;
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
  /**
   * The agent preset's permission rules (e.g.
   * `BUILTIN_AGENT_PRESETS.general.defaultPermissionRules`).
   *
   * Only the PRESET layer is supplied here. The rest of the stack — the standing
   * memory-scope carve-outs, mode-derived rules, and the user's own
   * `settings.permissions.rules` — is composed internally by
   * {@link composePermissionRules}, the same function the Native Engine uses.
   *
   * That composition is deliberately not left to the caller. An earlier revision
   * took a finished rule array, which turned an equivalence guarantee into an
   * unenforceable obligation: nothing checked that a caller reproduced
   * `PermissionController.build()`, and the easy mistake — omitting
   * `settings.permissions.rules` — meant a user's explicit "deny this tool" bound
   * the Native Engine but not the external runtime.
   */
  presetRules: readonly import("../types.js").PermissionRule[];
  /** Settings scope used to resolve the user's own permission rules. */
  settingsScope?: import("../settings/manager.js").SettingsScope;
  /**
   * Whether the project at `cwd` has been trusted by the user.
   *
   * **Required, and there is no default** — `permissions` is the first entry in
   * `DANGEROUS_PROJECT_FIELDS`, so an untrusted project's
   * `settings.permissions.rules` are stripped precisely to stop a cloned repo
   * self-authorizing. Every protocol-layer caller resolves this explicitly and
   * defaults it to `false`; an optional field defaulting to "trusted" here would
   * let a hostile repo grant an external runtime tools the user never trusted,
   * without the approval backend ever being consulted.
   *
   * Optional-plus-unsafe-default is the exact shape of the bug this whole
   * options object has now been bitten by twice. Hence: required.
   */
  projectTrusted: boolean;
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

/**
 * Whole-string match for an exposure pattern.
 *
 * Patterns are ANCHORED here rather than trusting the author to write `^…$`.
 * An unanchored `action: "list"` would also admit `"invoke_list"` — a silent
 * widening of a rule whose entire purpose is to narrow. Anchoring in one place
 * makes the safe reading the only reading; an author who deliberately writes
 * `^(list|open)$` gets the same result either way.
 */
function matchesWholeValue(source: string, value: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(`^(?:${source})$`, "u");
  } catch {
    // A malformed pattern must not silently permit everything.
    return false;
  }
  return re.test(value);
}

function argsMatch(
  patterns:
    | Readonly<Record<string, string>>
    | readonly Readonly<Record<string, string>>[]
    | undefined,
  input: Record<string, unknown>,
): boolean {
  if (!patterns) return true;
  const alternatives = Array.isArray(patterns) ? patterns : [patterns];
  return alternatives.some((alternative) => argsPatternMatches(alternative, input));
}

function argsPatternMatches(
  patterns: Readonly<Record<string, string>>,
  input: Record<string, unknown>,
): boolean {
  for (const [key, source] of Object.entries(patterns)) {
    // Read own properties only: a model-supplied JSON body cannot smuggle a
    // match through the prototype chain.
    const value = Object.prototype.hasOwnProperty.call(input, key) ? input[key] : undefined;
    // Only primitives are comparable. Objects/arrays are rejected rather than
    // stringified — `String(["list"])` is `"list"`, which would let an array
    // satisfy a scalar pattern.
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      return false;
    }
    if (!matchesWholeValue(source, String(value))) return false;
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
  // Composed HERE, by the same function the Native Engine uses, so the two paths
  // cannot drift. In particular this is what pulls in the user's own
  // `settings.permissions.rules` — a deny the user wrote must bind an external
  // runtime exactly as it binds the Native Engine.
  const permission = new PermissionClassifier(
    composePermissionRules({
      mode: options.permissionMode,
      cwd: options.cwd,
      presetRules: options.presetRules,
      projectTrusted: options.projectTrusted,
      ...(options.settingsScope ? { settingsScope: options.settingsScope } : {}),
    }),
    options.permissionMode,
    options.approvalBackend,
  );

  // Every in-flight call is chained to this, so dispose() can actually stop work
  // that is mid-execution or parked on an approval prompt (§13.4).
  const lifetime = new AbortController();
  const sessionSignal = options.signal
    ? AbortSignal.any([options.signal, lifetime.signal])
    : lifetime.signal;

  const toolCtx = {
    cwd: options.cwd,
    toolRegistry: registry,
    // The COMBINED signal, not just the caller's: a tool that cooperates with
    // ctx.signal must observe session disposal too.
    signal: sessionSignal,
    // Caller-supplied host seams (panels, browser, askUser, …) come FIRST so the
    // security-relevant fields below always win. Spreading them last would let a
    // caller — or a careless refactor — set `toolVisibility: undefined` (which
    // makes ToolExecutor skip its availability guard entirely), widen
    // `allowedToolNames`, or re-introduce a permission mode the throw above
    // just rejected.
    ...options.contextOverrides,
    sessionId: options.businessSessionId,
    externalRuntime: true,
    planMode: options.planMode,
    permissionMode: options.permissionMode,
    toolVisibility: buildToolVisibility(options.visibility),
    // Belt and braces with the exposure check in execute(): the executor
    // enforces this too, so a future refactor that loses one still fails closed.
    allowedToolNames: new Set(exposure.toolNames),
  } as unknown as ToolContext;

  const executor = new ToolExecutor(registry, permission, hooks);
  executor.setContext(toolCtx);
  executor.setSignal(sessionSignal);

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
        .filter((definition) => exposure.toolNames.has(definition.name))
        .filter((definition) => !options.planMode || PLAN_MODE_ALLOWED_TOOLS.has(definition.name))
        .filter((definition) => {
          const guard = registry.getAvailabilityGuard(definition.name);
          return !guard || guard(toolCtx.toolVisibility!);
        });
    },

    async execute(call, callSignal): Promise<ToolResult> {
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
      // `sessionSignal` folds in the session lifetime and the caller-supplied
      // signal; `callSignal` is the optional per-call one (an MCP cancellation).
      if (sessionSignal.aborted || callSignal?.aborted) {
        return failClosed(call.id, call.name, `Tool aborted before execution: ${call.name}`);
      }

      const emit = async (event: import("../types.js").StreamEvent): Promise<void> => {
        try {
          await toolCtx.streamCallback?.(event);
        } catch {
          // Stream projection is observational; a broken renderer/recorder must
          // not turn an authorized tool execution into an unrelated failure.
        }
      };
      await emit({
        type: "tool_use_start",
        toolCall: { id: call.id, toolName: call.name, args: input },
      });

      // Forward the per-call signal rather than only checking it at entry: an MCP
      // cancellation arriving mid-flight has to actually stop the work.
      //
      // A `ToolExecutor` holds exactly one signal, and swapping it per call would
      // race with concurrent calls carrying different signals. So a call that
      // brings its own signal gets its own executor — cheap (it is a thin wrapper
      // over the shared registry/permission/hooks) and free of shared mutable
      // state. Calls without one use the shared executor unchanged.
      if (!callSignal) {
        // The one authorized path. Everything above only NARROWS what may reach it.
        const result = await executor.executeSingle({
          id: call.id,
          toolName: call.name,
          args: input,
        });
        await emit({ type: "tool_result", result });
        return result;
      }
      const scoped = new ToolExecutor(registry, permission, hooks);
      scoped.setContext(toolCtx);
      scoped.setSignal(AbortSignal.any([sessionSignal, callSignal]));
      const result = await scoped.executeSingle({
        id: call.id,
        toolName: call.name,
        args: input,
      });
      await emit({ type: "tool_result", result });
      return result;
    },

    async dispose(): Promise<void> {
      // Order matters (§13.4): stop accepting new calls, THEN abort in-flight
      // ones. Marking disposed without aborting would let a call that is already
      // running — or parked on an approval prompt — continue and complete after
      // the session is gone.
      disposed = true;
      lifetime.abort();
      executor.setContext(undefined);
    },
  };
}
