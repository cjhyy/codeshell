import type { LLMConfig, StreamCallback, StreamEvent } from "../types.js";
import type { AgentPresetName } from "../preset/index.js";
import type { ModelPool } from "../llm/model-pool.js";
import type { SubAgentSpawner } from "../tool-system/context.js";
import type { EngineConfig } from "./types.js";
import type { ChildEngineRunner } from "./run-types.js";
import {
  defaultSandboxConfig,
  type SandboxConfig,
  type SandboxMode,
} from "../tool-system/sandbox/index.js";
import type { MCPServerConfig } from "../types.js";

export const NESTED_AGENT_TOOLS = ["Agent", "AgentStatus", "AgentCancel", "AgentSendInput"];

export function resolveChildLlm(
  modelKey: string | undefined,
  pool: ModelPool | undefined,
  parentLlm: LLMConfig,
): LLMConfig {
  if (modelKey && pool?.has(modelKey)) {
    const resolved = pool.resolveLLMConfig(modelKey);
    if (resolved) return resolved;
  }
  return parentLlm;
}

export function resolveChildToolScope(
  allowlist: string[] | undefined,
  parentDisabled: string[] | undefined,
  parentEnabled: string[] | undefined,
): { enabled?: string[]; disabled: string[] } {
  if (allowlist) {
    return {
      enabled: allowlist.filter((tool) => !NESTED_AGENT_TOOLS.includes(tool)),
      disabled: [...NESTED_AGENT_TOOLS],
    };
  }
  return {
    enabled: parentEnabled?.filter((tool) => !NESTED_AGENT_TOOLS.includes(tool)),
    disabled: Array.from(new Set([...(parentDisabled ?? []), ...NESTED_AGENT_TOOLS])),
  };
}

export function resolveChildSandbox(
  mode: SandboxMode | undefined,
  parent: SandboxConfig | undefined,
): SandboxConfig | undefined {
  if (mode === undefined) return parent;
  return { ...defaultSandboxConfig(mode), ...parent, mode };
}

export function resolveChildMcpServers(
  allowlist: string[] | undefined,
  parent: Record<string, MCPServerConfig> | undefined,
): Record<string, MCPServerConfig> | undefined {
  if (allowlist === undefined) return parent;
  const allowed = new Set(allowlist);
  return Object.fromEntries(Object.entries(parent ?? {}).filter(([name]) => allowed.has(name)));
}

export function wrapChildStream(
  destination: StreamCallback | undefined,
  agentId: string,
): StreamCallback | undefined {
  if (!destination) return undefined;
  return (event) => {
    if (
      event.type === "usage_update" ||
      event.type === "session_started" ||
      event.type === "context_compact"
    ) {
      return;
    }
    destination({ ...event, agentId } as StreamEvent);
  };
}

export interface CreateSubAgentSpawnerDeps {
  parentConfig: EngineConfig;
  presetName: AgentPresetName;
  cwd: string;
  permissionMode: NonNullable<EngineConfig["permissionMode"]>;
  modelPool?: ModelPool;
  appendParentSubagent: (agentId: string, description: string) => void;
  sessionExists: (sessionId: string) => boolean;
  childRunner: ChildEngineRunner;
  parentStream?: StreamCallback;
}

export function createSubAgentSpawner(deps: CreateSubAgentSpawnerDeps): SubAgentSpawner {
  return {
    parentStream: deps.parentStream,
    describe: () => ({
      cwd: deps.cwd,
      preset: deps.presetName,
      permissionMode: deps.permissionMode,
    }),
    sessionExists: deps.sessionExists,
    spawn: async (request) => {
      if (!request.resumeSessionId) {
        try {
          deps.appendParentSubagent(request.agentId, request.description);
        } catch {
          // Parent anchors are best-effort and must never block a child run.
        }
      }

      const scope = resolveChildToolScope(
        request.toolAllowlist,
        deps.parentConfig.disabledBuiltinTools,
        deps.parentConfig.enabledBuiltinTools,
      );
      const childConfig: EngineConfig = {
        llm: resolveChildLlm(request.model, deps.modelPool, deps.parentConfig.llm),
        clientDefaults: {
          ...(deps.parentConfig.clientDefaults ?? {}),
          retryMaxAttempts: 2,
        },
        cwd: deps.cwd,
        permissionMode: deps.permissionMode,
        preset: deps.presetName,
        enabledBuiltinTools: scope.enabled,
        disabledBuiltinTools: scope.disabled,
        builtinToolHost: deps.parentConfig.builtinToolHost,
        customSystemPrompt: deps.parentConfig.customSystemPrompt,
        appendSystemPrompt:
          [deps.parentConfig.appendSystemPrompt, request.appendSystemPrompt]
            .filter(Boolean)
            .join("\n\n") || undefined,
        responseLanguage: deps.parentConfig.responseLanguage,
        userProfile: deps.parentConfig.userProfile,
        instructions: deps.parentConfig.instructions,
        maxTurns: request.maxTurns,
        maxContextTokens: deps.parentConfig.maxContextTokens ?? 200_000,
        sessionStorageDir: deps.parentConfig.sessionStorageDir,
        headless: deps.parentConfig.headless,
        readOnlySession: request.readOnlySession,
        skillAllowlist: request.skillAllowlist,
        sandbox: resolveChildSandbox(request.sandboxMode, deps.parentConfig.sandbox),
        mcpServers: resolveChildMcpServers(request.mcpAllowlist, deps.parentConfig.mcpServers),
        settingsScope: deps.parentConfig.settingsScope ?? "project",
        isSubAgent: true,
      };
      const destination = request.streamOverride ?? deps.parentStream;
      const childSessionId = request.resumeSessionId ?? request.agentId;
      const result = await deps.childRunner.runChild(childConfig, request.prompt, {
        signal: request.signal,
        onStream: wrapChildStream(destination, request.agentId),
        sessionId: childSessionId,
      });
      return result;
    },
  };
}
