import type {
  BuiltinTool,
  ToolContext,
  ToolVisibilityInputs,
} from "@cjhyy/code-shell-core/extension";
import { FIRST_PHASE_EXPOSURE } from "@cjhyy/code-shell-core/extension";
import {
  BUILTIN_AGENT_PRESETS,
  BUILTIN_TOOLS,
  ToolRegistry,
  type GoalConfig,
  type PermissionMode,
} from "@cjhyy/code-shell-core";
import { CODING_TOOLS } from "@cjhyy/code-shell-capability-coding/capability";
import { claudePermissionModeFor } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { EXTERNAL_GOAL_TOOLS } from "./external-runtime-goals.js";
import {
  registerExternalMimiTools,
  type ExternalRuntimeMimiHost,
} from "./external-runtime-mimi-tools.js";

/** Main-owned restriction for a capability's external runtime. Never accepted over IPC. */
export interface ExternalRuntimeToolProfile {
  id: string;
  catalog: readonly BuiltinTool[];
  instructions: string;
  context: Partial<ToolContext>;
  services(): ToolContext["runScopedServices"];
  visibility(): Pick<ToolVisibilityInputs, "behaviorProfile" | "profileMeta">;
  /** Opt into the existing reviewed Host controller contracts. */
  mimiHost?: boolean;
  readOnly?: boolean;
  disableMemory?: boolean;
  sessionKind?: string;
  maxToolCalls?: number;
}

/** Compose one capability's catalog, reviewed exposure and matching tool grants together. */
export function createExternalRuntimeToolSurface(options: {
  toolProfile?: ExternalRuntimeToolProfile;
  hostToolsEnabled: boolean;
  planMode: boolean;
  sessionId: string;
  mimiHost(): ExternalRuntimeMimiHost | undefined;
  readGoal(): GoalConfig | undefined;
  assertActive(): void;
}) {
  const { toolProfile, hostToolsEnabled, planMode } = options;
  const goalToolsAvailable = hostToolsEnabled && !planMode && !toolProfile;
  if (toolProfile && !hostToolsEnabled)
    throw new Error("External chat requires CodeShell Host tools. Enable external_host_tools.");
  // The registry must actually CONTAIN the tools the exposure policy allows.
  // `new ToolRegistry({})` registers none, which would make the allowlist
  // moot in the quietest possible way: `listTools()` returns [], the runtime
  // advertises nothing, and it looks like the policy denied everything.
  // The registry contains the full catalog. SessionToolHost intersects it
  // with the reviewed exposure policy and the current capability settings;
  // registration alone never grants external access.
  const registry = new ToolRegistry({
    toolCatalog: toolProfile?.catalog ?? [...BUILTIN_TOOLS, ...CODING_TOOLS],
  });
  // Plan mode blocks them (not in PLAN_MODE_ALLOWED_TOOLS), so neither tools nor guidance.
  // Known limitation: read once per start, so a runtime started before Main's
  // notice wiring exists has no NotifyMe until it restarts.
  const mimiHost = hostToolsEnabled && !planMode && !toolProfile ? options.mimiHost() : undefined;
  const mimiTools = mimiHost
    ? registerExternalMimiTools(registry, {
        sessionId: options.sessionId,
        host: mimiHost,
        readGoal: options.readGoal,
        assertActive: options.assertActive,
      })
    : [];
  // Host tools are gated by their OWN flag, so the runtime can be trialled with
  // no tool surface at all (§20). An empty allowlist is the honest expression of
  // "off" — the bridge still exists, it just advertises nothing.
  const exposure = toolProfile
    ? {
        mode: "allowlist" as const,
        toolNames: new Set(toolProfile.catalog.map((tool) => tool.definition.name)),
      }
    : hostToolsEnabled
      ? {
          ...FIRST_PHASE_EXPOSURE,
          toolNames: new Set([
            ...FIRST_PHASE_EXPOSURE.toolNames,
            ...(goalToolsAvailable ? EXTERNAL_GOAL_TOOLS : []),
            ...mimiTools,
          ]),
        }
      : { mode: "allowlist" as const, toolNames: new Set<string>() };
  const presetRules = [
    ...BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
    // Goal controllers and Mimi tools need no approval; exposure still gates them.
    ...[
      ...EXTERNAL_GOAL_TOOLS,
      ...mimiTools,
      ...(toolProfile?.catalog.map((tool) => tool.definition.name) ?? []),
    ].map((tool) => ({ tool, decision: "allow" as const })),
  ];
  return { registry, exposure, mimiTools, goalToolsAvailable, presetRules };
}

/** Apply capability restrictions without conflating Host and provider-native permissions. */
export function externalRuntimePermissionPolicy(request: {
  permissionMode?: PermissionMode;
  planMode?: boolean;
  toolProfile?: ExternalRuntimeToolProfile;
}) {
  const fullAccess = request.permissionMode === "bypassPermissions";
  // Keep host tool deny rules and exposure checks while honoring the user's
  // full-access selection for file paths and tool approval requests.
  const hostPermissionMode =
    request.permissionMode === "acceptEdits" || fullAccess
      ? ("acceptEdits" as const)
      : ("default" as const);
  const sandbox =
    request.planMode || request.toolProfile?.readOnly
      ? "read-only"
      : fullAccess
        ? "danger-full-access"
        : "workspace-write";
  const approvalPolicy =
    fullAccess || request.permissionMode === "dontAsk" ? "never" : "on-request";
  // Claude Code's NATIVE tools follow the user's selection directly; host tools
  // keep hostPermissionMode above. Plan → plan, full access → bypassPermissions,
  // and nothing else escalates.
  const claudePermissionMode = claudePermissionModeFor({
    permissionMode: request.permissionMode,
    planMode: request.planMode === true,
  });
  return { fullAccess, hostPermissionMode, sandbox, approvalPolicy, claudePermissionMode };
}
