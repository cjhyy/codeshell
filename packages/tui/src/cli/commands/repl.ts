/**
 * Interactive REPL mode — uses Ink (React for CLI) for the terminal UI.
 *
 * Wiring: Engine → AgentServer → [in-process transport] → AgentClient → UI
 */

import chalk from "chalk";
import { Engine } from "@cjhyy/code-shell-core";
import { mergePluginMcpServers } from "@cjhyy/code-shell-core";
import { EngineRuntime } from "@cjhyy/code-shell-core";
import { ChatSessionManager } from "@cjhyy/code-shell-core";
import { SessionManager } from "@cjhyy/code-shell-core";
import { AgentServer } from "@cjhyy/code-shell-core";
import { AgentClient } from "@cjhyy/code-shell-core";
import { createInProcessTransport } from "@cjhyy/code-shell-core";
import { SettingsManager } from "@cjhyy/code-shell-core";
import { personalizationFrom } from "@cjhyy/code-shell-core";
import { MCPManager } from "@cjhyy/code-shell-core";
import { CostTracker } from "@cjhyy/code-shell-core";
import { resolveLLMConfigForTag } from "@cjhyy/code-shell-core";
import { costTracker } from "@cjhyy/code-shell-core";
import { defaultSandboxConfig } from "@cjhyy/code-shell-core";
import type { ClientDefaults, LLMConfig, PermissionMode } from "@cjhyy/code-shell-core";
import { startInkRepl } from "../../ui/index.js";
import { runInkOnboarding } from "../../ui/onboarding-runner.js";
import type { AgentPresetName } from "@cjhyy/code-shell-core";
import { getInteractiveApprovalBackend } from "@cjhyy/code-shell-core";
import {
  cronScheduler,
  CronStore,
  bindCronToEngine,
  type CronRunResult,
} from "@cjhyy/code-shell-core";
import { resolveMaxContextTokens } from "./max-context-tokens.js";
import { createArenaCapability } from "@cjhyy/code-shell-arena";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ReplOptions {
  model?: string;
  provider?: string;
  preset?: AgentPresetName;
  baseUrl?: string;
  apiKey?: string;
  permissionMode?: string;
  maxTurns?: number;
  output?: string;
  resume?: string;
  effort?: EffortLevel;
  prefill?: string;
}

function getEffortConfig(level: EffortLevel): { temperature: number; maxTokens: number } {
  switch (level) {
    case "low":
      return { temperature: 0.1, maxTokens: 4096 };
    case "medium":
      return { temperature: 0.3, maxTokens: 8192 };
    case "high":
      return { temperature: 0.5, maxTokens: 16384 };
    case "max":
      return { temperature: 0.7, maxTokens: 32768 };
  }
}

export async function replCommand(options: ReplOptions): Promise<void> {
  const cwd = process.cwd();

  // Load settings — single SettingsManager instance reused throughout.
  // Host terminal entrypoint reads the full hierarchy (incl. user ~/.code-shell).
  const settingsManager = new SettingsManager(cwd, "full");
  let settings = settingsManager.get();

  // Resolve API key / auth.
  //
  // Onboarding gate: env vars alone are NOT enough to skip onboarding —
  // a saved unified-catalog config (credentials[]/modelConnections[]) must
  // be present. Otherwise `/logout` looks like a no-op whenever the user
  // has a provider env var set (very common: OPENROUTER_API_KEY,
  // ANTHROPIC_API_KEY). The wizard itself surfaces detected env keys
  // (OnboardingPrompt.detectEnvKeys) so the user can opt-in to using them —
  // not have them silently chosen.
  const hasSavedAuth =
    !!options.apiKey ||
    (Array.isArray((settings as any).credentials) &&
      (settings as any).credentials.some((c: any) => c?.apiKey)) ||
    (Array.isArray((settings as any).modelConnections) &&
      (settings as any).modelConnections.length > 0);
  let apiKey = options.apiKey;

  let model = options.model;
  let provider = options.provider;
  let baseUrl = options.baseUrl;

  if (!hasSavedAuth) {
    if (!process.stdin.isTTY) {
      console.error(
        chalk.red(
          "Error: No API key configured and stdin is not a TTY. " +
            "Set --api-key, OPENROUTER_API_KEY, or run interactively to onboard.",
        ),
      );
      process.exit(1);
    }
    const result = await runInkOnboarding();
    if (!result) {
      console.error(chalk.yellow("Onboarding cancelled."));
      process.exit(1);
    }
    apiKey = result.apiKey;
    // Wizard answers override settings/CLI defaults so the new config
    // takes effect immediately without a restart.
    provider = result.provider;
    model = result.model;
    baseUrl = result.baseUrl;
    // Reload settings — the wizard has just persisted the model pool / arena
    // entries, and downstream code (e.g. /model) reads them from settings.
    settings = settingsManager.get();
  }

  provider = provider ?? "openai";
  baseUrl = baseUrl ?? "https://openrouter.ai/api/v1";
  const effort: EffortLevel = options.effort ?? "high";
  const effortConfig = getEffortConfig(effort);
  const maxTurns = options.maxTurns ?? 100;

  // Resolve from the unified catalog (modelConnections[]/credentials[]/defaults).
  // The onboarding-wizard fallback covers the just-onboarded case where the
  // resolver hasn't picked up a freshly-written connection yet.
  const resolved = resolveLLMConfigForTag(settings, "text", (settings as any).defaults?.text);
  const llmConfig: LLMConfig = resolved ?? {
    provider,
    model: model ?? "anthropic/claude-opus-4-6",
    apiKey,
    baseUrl,
    maxTokens: effortConfig.maxTokens ?? 8192,
  };
  model = llmConfig.model;

  // Temperature is a cross-model runtime knob (ClientDefaults), no longer part
  // of LLMConfig. The effort flag's temperature is a CLI override that
  // settings.json doesn't know about, so thread it explicitly into every
  // engine; falls back to 0.3.
  const clientDefaults: ClientDefaults = {
    temperature: effortConfig.temperature ?? 0.3,
  };

  const permissionMode = (options.permissionMode ?? "acceptEdits") as PermissionMode;
  const maxContextTokens = resolveMaxContextTokens(llmConfig, settings.context.maxTokens);
  const extensionModules = [createArenaCapability()] as const;

  // ── Shared config passed into every session engine ─────────────
  const sharedCfg = {
    clientDefaults,
    preset: options.preset ?? settings.agent.preset,
    enabledBuiltinTools: settings.agent.enabledBuiltinTools,
    disabledBuiltinTools: settings.agent.disabledBuiltinTools,
    extensionModules,
    permissionMode,
    customSystemPrompt: settings.agent.customSystemPrompt,
    appendSystemPrompt: settings.agent.appendSystemPrompt,
    // Personalization + instruction compat (shared helper → no per-host drift).
    // Covers both the main engineFactory and the cron engine (both spread sharedCfg).
    ...personalizationFrom(settings.agent),
    maxTurns,
    maxContextTokens,
    sessionStorageDir: settings.session.storageDir,
    costStore: costTracker,
    mcpServers: mergePluginMcpServers(
      settings.mcpServers ?? {},
      (settings as { disabledPlugins?: string[] }).disabledPlugins ?? [],
      settings.mcpServerOverrides ?? {},
    ),
    approvalBackend: getInteractiveApprovalBackend(),
    // Host terminal entrypoint: read the full disk hierarchy (incl. user
    // ~/.code-shell). The SDK default 'project' would skip the user's config.
    settingsScope: "full" as const,
  };

  // 1. Seed engine — calls populateModelPoolFromSettings() in ctor so the
  //    model pool and tool registry are fully populated. Discarded after
  //    resource extraction (never runs a task).
  const seedEngine = new Engine({
    llm: llmConfig,
    clientDefaults,
    cwd,
    extensionModules,
    settingsScope: "full",
  });

  // 2. Extract shared resources from seed engine
  const modelPool = seedEngine.getModelPool();
  const toolRegistry = seedEngine.getRuntimeToolRegistry();
  const resolvedLlmConfig = seedEngine.getConfig().llm;
  // settingsManager was hoisted to the top of replCommand; reused here.
  // MCPManager: no-op holder satisfying EngineRuntime type; individual
  // session engines connect to mcpServers from their config.
  // TODO(future): aggregate MCP connections across sessions at the runtime level.
  const mcpPool = new MCPManager(toolRegistry);
  // CostTracker: fresh shared instance for this process.
  // TODO(future): thread into Engine cost accounting once Engine reads runtime.costTracker.
  const sessionCostTracker = new CostTracker();

  // 3. Build the shared EngineRuntime
  const runtime = new EngineRuntime({
    modelPool,
    toolRegistry,
    settings: settingsManager,
    mcpPool,
    costTracker: sessionCostTracker,
  });

  // 4. ChatSessionManager — single session "tui-main" (or resumed sid)
  const chatManager = new ChatSessionManager({
    runtime,
    engineFactory: (slice) =>
      new Engine({
        llm: resolvedLlmConfig,
        cwd,
        runtime,
        origin: "tui",
        ...sharedCfg,
        // Per-session overrides from the protocol request take precedence
        ...(slice.permissionMode ? { permissionMode: slice.permissionMode } : {}),
        ...(slice.preset ? { preset: slice.preset } : {}),
        ...(slice.customSystemPrompt !== undefined
          ? { customSystemPrompt: slice.customSystemPrompt }
          : {}),
        ...(slice.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: slice.appendSystemPrompt }
          : {}),
        ...(slice.maxTurns !== undefined ? { maxTurns: slice.maxTurns } : {}),
        ...(slice.maxContextTokens !== undefined
          ? { maxContextTokens: slice.maxContextTokens }
          : {}),
        ...(slice.cwd ? { cwd: slice.cwd } : {}),
      }),
    maxSessions: 4, // TUI is single-user; 4 accommodates a few sub-sessions without runaway resource use
    idleTtlMs: 30 * 60 * 1000,
  });
  chatManager.startIdleSweeper();

  // 5. Create in-process transport pair
  const [serverTransport, clientTransport] = createInProcessTransport();
  // Must use the same configured root as every Engine created above; otherwise
  // /resume can display/control a different state.json tree when users override
  // session.storageDir.
  const goalDiskManager = new SessionManager(settings.session.storageDir);

  // 6. Wire up AgentServer (wraps chatManager, handles protocol)
  const _server = new AgentServer({
    chatManager,
    transport: serverTransport,
    settingsReader: () => settingsManager.load(),
    readActiveGoalFromDisk: (sessionId) => goalDiskManager.readActiveGoal(sessionId),
    updateActiveGoalOnDisk: (sessionId, patch) =>
      goalDiskManager.updateActiveGoal(sessionId, patch)?.goal,
    clearActiveGoalOnDisk: (sessionId, expected) =>
      goalDiskManager.clearActiveGoal(sessionId, expected),
  });

  // 7. Create AgentClient (UI-side)
  const client = new AgentClient({ transport: clientTransport });

  // ── Cron (B1 + B2) ──────────────────────────────────────────────
  // Give the shared cron singleton a persistence store, restore any jobs
  // saved in a previous run, and wire its executor to a one-shot headless
  // Engine run. Until the sandbox (Phase 4) lands, cron runs read-only:
  // bindCronToEngine hands us permissionMode "default" + a read-only
  // approval backend, which we apply to a fresh Engine per fired job.
  cronScheduler.setStore(new CronStore());
  cronScheduler.loadJobs();
  bindCronToEngine(cronScheduler, async (req): Promise<CronRunResult> => {
    const cronEngine = new Engine({
      llm: resolvedLlmConfig,
      cwd,
      runtime,
      ...sharedCfg,
      extensionModules: [],
      // Override the REPL's interactive backend/mode with the read-only
      // contract from cron-runtime — cron is unattended.
      permissionMode: req.permissionMode,
      approvalBackend: req.approvalBackend,
      // Confine writes/shell to the workspace per the job's tier — defense in
      // depth on top of the approval backend (§5.6 #9).
      sandbox: defaultSandboxConfig(req.sandboxMode),
      headless: true,
    });
    // Forward the scheduler's abort signal so CronScheduler.abort(jobId) can
    // actually cancel an in-flight REPL cron run (§5.6 #11).
    const result = await cronEngine.run(req.prompt, { cwd, signal: req.signal });
    return { text: result.text, reason: result.reason };
  });

  // Fixed sessionId — every user message in this REPL session routes to the
  // same engine. Use the --resume id when provided so conversation history
  // is correctly continued.
  const tuiSessionId = options.resume ?? "tui-main";

  // 8. Launch Ink UI with the client
  await startInkRepl({
    client,
    model,
    effort,
    maxTurns,
    cwd,
    maxContextTokens,
    sessionId: tuiSessionId,
    prefill: options.prefill,
    // TUI quit — tear down sessions and reap any background shells the user
    // started so a detached `npm run dev` doesn't outlive the CLI as an
    // orphan (core design §6). MUST run via onExit (awaited before
    // process.exit(0) inside startInkRepl): any code AFTER this await is
    // unreachable because the REPL exits the process itself.
    onExit: () => chatManager.closeAllAsync(),
  });
}
