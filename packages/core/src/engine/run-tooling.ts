/**
 * Run tooling — per-run tool surface assembly for Engine.runExclusive:
 * ToolContext construction, the permission classifier + executor pipeline,
 * MCP connection, and the per-turn tool-definition visibility pass.
 * The sub-agent spawner and sandbox resolution stay in engine.ts (the
 * `new Engine(` allowlist and RunEnvironmentResolver own them).
 */
import { recordModelTraceEvent } from "../model-traces/context.js";
import { VERSION } from "../version.js";
import type {
  MCPServerConfig,
  PermissionMode,
  SessionToolSelection,
  TaskInfo,
  ToolDefinition,
} from "../types.js";
import type { SettingsScope } from "../settings/manager.js";
import type { ToolContext } from "../tool-system/context.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { InvestigationGuard } from "../tool-system/investigation-guard.js";
import { TaskGuard } from "../tool-system/task-guard.js";
import { PermissionClassifier, InteractiveApprovalBackend } from "../tool-system/permission.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { HookRegistry } from "../hooks/registry.js";
import type { FeatureFlagOverrides } from "../settings/feature-flags.js";
import type { CapabilityOverride } from "../settings/schema.js";
import { buildToolVisibility } from "../tool-system/tool-visibility.js";
import {
  prepareToolPolicySnapshot,
  snapshotMcpToolPolicies,
} from "../tool-system/prepare-tool-policy.js";
import { resolveToolPolicySnapshot } from "../tool-system/tool-policy-snapshot.js";
import type { PermissionController } from "./permission-controller.js";
import type { EngineRunOptions, RunBehaviorProfile } from "./run-types.js";
import { normalizeSessionToolSelection, RunToolSurface } from "../tool-system/run-tool-surface.js";
import { routeInitialTools, type TaskToolRoutingPolicy } from "../preset/task-tool-routing.js";
import { logger } from "../logging/logger.js";
import { canExposeNativeToolDefinition } from "../llm/native-tool-discovery.js";
import { resolvePromptCachePolicy } from "../llm/prompt-cache.js";
import { callToolDef } from "../tool-system/builtin/call-tool.js";
import {
  rebaseToolSelection,
  selectionForToolCacheCycle,
  toolCacheIdleLimitMs,
  toolCacheIdentity,
} from "./tool-cache-cycle.js";

/** Fold once per Run from the unmodified transport baseline; unknown names cannot create servers. */
export function snapshotRunMcpServers(
  baseline: Record<string, MCPServerConfig>,
  overrides?: Record<string, CapabilityOverride>,
): Record<string, MCPServerConfig> {
  return Object.fromEntries(
    Object.entries(baseline).map(([name, config]) => {
      const snapshot = structuredClone(config);
      const override = overrides?.[name];
      if (override === "on" || override === "off") snapshot.enabled = override === "on";
      return [name, snapshot];
    }),
  );
}

/** Keep current eligibility separate from schemas frozen for the cache cycle. */
export function initializeRunToolSurface(
  toolCtx: ToolContext,
  initialToolNames: readonly string[] | undefined,
  assembleCatalog: () => ToolDefinition[],
  routing?: {
    taskText: string;
    policy?: TaskToolRoutingPolicy;
    injected?: boolean;
    selection?: unknown;
    onSelectionChanged?: (selection: SessionToolSelection) => void;
  },
): ToolDefinition[] {
  const toolDiscovery = toolCtx.llmConfig
    ? resolvePromptCachePolicy(toolCtx.llmConfig).toolDiscovery
    : "call-tool";
  // CallTool is a wire adapter, never a product capability or an external Host tool.
  const assembleModelCatalog = () => {
    const definitions = assembleCatalog().map((definition) =>
      toolDiscovery === "tool-reference" && definition.name === "ToolSearch"
        ? {
            ...definition,
            description:
              'Find available tools by keyword, then use "select:ToolName" (or comma-separated names) to load their definitions. ' +
              "Invoke tools returned as native references directly by their exact names with schema-matching arguments. " +
              "For tools returned as full schema text, use CallTool with the exact name and matching args. " +
              "If an exact tool is unavailable, do not retry unless the Session context changes.",
          }
        : definition,
    );
    return definitions.some((tool) => tool.name === "ToolSearch")
      ? [...definitions.filter((tool) => tool.name !== "CallTool"), callToolDef]
      : definitions.filter((tool) => tool.name !== "CallTool");
  };
  const catalog = assembleModelCatalog();
  const identity = toolCacheIdentity(toolCtx.llmConfig);
  let selection = normalizeSessionToolSelection(
    selectionForToolCacheCycle(routing?.selection, identity, {
      now: Date.now(),
      cacheVersion: VERSION,
      idleLimitMs: toolCacheIdleLimitMs(toolCtx.llmConfig),
    }),
  );
  // A legacy selection has no frozen native directory. Its first native request
  // is a cold boundary; an explicitly saved empty directory is already complete.
  // Unsendable legacy declarations could not establish a native cache prefix;
  // migrate them once into portable discoveries instead of repeating API errors.
  if (
    toolDiscovery === "tool-reference" &&
    selection &&
    (selection.deferredDefinitions === undefined ||
      [...(selection.frozenDefinitions ?? []), ...selection.deferredDefinitions].some(
        (definition) => !canExposeNativeToolDefinition(definition),
      ))
  )
    selection = rebaseToolSelection(selection);
  // Unknown future/damaged persisted state must survive without being overwritten.
  const persistSelection =
    routing?.selection !== undefined && !selection
      ? undefined
      : (next: SessionToolSelection) => routing?.onSelectionChanged?.(next);
  const routed =
    selection || routing?.injected
      ? {
          // A host continuation carries results, not a new tool-routing intent.
          initialToolNames: selection && initialToolNames !== undefined ? [] : initialToolNames,
          reason: "no_match" as const,
          matchedRuleIds: [],
        }
      : routeInitialTools({
          initialToolNames,
          eligibleToolNames: catalog.map((tool) => tool.name),
          taskText: routing?.taskText ?? "",
          policy: routing?.policy,
        });
  if (routed.reason === "matched") {
    logger.info("tool.surface.routed", {
      cat: "tool",
      reason: routed.reason,
      ruleIds: routed.matchedRuleIds,
      initialTools: routed.initialToolNames,
      initialCount: routed.initialToolNames?.length ?? 0,
      eligibleCount: catalog.length,
    });
  }
  const surface = new RunToolSurface(
    catalog.some((tool) => tool.name === "ToolSearch") ? routed.initialToolNames : undefined,
    {
      selection:
        selection && (routing?.selection as { version?: unknown })?.version === 1
          ? { ...selection, version: 1 }
          : selection,
      onSelectionChanged: persistSelection,
      cacheVersion: VERSION,
      cacheIdentity: identity,
      toolDiscovery,
      ...(toolDiscovery === "tool-reference"
        ? { canExposeDefinition: canExposeNativeToolDefinition }
        : {}),
    },
  );
  toolCtx.runToolSurface = surface;
  surface.updateCatalog(catalog);
  persistSelection?.(surface.getSelection());
  toolCtx.refreshRunToolEligibility = () => surface.updateCatalog(assembleModelCatalog());
  let previousNames: string[] | undefined;
  toolCtx.refreshRunTools = () => {
    toolCtx.refreshRunToolEligibility!();
    const snapshot = surface.snapshot();
    // Goal/domain state rebases may replace the live Session since selection changed.
    persistSelection?.(surface.getSelection());
    const names = snapshot.map((tool) => tool.name);
    toolCtx.modelToolNames = new Set(names);
    if (JSON.stringify(names) !== JSON.stringify(previousNames)) {
      logger.info("tool.surface.changed", {
        cat: "tool",
        reason: previousNames ? "selection_or_eligibility_change" : "initial",
        activeTools: names,
        eligibleCount: surface.getCatalog().length,
      });
      previousNames = names;
    }
    return surface.requestSnapshot();
  };
  return surface.snapshot();
}

/** engine.ts L1485-1522 —— ToolContext 组装(spawner、agentDefinitions、base 由调用方传入)。 */
export function buildRunToolContext(args: {
  base: ToolContext; // this.buildToolContext(cwd, sessionProfileOverrides, profileMemoryDir)
  options: EngineRunOptions | undefined;
  configApprovalRouter: ToolContext["approvalRouter"];
  runPermissionMode: ToolContext["permissionMode"];
  runPlanMode: boolean;
  subAgentSpawner: ToolContext["subAgentSpawner"];
  agentDefinitions: ToolContext["agentDefinitions"];
  sandbox: ToolContext["sandbox"]; // engine 已完成 network 贴附的 backend(或 off)
  cwd: string;
  workspace: ToolContext["workspace"];
  shellEnv: ToolContext["shellEnv"];
  profile: RunBehaviorProfile | undefined;
  profileParams: Readonly<Record<string, unknown>>;
  reportResult: (key: string, value: unknown) => void;
}): ToolContext {
  const { options, profile, profileParams } = args;
  const pendingRunYield = new Set<import("../tool-system/context.js").ToolRunYieldReason>();
  // sessionId is filled in after the session bundle is resolved below
  // (the session may be cold-started or resumed). Until then this is
  // intentionally shaped as a mutable local; we treat it as immutable
  // after the assignment.
  const toolCtx: ToolContext = {
    ...args.base,
    approvalRouter: options?.approvalRouter ?? args.configApprovalRouter,
    permissionMode: args.runPermissionMode,
    allowBackgroundShells:
      args.base.allowBackgroundShells !== false && options?.allowBackgroundShells !== false,
    signal: options?.signal,
    planMode: args.runPlanMode,
    subAgentSpawner: args.subAgentSpawner,
    agentDefinitions: args.agentDefinitions,
    // Stamp the resolved network policy onto the backend the tools see so
    // Bash can surface "网络 deny" on its result. Shallow-copy (don't mutate
    // the cached backend) — `wrap`/`hintForBlockedOutput` are plain function
    // properties and survive the spread. Off keeps network undefined.
    sandbox: args.sandbox,
    cwd: args.cwd,
    workspace: args.workspace,
    shellEnv: args.shellEnv,
    // TodoWrite reads this to push task_update events independently
    // of its return value, so the UI's pinned task panel refreshes
    // immediately rather than after the LLM next surfaces the
    // snapshot. wrappedOnStream snoops the same channel to keep
    // latestTodos current for TaskGuard.
    streamCallback: options?.onStream,
    setCwd(nextCwd: string) {
      toolCtx.cwd = nextCwd;
    },
    runYield: {
      // Reasons accumulate independently — a batch may both commit a host
      // reply and launch background work; the turn loop decides precedence.
      request(reason) {
        pendingRunYield.add(reason);
      },
      peek(reason) {
        return pendingRunYield.has(reason);
      },
      consume(reason) {
        return pendingRunYield.delete(reason);
      },
    },
    skillAllowlist:
      options?.skillAllowlist !== undefined
        ? [...options.skillAllowlist]
        : args.base.skillAllowlist,
  };
  if (options?.toolAllowlist !== undefined) {
    toolCtx.allowedToolNames = new Set(options.toolAllowlist);
  } else if (profile?.allowedToolNames) {
    toolCtx.allowedToolNames = profile.allowedToolNames;
  }
  if (profile?.createRunServices) {
    toolCtx.runScopedServices = profile.createRunServices({
      profileParams,
      reportResult: (key, value) => {
        args.reportResult(key, value);
      },
    });
  }
  return toolCtx;
}

/** engine.ts L1876-1933 —— 权限分类器 + 审批监听 + ToolExecutor + guards。 */
export function buildRunPermissionPipeline(args: {
  permissionController: PermissionController;
  mode: PermissionMode;
  cwd: string;
  approvalRouter: ToolContext["approvalRouter"];
  sessionId: string;
  toolRegistry: ToolRegistry;
  hooks: HookRegistry;
  toolCtx: ToolContext;
  signal: AbortSignal | undefined;
  readOnlySession: boolean;
  headless: boolean;
  getLatestTodos: () => TaskInfo[];
  onApprovalPhase: (waiting: boolean, toolName: string | undefined) => void;
}): { permission: PermissionClassifier; toolExecutor: ToolExecutor } {
  const mode = args.mode;
  const { rules: defaultRules, backend: approvalBackend } = args.permissionController.build(
    mode,
    args.cwd,
    args.approvalRouter,
  );

  const permission = new PermissionClassifier(defaultRules, mode, approvalBackend);
  permission.setApprovalStateListener((waiting, toolName) => {
    args.onApprovalPhase(waiting, toolName);
  });
  // Approval waits are traced here. The `notification` hook for them is
  // emitted where the user-facing decision is registered (protocol
  // decision-notification-hooks.ts), which also knows the request id.
  const approvalSpans = new Map<string, number>();
  permission.setApprovalEventListener((event) => {
    const startedAt =
      event.phase === "requested" ? Date.now() : approvalSpans.get(event.observationId);
    if (event.phase === "requested" && startedAt !== undefined)
      approvalSpans.set(event.observationId, startedAt);
    if (event.phase === "resolved") approvalSpans.delete(event.observationId);
    if (startedAt !== undefined)
      recordModelTraceEvent({
        id: event.observationId,
        startedAt,
        kind: "approval",
        name: event.toolName,
        sessionId: args.sessionId,
        status:
          event.phase === "requested"
            ? "waiting"
            : event.error
              ? "failed"
              : event.approved
                ? "approved"
                : "rejected",
        ...(event.phase === "requested" ? { first: true } : {}),
        ...(event.phase === "resolved" ? { endedAt: Date.now() } : {}),
        input: { riskLevel: event.riskLevel },
        error: event.error,
        ...(event.approved !== undefined ? { output: { approved: event.approved } } : {}),
      });
  });
  args.permissionController.attach(permission, args.approvalRouter);

  // If the backend is the interactive one, wire it for project-scope
  // persistence: it needs cwd to find settings.local.json, and a callback
  // to apply newly-saved rules to the live classifier so subsequent calls
  // in this same session don't re-prompt. Headless/auto backends skip
  // this — they don't prompt, so there are no project rules to persist.
  if (approvalBackend instanceof InteractiveApprovalBackend) {
    approvalBackend.setSessionContext(args.sessionId, {
      cwd: args.cwd,
      onProjectRules: (rules) => {
        // Prepend the *full* accumulated list of session-saved project rules
        // so user approvals win over defaults and earlier approvals aren't
        // dropped when later ones come in.
        permission.reconfigure(mode, approvalBackend, [...rules, ...defaultRules]);
      },
    });
  }

  const toolExecutor = new ToolExecutor(args.toolRegistry, permission, args.hooks);
  const investigationGuard = new InvestigationGuard();
  if (args.readOnlySession) {
    investigationGuard.setPolicy("read-only-review");
  } else if (args.headless) {
    investigationGuard.setSoftMode(true);
  }
  toolExecutor.setInvestigationGuard(investigationGuard);
  toolExecutor.setTaskGuard(new TaskGuard(() => args.getLatestTodos()));

  // Wire abort signal for cascading cancellation + per-Engine ToolContext
  toolExecutor.setSignal(args.signal);
  toolExecutor.setContext(args.toolCtx);

  return { permission, toolExecutor };
}

/** engine.ts L1986-2003 —— MCP 连接(Runtime 池优先,回退 per-Engine)。 */
export async function connectRunMcp(args: {
  mcpServers: Record<string, MCPServerConfig>;
  mcpDisabled: boolean;
  getManager: () => MCPManager | undefined;
  setManager: (manager: MCPManager) => void;
  runtimePool: MCPManager | undefined;
  toolRegistry: ToolRegistry;
  engineForConnect: Parameters<MCPManager["connectAll"]>[1];
  toolContext?: Parameters<MCPManager["connectAll"]>[3] &
    Pick<ToolContext, "mcpServerFailures" | "allowedMcpServers">;
  emitNotificationHook: (payload: Record<string, unknown>) => void;
  retainRun?: (release: () => Promise<void>) => void;
}): Promise<ReadonlyMap<string, string>> {
  const failures = new Map<string, string>();
  if (args.toolContext) args.toolContext.mcpServerFailures = failures;
  // A pool may outlive a run and the engine registry may predate discovery.
  // Refresh scope and the engine's MCP-only view on every run (including cwd
  // and project changes); identical scopes still share a single transport.
  const enabledServers = args.mcpDisabled ? {} : args.mcpServers;
  if (!args.getManager() && Object.keys(enabledServers).length > 0) {
    args.setManager(args.runtimePool ?? new MCPManager(args.toolRegistry));
  }
  const manager = args.getManager();
  if (!manager) return failures;
  if (args.toolContext && args.retainRun)
    args.retainRun(() => manager.releaseRun(args.toolContext!));
  await manager.connectAll(
    enabledServers,
    args.engineForConnect,
    (event) => {
      if (
        event.type === "mcp_server_failed" &&
        (!args.toolContext?.allowedMcpServers ||
          args.toolContext.allowedMcpServers.has(event.server))
      ) {
        failures.set(event.server, event.error ?? "Initialization failed.");
      }
      args.emitNotificationHook({
        kind: event.type,
        server: event.server,
        ...(event.error ? { error: event.error } : {}),
      });
    },
    args.toolContext,
    args.retainRun !== undefined,
  );
  manager.syncToolsToRegistry(
    args.toolRegistry,
    args.toolContext,
    new Set(
      Object.entries(enabledServers)
        .filter(([, config]) => config.enabled !== false)
        .map(([name]) => name),
    ),
  );
  return failures;
}

/**
 * Inputs to {@link buildToolVisibility}. This is the whole set of run state that
 * a tool-availability guard is allowed to branch on — naming it keeps the
 * contract explicit for callers that assemble a tool surface WITHOUT an Engine
 * run (e.g. a session-scoped host exposing tools to an external Agent Runtime).
 */
export { buildToolVisibility, type ToolVisibilityInputs } from "../tool-system/tool-visibility.js";

/** Prepare shared eligibility data, then write native per-run execution context explicitly. */
export function assembleRunToolDefs(args: {
  toolRegistry: ToolRegistry;
  toolCtx: ToolContext;
  guardCwd: string;
  hasRunnableGoal: boolean;
  settingsScope: SettingsScope;
  builtinToolHost: string | undefined;
  isSubAgent: boolean;
  behaviorProfileId: string | undefined;
  profileMeta: Record<string, unknown> | undefined;
  builtinOverride: Record<string, CapabilityOverride> | undefined;
  mcpServers: Record<string, MCPServerConfig>;
  mcpDisabled: boolean;
  featureFlags: FeatureFlagOverrides | undefined;
  profileAllowedToolNames: ReadonlySet<string> | undefined;
  runPlanMode: boolean;
}): ToolDefinition[] {
  const { toolCtx } = args;
  const visibility = buildToolVisibility({
    cwd: args.guardCwd,
    contextStrategy: toolCtx.contextNotes ? toolCtx.contextStrategy : undefined,
    workspace: toolCtx.workspace,
    hasGoal: args.hasRunnableGoal,
    sessionId: toolCtx.sessionId,
    settingsScope: args.settingsScope,
    host: args.builtinToolHost,
    hasBrowserAutomation: toolCtx.browser !== undefined,
    isSubAgent: args.isSubAgent,
    rootSessionId: toolCtx.rootSessionId,
    behaviorProfile: args.behaviorProfileId,
    sessionMessageTargets: toolCtx.sessionMessages?.targets,
    profileMeta: args.profileMeta,
  });
  const registryNames = new Set(args.toolRegistry.getToolDefinitions().map((tool) => tool.name));
  const disabledBuiltinNames = Object.entries(args.builtinOverride ?? {})
    .filter(([name, state]) => state === "off" && registryNames.has(name))
    .map(([name]) => name);
  const snapshot = prepareToolPolicySnapshot({
    registry: args.toolRegistry,
    visibility,
    disabledBuiltinNames,
    allowedToolNames: args.profileAllowedToolNames,
    mcpServers: args.mcpServers,
    mcpDisabled: args.mcpDisabled,
    featureFlags: args.featureFlags,
    agentDefinitions: toolCtx.agentDefinitions,
    planMode: args.runPlanMode,
  });
  const definitions = resolveToolPolicySnapshot(snapshot);
  toolCtx.toolVisibility = visibility;
  toolCtx.disabledBuiltins = args.builtinOverride
    ? new Set(snapshot.disabledBuiltinNames)
    : undefined;
  toolCtx.allowedMcpServers = new Set(snapshot.allowedMcpServers);
  toolCtx.mcpToolPolicies = snapshotMcpToolPolicies(snapshot);
  toolCtx.searchableToolDefinitions = definitions;
  return definitions;
}
