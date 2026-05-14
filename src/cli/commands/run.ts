/**
 * `run` command — headless single-prompt execution.
 *
 * Uses the same Engine → AgentServer → AgentClient pipeline,
 * but with a headless renderer instead of Ink UI.
 */

import { Engine } from "../../engine/engine.js";
import { AgentServer } from "../../protocol/server.js";
import { AgentClient } from "../../protocol/client.js";
import { createInProcessTransport } from "../../protocol/transport.js";
import { SettingsManager } from "../../settings/manager.js";
import { resolveApiKey } from "../onboarding.js";
import { costTracker } from "../cost-tracker.js";
import { createRenderer, type OutputFormat } from "../output/renderer.js";
import type { LLMConfig, PermissionMode } from "../../types.js";
import type { AgentPresetName } from "../../preset/index.js";
import { defaultSandboxConfig, type SandboxConfig } from "../../tool-system/sandbox/index.js";

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

  // Load settings
  const settingsManager = new SettingsManager(cwd);
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

  const engine = new Engine({
    llm: llmConfig,
    cwd,
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
  });

  // Wire through protocol layer
  const [serverTransport, clientTransport] = createInProcessTransport();
  const _server = new AgentServer({ engine, transport: serverTransport });
  const client = new AgentClient({ transport: clientTransport });

  const outputFormat = options.output ?? (settings.output.format as OutputFormat) ?? "text";
  const renderer = createRenderer(outputFormat);

  // Forward stream events to renderer
  client.onStreamEvent((event) => renderer.onEvent(event));

  const result = await client.run(options.task, options.resume);

  renderer.onComplete(result.text, result.reason, {
    sessionId: result.sessionId,
    turnCount: result.turnCount,
  });

  client.close();

  process.exit(result.reason === "completed" ? 0 : 1);
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
