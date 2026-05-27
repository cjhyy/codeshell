/**
 * `run` command — headless single-prompt execution.
 *
 * Uses the same Engine → AgentServer → AgentClient pipeline,
 * but with a headless renderer instead of Ink UI.
 */

import { randomUUID } from "node:crypto";
import { Engine } from "@cjhyy/code-shell-core";
import { EngineRuntime } from "@cjhyy/code-shell-core";
import { ChatSessionManager } from "@cjhyy/code-shell-core";
import { AgentServer } from "@cjhyy/code-shell-core";
import { AgentClient } from "@cjhyy/code-shell-core";
import { createInProcessTransport } from "@cjhyy/code-shell-core";
import { MCPManager } from "@cjhyy/code-shell-core";
import { CostTracker } from "@cjhyy/code-shell-core";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { resolveApiKey } from "@cjhyy/code-shell-core";
import { costTracker } from "@cjhyy/code-shell-core";
import { createRenderer, type OutputFormat } from "../output/renderer.js";
import type { LLMConfig, PermissionMode } from "@cjhyy/code-shell-core";
import type { AgentPresetName } from "@cjhyy/code-shell-core";
import { defaultSandboxConfig, type SandboxConfig } from "@cjhyy/code-shell-core";

/**
 * Shape of a settings.models[] entry. Mirrors the zod schema in
 * src/settings/schema.ts:73 — declared inline here because the Settings
 * interface in src/types.ts predates the multi-model rollout and doesn't
 * expose this field yet.
 */
type ModelPoolEntry = {
  key: string;
  providerKey?: string;
  provider?: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  maxOutputTokens?: number;
  maxContextTokens?: number;
};

/**
 * Resolve the active model[] entry using settings.activeKey, with a name-
 * match fallback (matches Engine.populateModelPoolFromSettings). Returns
 * undefined when settings.models[] is empty or the active key doesn't
 * resolve — callers fall back to the legacy settings.model.* mirror.
 *
 * Takes `unknown` because the Settings interface in src/types.ts predates
 * the multi-model rollout (no activeKey/models/providers fields), while
 * the runtime zod schema does have them. Casting locally avoids polluting
 * the canonical type until that gap is fixed.
 */
function findActiveModelEntry(settings: unknown): ModelPoolEntry | undefined {
  const s = settings as {
    activeKey?: string;
    models?: ModelPoolEntry[];
    model?: { name?: string };
  };
  if (!s.models?.length) return undefined;
  if (s.activeKey) {
    const hit = s.models.find((m) => m.key === s.activeKey);
    if (hit) return hit;
  }
  // Legacy match: settings.model.name against models[].model. Mirrors the
  // engine-side fallback for pre-activeKey configs.
  const legacyName = s.model?.name;
  if (legacyName) {
    return s.models.find(
      (m) => m.model === legacyName || m.model?.endsWith(`/${legacyName}`),
    );
  }
  return undefined;
}

/**
 * Look up an API key on settings.providers[<providerKey>]. Used when a
 * models[] entry has no inline apiKey because credentials live on the
 * provider record (the ProviderCatalog pattern).
 */
function findProviderApiKey(
  settings: unknown,
  providerKey: string | undefined,
): string | undefined {
  if (!providerKey) return undefined;
  const s = settings as { providers?: Array<{ key: string; apiKey?: string }> };
  return s.providers?.find((p) => p.key === providerKey)?.apiKey;
}

export interface RunOptions {
  task: string;
  model?: string;
  provider?: string;
  preset?: AgentPresetName;
  baseUrl?: string;
  output?: OutputFormat;
  permissionMode?: string;
  resume?: string;
  apiKey?: string;
  maxTurns?: number;
}

export async function runCommand(options: RunOptions): Promise<void> {
  const cwd = process.cwd();

  // Load settings — host terminal entrypoint reads the full hierarchy.
  const settingsManager = new SettingsManager(cwd, "full");
  const settings = settingsManager.get();

  // Resolve API key. Headless used to only consult settings.model.apiKey
  // (legacy mirror), which gave a false-negative when the user's key lives
  // only on settings.models[<active>].apiKey or settings.providers[].apiKey
  // — those are written by the newer ProviderModelFlow but not always
  // mirrored. Engine reconciles all three at startup; mirror that priority
  // here so the pre-Engine bail-out doesn't reject a valid config.
  const activeModelEntry = findActiveModelEntry(settings);
  const fallbackApiKey =
    settings.model?.apiKey ??
    activeModelEntry?.apiKey ??
    findProviderApiKey(settings, activeModelEntry?.providerKey);
  const apiKey = resolveApiKey(options.apiKey, fallbackApiKey);

  if (!apiKey) {
    console.error(
      "Error: No API key provided. Use --api-key, set OPENROUTER_API_KEY env var, or add to settings.",
    );
    process.exit(1);
  }

  // Build LLM config. Note: Engine.populateModelPoolFromSettings will
  // re-resolve via settings.activeKey and overwrite these fields with the
  // active pool entry, so this is just the bootstrap fallback for users
  // who only have legacy settings.model.* populated.
  const llmConfig: LLMConfig = {
    provider:
      options.provider ?? activeModelEntry?.provider ?? settings.model?.provider ?? "openai",
    model:
      options.model ??
      activeModelEntry?.model ??
      settings.model?.name ??
      "anthropic/claude-opus-4-6",
    apiKey,
    baseUrl:
      options.baseUrl ??
      activeModelEntry?.baseUrl ??
      settings.model?.baseUrl ??
      "https://openrouter.ai/api/v1",
    temperature: settings.model?.temperature,
    maxTokens: activeModelEntry?.maxOutputTokens ?? settings.model?.maxTokens ?? 8192,
    enableStreaming: true,
  };

  const sandboxConfig = mergeSandboxConfig(settings.sandbox, "auto");

  // ── Shared config passed into every session engine ─────────────
  const sharedCfg = {
    preset: options.preset ?? settings.agent.preset,
    enabledBuiltinTools: settings.agent.enabledBuiltinTools,
    disabledBuiltinTools: settings.agent.disabledBuiltinTools,
    permissionMode: (options.permissionMode ?? "acceptEdits") as PermissionMode,
    customSystemPrompt: settings.agent.customSystemPrompt,
    appendSystemPrompt: settings.agent.appendSystemPrompt,
    maxTurns: options.maxTurns ?? 30,
    maxContextTokens: settings.context.maxTokens,
    sessionStorageDir: settings.session.storageDir,
    costStore: costTracker,
    mcpServers: settings.mcpServers,
    headless: true,
    sandbox: sandboxConfig,
    // Host terminal entrypoint: read the full disk hierarchy (managed + user
    // ~/.code-shell + project + local). The SDK default is 'project', which
    // would skip the user's personal config — not what a CLI invocation wants.
    settingsScope: "full" as const,
  };

  // 1. Seed engine — populates model pool + tool registry via
  //    populateModelPoolFromSettings() in ctor. Discarded after extraction.
  const seedEngine = new Engine({ llm: llmConfig, cwd, headless: true, settingsScope: "full" });

  // 2. Extract shared resources
  const modelPool = seedEngine.getModelPool();
  const toolRegistry = seedEngine.getToolRegistry();
  const resolvedLlmConfig = seedEngine.getConfig().llm;
  // Reuse the SettingsManager already constructed above (settingsManager).
  // MCPManager: no-op holder for EngineRuntime; per-session engines connect
  // via mcpServers in sharedCfg.
  // TODO(future): aggregate MCP connections at the runtime level.
  const mcpPool = new MCPManager(toolRegistry);
  // CostTracker: fresh instance for this invocation.
  // TODO(future): thread into Engine cost accounting via runtime.costTracker.
  const runCostTracker = new CostTracker();

  // 3. Build the shared EngineRuntime (reuse settingsManager from above)
  const runtime = new EngineRuntime({
    modelPool,
    toolRegistry,
    settings: settingsManager,
    mcpPool,
    costTracker: runCostTracker,
  });

  // 4. ChatSessionManager — one session per `run` invocation (UUID)
  const chatManager = new ChatSessionManager({
    runtime,
    engineFactory: (slice) =>
      new Engine({
        llm: resolvedLlmConfig,
        cwd,
        runtime,
        ...sharedCfg,
        // Per-session overrides from the protocol request take precedence
        ...(slice.permissionMode ? { permissionMode: slice.permissionMode } : {}),
        ...(slice.preset ? { preset: slice.preset } : {}),
        ...(slice.customSystemPrompt !== undefined ? { customSystemPrompt: slice.customSystemPrompt } : {}),
        ...(slice.appendSystemPrompt !== undefined ? { appendSystemPrompt: slice.appendSystemPrompt } : {}),
        ...(slice.maxTurns !== undefined ? { maxTurns: slice.maxTurns } : {}),
        ...(slice.maxContextTokens !== undefined ? { maxContextTokens: slice.maxContextTokens } : {}),
        ...(slice.cwd ? { cwd: slice.cwd } : {}),
      }),
    maxSessions: 1,  // one-shot run; exactly one session per invocation
    idleTtlMs: 30 * 60 * 1000,
  });
  chatManager.startIdleSweeper();

  // 5. Wire up in-process transport + server + client
  const [serverTransport, clientTransport] = createInProcessTransport();
  const server = new AgentServer({ chatManager, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });

  // Unique sessionId per run invocation; use --resume if provided.
  const runSessionId = options.resume ?? `run-${randomUUID()}`;

  const outputFormat = options.output ?? (settings.output.format as OutputFormat) ?? "text";
  const renderer = createRenderer(outputFormat);

  // Wire renderer to stream events from client
  client.onStreamEvent((envelope) => renderer.onEvent(envelope.event));

  let exitCode = 1;
  try {
    const result = await client.run(options.task, runSessionId);

    renderer.onComplete(result.text, result.reason, {
      sessionId: result.sessionId,
      turnCount: result.turnCount,
    });

    exitCode = result.reason === "completed" ? 0 : 1;
  } finally {
    // Tear down in correct order: server first (aborts in-flight run, emits
    // shutdown notification through still-open transport), then client.
    server.close();
    client.close();
  }
  process.exit(exitCode);
}

/**
 * Build the sandbox config Engine sees. Users only need to set the parts
 * they care about; missing fields fall back to defaults that include the
 * sensitive-path deny list. `defaultMode` is the headless-vs-REPL default.
 */
function mergeSandboxConfig(
  user: { mode?: string; writableRoots?: string[]; deniedReads?: string[]; network?: string } | undefined,
  defaultMode: SandboxConfig["mode"],
): SandboxConfig {
  const base = defaultSandboxConfig(defaultMode);
  if (!user) return base;
  return {
    mode: (user.mode as SandboxConfig["mode"]) ?? base.mode,
    writableRoots: user.writableRoots ?? base.writableRoots,
    deniedReads: user.deniedReads ?? base.deniedReads,
    network: (user.network as SandboxConfig["network"]) ?? base.network,
  };
}
