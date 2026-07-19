/**
 * Run tooling — per-run tool surface assembly for Engine.runExclusive:
 * ToolContext construction, the permission classifier + executor pipeline,
 * MCP connection, and the per-turn tool-definition visibility pass.
 * The sub-agent spawner and sandbox resolution stay in engine.ts (the
 * `new Engine(` allowlist and RunEnvironmentResolver own them).
 */
import type { MCPServerConfig, PermissionMode, TaskInfo, ToolDefinition } from "../types.js";
import type { SettingsScope } from "../settings/manager.js";
import type { ToolContext } from "../tool-system/context.js";
import type { BuiltinToolExposure, BuiltinToolGuard } from "../tool-system/builtin/index.js";
import { ToolExecutor } from "../tool-system/executor.js";
import { InvestigationGuard } from "../tool-system/investigation-guard.js";
import { TaskGuard } from "../tool-system/task-guard.js";
import { PermissionClassifier, InteractiveApprovalBackend } from "../tool-system/permission.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import {
  buildMcpToolPolicies,
  isRegisteredMcpToolAllowed,
} from "../tool-system/mcp-tool-policy.js";
import type { ToolRegistry } from "../tool-system/registry.js";
import type { HookRegistry } from "../hooks/registry.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "../tool-system/plan-mode-allowlist.js";
import { isFeatureEnabled, type FeatureFlagName } from "../settings/feature-flags.js";
import type { CapabilityOverride } from "../settings/schema.js";
import { applyDynamicToolDef } from "./dynamic-tool-defs.js";
import type { PermissionController } from "./permission-controller.js";
import type { EngineRunOptions, RunBehaviorProfile } from "./run-types.js";

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
  shellEnv: ToolContext["shellEnv"];
  profile: RunBehaviorProfile | undefined;
  profileParams: Readonly<Record<string, unknown>>;
  reportResult: (key: string, value: unknown) => void;
}): ToolContext {
  const { options, profile, profileParams } = args;
  // sessionId is filled in after the session bundle is resolved below
  // (the session may be cold-started or resumed). Until then this is
  // intentionally shaped as a mutable local; we treat it as immutable
  // after the assignment.
  const toolCtx: ToolContext = {
    ...args.base,
    approvalRouter: options?.approvalRouter ?? args.configApprovalRouter,
    permissionMode: args.runPermissionMode,
    planMode: args.runPlanMode,
    subAgentSpawner: args.subAgentSpawner,
    agentDefinitions: args.agentDefinitions,
    // Stamp the resolved network policy onto the backend the tools see so
    // Bash can surface "网络 deny" on its result. Shallow-copy (don't mutate
    // the cached backend) — `wrap`/`hintForBlockedOutput` are plain function
    // properties and survive the spread. Off keeps network undefined.
    sandbox: args.sandbox,
    cwd: args.cwd,
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
  };
  if (profile?.allowedToolNames) {
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
  emitNotificationHook: (payload: Record<string, unknown>) => void;
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
  // Surface approval waits on the notification hook (fire-and-forget, like
  // background-agent terminal states) so plugins / settings hooks can ping
  // the user while a decision is pending.
  permission.setApprovalEventListener((event) => {
    args.emitNotificationHook({
      kind: event.phase === "requested" ? "approval_requested" : "approval_resolved",
      toolName: event.toolName,
      riskLevel: event.riskLevel,
      ...(event.approved !== undefined ? { approved: event.approved } : {}),
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
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
  emitNotificationHook: (payload: Record<string, unknown>) => void;
}): Promise<void> {
  // Connect MCP servers (if configured and not already connected).
  // B1: prefer the Runtime-owned MCPManager so all sessions in a
  // worker share one set of connections. Falling back to a
  // per-Engine instance keeps the null-runtime path (tests, ad-hoc
  // scripts) working.
  const mcpServers = args.mcpServers;
  const mcpDisabled = args.mcpDisabled;
  if (!mcpDisabled && Object.keys(mcpServers).length > 0 && !args.getManager()) {
    if (args.runtimePool) {
      args.setManager(args.runtimePool);
    } else {
      args.setManager(new MCPManager(args.toolRegistry));
    }
    await args.getManager()!.connectAll(mcpServers, args.engineForConnect, (event) => {
      // Fire-and-forget onto the notification hook: hosts/plugins learn
      // about MCP availability changes without polling the pool.
      args.emitNotificationHook({
        kind: event.type,
        server: event.server,
        ...(event.error ? { error: event.error } : {}),
      });
    });
  }
}

/** engine.ts L2023-2145 —— builtin override / MCP 可见性 / feature flags / 动态 defs / plan-mode 过滤。
 *  注意:本函数按原逻辑就地 mutate toolCtx(toolVisibility/disabledBuiltins/
 *  allowedMcpServers/mcpToolPolicies)。 */
export function assembleRunToolDefs(args: {
  toolRegistry: ToolRegistry;
  toolCtx: ToolContext;
  guardCwd: string;
  hasRunnableGoal: boolean;
  settingsScope: SettingsScope;
  builtinToolHost: string | undefined;
  isSubAgent: boolean;
  behaviorProfileId: string | undefined;
  profileMeta: Record<string, unknown> | undefined; // profile?.buildVisibilityMeta?.(profileParams)
  builtinOverride: Record<string, CapabilityOverride> | undefined;
  mcpServers: Record<string, MCPServerConfig>;
  mcpDisabled: boolean;
  featureFlags: Parameters<typeof isFeatureEnabled>[0];
  toolGuards: ReadonlyMap<string, BuiltinToolGuard>;
  toolRewriters: ReadonlyMap<string, NonNullable<BuiltinToolExposure["rewriteDefinition"]>>;
  toolFeatureFlags: ReadonlyMap<string, FeatureFlagName>;
  applyBuiltinOverrideVisibility: <T extends { name: string }>(
    tools: T[],
    override: Record<string, CapabilityOverride> | undefined,
  ) => T[];
  profileAllowedToolNames: ReadonlySet<string> | undefined;
  runPlanMode: boolean;
}): ToolDefinition[] {
  const { toolCtx } = args;
  const guardCwd = args.guardCwd;
  const profileMeta = args.profileMeta;
  const toolVisibility = {
    cwd: guardCwd,
    hasGoal: args.hasRunnableGoal,
    settingsScope: args.settingsScope,
    host: args.builtinToolHost,
    isSubAgent: args.isSubAgent,
    behaviorProfile: args.behaviorProfileId,
    ...(toolCtx.sessionMessages?.targets.length
      ? { sessionMessageTargets: toolCtx.sessionMessages.targets }
      : {}),
    ...(profileMeta ? { profileMeta } : {}),
  };
  toolCtx.toolVisibility = toolVisibility;
  // #7: per-turn project builtin override. The toolRegistry's builtin tool
  // SET is ctor-frozen (and may be shared via runtime), so a mid-session
  // project override of a builtin can't rebuild the registry. But the tool
  // LIST handed to the LLM is assembled fresh every turn, so we apply the
  // override here: a builtin marked `off` for this cwd is HIDDEN from the
  // turn's tool list (matching how skills/plugins/agents `off` apply
  // mid-session via readDisabledLists). `on`/`inherit` keep whatever the
  // registry already has — we can't re-add a tool the frozen registry omits,
  // but `on` for a tool already present is a no-op (it stays). This makes a
  // builtin toggle take effect on the NEXT message, like other capability
  // kinds, without touching the registry.
  const builtinOverride = args.builtinOverride;
  // Turn `off` from a prompt-visibility filter into a real execution gate:
  // collect the builtin tool names the override marks `off` and hand them to
  // the executor (via the shared toolCtx the executor already holds a
  // reference to, set at setContext above) so it rejects a call to a hidden
  // builtin instead of running it from the still-populated registry.
  if (builtinOverride) {
    const registryNames = new Set(args.toolRegistry.getToolDefinitions().map((t) => t.name));
    const disabledBuiltins = new Set(
      Object.keys(builtinOverride).filter(
        (name) => builtinOverride[name] === "off" && registryNames.has(name),
      ),
    );
    toolCtx.disabledBuiltins = disabledBuiltins;
  }
  // MCP tool exposure is per-SESSION even though the pool/registry are
  // worker-shared (B1): a server connected by another project's session
  // registers its tools into the SHARED registry, and without this filter
  // they leaked into every session (e.g. chrome-devtools tools showing up
  // in a project that never enabled the plugin). Keep an MCP tool only when
  // its server is in THIS session's merged config.mcpServers — which
  // already folds the project's capabilityOverrides. Gated on the config
  // being present: engines without one (sub-agents, bare tests) have no
  // MCP tools in their private registries anyway.
  const allowedMcpServers = new Set(
    args.mcpDisabled
      ? []
      : Object.entries(args.mcpServers)
          .filter(([, c]) => c.enabled !== false)
          .map(([n]) => n),
  );
  toolCtx.allowedMcpServers = allowedMcpServers;
  const mcpToolPolicies = buildMcpToolPolicies(args.mcpServers);
  toolCtx.mcpToolPolicies = mcpToolPolicies;
  const mcpVisible = (toolName: string): boolean => {
    const reg = args.toolRegistry.getTool(toolName) as {
      source?: string;
      serverName?: string;
      mcpToolName?: string;
    } | null;
    return (
      reg?.source !== "mcp" ||
      (allowedMcpServers.has(reg?.serverName ?? "") &&
        isRegisteredMcpToolAllowed(
          {
            source: "mcp",
            serverName: reg?.serverName,
            mcpToolName: reg?.mcpToolName,
          },
          mcpToolPolicies,
        ))
    );
  };
  // Feature-flag visibility: a builtin mapped in TOOL_FEATURE_FLAGS is
  // hidden when its flag resolves to false (default-on flags only hide when
  // explicitly disabled, so zero regression out of the box). Read once per
  // turn so flipping a flag in settings takes effect on the NEXT message,
  // like the other capability kinds.
  const featureFlags = args.featureFlags;
  const allToolDefs = args
    .applyBuiltinOverrideVisibility(args.toolRegistry.getToolDefinitions(), builtinOverride)
    .filter((t) => mcpVisible(t.name))
    .filter((t) => {
      const guard = args.toolGuards.get(t.name);
      return guard ? guard(toolVisibility) : true;
    })
    .filter((t) => {
      const flag = args.toolFeatureFlags.get(t.name);
      return flag ? isFeatureEnabled(featureFlags, flag) : true;
    })
    // Dynamic per-engine bits the static defs can't carry: the Agent tool's
    // agent_type enum + listing, and the image/video provider names. See
    // applyDynamicToolDef — forwarding only the Agent description (dropping
    // its rebuilt inputSchema) used to strip the agent_type enum, so the
    // model omitted agent_type and configured roles never applied.
    // A builtin's own exposure.rewriteDefinition (run-scoped rewrites like
    // DelegateWork's closed workspace enum) applies first.
    .map((t) => {
      const rewrite = args.toolRewriters.get(t.name);
      return applyDynamicToolDef(
        rewrite ? rewrite(t, toolVisibility) : t,
        toolCtx.agentDefinitions,
        guardCwd,
      );
    });

  // In plan mode, only expose read-only/planning tools so the model won't
  // attempt writes. Shared with executor.ts's execution gate via
  // PLAN_MODE_ALLOWED_TOOLS so what the model SEES and what the executor
  // RUNS can't drift apart. (Bash is in the set; the executor additionally
  // gates Bash to read-only commands at call time.)
  const profileAllowedToolNames = args.profileAllowedToolNames;
  const profileToolDefs = profileAllowedToolNames
    ? allToolDefs.filter((tool) => profileAllowedToolNames.has(tool.name))
    : allToolDefs;
  const toolDefs = args.runPlanMode
    ? profileToolDefs.filter((t) => PLAN_MODE_ALLOWED_TOOLS.has(t.name))
    : profileToolDefs;
  return toolDefs;
}
