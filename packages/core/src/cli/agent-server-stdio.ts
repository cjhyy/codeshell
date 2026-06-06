/**
 * agent-server-stdio — Electron worker entry point.
 *
 * Bootstraps EngineRuntime + ChatSessionManager and exposes AgentServer
 * over a newline-delimited JSON stdio transport so Electron's main process
 * (or any other parent that spawns this file as a child process) can drive
 * multi-session agent runs through the standard protocol.
 *
 * Bootstrap approach (bootstrap-then-extract / approach a):
 *   1. Construct a single "seed" Engine without a runtime.  Engine's
 *      constructor calls populateModelPoolFromSettings() which reads
 *      settings.json, registers model entries and provider catalog, and
 *      resolves the active model — exactly the initialization work we need.
 *   2. Extract the fully-populated modelPool and toolRegistry from the seed
 *      engine, plus construct SettingsManager, MCPManager, CostTracker.
 *   3. Wrap those shared resources in an EngineRuntime.
 *   4. Pass the runtime to ChatSessionManager's engineFactory so every
 *      session engine shares the pool (same active model, same tool set).
 *   5. Discard the seed engine — it will never run a task.
 *
 * Why this over pure "factor-out-builders" (approach b):
 *   Engine.populateModelPoolFromSettings() is a 60-line private method that
 *   reads settings, resolves the active key, builds the ProviderCatalog, and
 *   reloads cached context windows. Extracting it as a standalone helper
 *   would require making several private fields and imports public. The seed
 *   engine pattern reuses the existing, tested code with zero API changes.
 *
 * Clients (Electron renderer, TUI) must not change. As long as the
 * transport is stdio NDJSON and the protocol surface is unchanged, this
 * bootstrap is invisible to them.
 */

import { Engine } from "../engine/engine.js";
import { EngineRuntime } from "../engine/runtime.js";
import { ChatSessionManager } from "../protocol/chat-session-manager.js";
import type { EngineConfigSlice } from "../protocol/chat-session-manager.js";
import type { ValidatedSettings } from "../settings/schema.js";
import { AgentServer } from "../protocol/server.js";
import { StdioTransport } from "../protocol/transport.js";
import { SettingsManager } from "../settings/manager.js";
import { personalizationFrom } from "../settings/personalization.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { mergePluginMcpServers } from "../plugins/installer/loadPluginMcp.js";
import { CostTracker } from "../cost-tracker.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import { logger } from "../logging/logger.js";
import { cronScheduler } from "../automation/scheduler.js";
import { CronStore, defaultCronStorePath } from "../automation/store.js";

/**
 * Resolve per-session agent config: protocol slice overrides win, else fall
 * back to disk settings.agent.*. Fixes the bug where settings.agent.* never
 * reached session engines (slice arrived with only permissionMode+cwd).
 */
export function resolveSessionAgentConfig(
  slice: EngineConfigSlice,
  settings: ValidatedSettings,
) {
  return {
    preset: slice.preset ?? settings.agent.preset,
    customSystemPrompt: slice.customSystemPrompt ?? settings.agent.customSystemPrompt,
    appendSystemPrompt: slice.appendSystemPrompt ?? settings.agent.appendSystemPrompt,
  };
}

// ─── Read base config from environment / settings ─────────────────

const cwd = process.env.AGENT_CWD ?? process.cwd();

// Load settings once to derive llm config for the seed engine.
// Desktop is a host application: read the full disk hierarchy (incl. the
// user's ~/.code-shell). The SDK default 'project' would skip user config.
const settingsManager = new SettingsManager(cwd, "full");
const settings = settingsManager.get();

// LLMConfig is pure model identity now — only the bare identity fields go here.
// temperature/imageDetail/timeout/retryMaxAttempts are ClientDefaults, derived
// inside Engine.populateModelPoolFromSettings from settings.model.temperature
// and settings.images.detail.
const llmConfig = {
  provider: settings.model.provider,
  model: settings.model.name,
  apiKey: settings.model.apiKey ?? "",
  baseUrl: settings.model.baseUrl,
  maxTokens: settings.model.maxTokens,
};

// ─── Step 1: seed engine — populates model pool from settings ─────

const seedEngine = new Engine({
  llm: llmConfig,
  cwd,
  settingsScope: "full",
  // No runtime — Engine.populateModelPoolFromSettings() runs in ctor.
});

// ─── Step 2: extract shared resources ────────────────────────────

const modelPool = seedEngine.getModelPool();
const toolRegistry = seedEngine.getToolRegistry();

// Capture the seed engine's resolved llmConfig + clientDefaults
// (post-populateModelPoolFromSettings). Session engines inherit defaults so
// settings.model.temperature / images.detail apply uniformly without each
// factory call re-reading settings.
const resolvedLlmConfig = seedEngine.getConfig().llm;
const resolvedClientDefaults = seedEngine.getConfig().clientDefaults;

// Reuse the same SettingsManager instance for the runtime instead of constructing
// a fresh one — avoids duplication and keeps the pattern cleaner.
const sharedSettings = settingsManager;

// MCPManager: not connected to any servers at bootstrap time.
// Individual session engines will connect to mcpServers from their config.
// This instance satisfies the EngineRuntime type requirement; it is a
// no-op holder until an engineFactory caller opts to attach servers.
// TODO(future) — currently a top-level placeholder. Future work: aggregate
// MCP server connections across sessions instead of each session creating
// its own MCPManager via Engine.run lazy init.
const mcpPool = new MCPManager(toolRegistry);

// CostTracker: shared across all sessions for aggregate tracking.
// TODO(future) — shared across all sessions, but Engine doesn't yet read
// runtime.costTracker. Future work: per-session cost accounting through
// the shared runtime.
const costTracker = new CostTracker();

// ─── Step 3: build the shared EngineRuntime ───────────────────────

const runtime = new EngineRuntime({
  modelPool,
  toolRegistry,
  settings: sharedSettings,
  mcpPool,
  costTracker,
});

// ─── Step 4: ChatSessionManager ──────────────────────────────────

// Re-read settings from disk on each new session so edits the user makes in
// the settings UI take effect on the NEXT session without restarting the
// worker (the `settings` bootstrap snapshot above is read once at process
// start and would otherwise pin every session to the launch-time values).
// This is the "pull on session creation" tier — mirrors how Codex's new
// threads call load_with_overrides() per start. (Hot-reloading ALREADY-RUNNING
// sessions is a separate, heavier push mechanism, intentionally out of scope.)
// Best-effort: if a freshly-edited settings.json is malformed, fall back to the
// last-known-good bootstrap snapshot rather than failing to create a session.
function freshSettings(): typeof settings {
  try {
    return settingsManager.load();
  } catch {
    return settings;
  }
}

const chatManager = new ChatSessionManager({
  runtime,
  // resolvedLlmConfig is the bootstrap-time snapshot. When the user
  // hot-switches models via configure() the modelPool.activeKey moves
  // ahead of it, so newly-created sessions must re-resolve from the pool
  // each time the factory fires; fall back to the snapshot only when the
  // pool can't resolve (no active key — shouldn't happen in practice).
  engineFactory: (slice) => {
    const live = freshSettings();
    return new Engine({
      llm: runtime.modelPool.resolveLLMConfig() ?? resolvedLlmConfig,
      // Inherit the seed engine's resolved clientDefaults so every session
      // engine sees the user's temperature/imageDetail without each factory
      // call re-running populateModelPoolFromSettings.
      clientDefaults: resolvedClientDefaults,
      cwd,
      runtime,
      // This stdio worker exists only to serve the desktop app, so every
      // session it creates is a desktop-origin session.
      origin: "desktop",
      // Inherit full scope so spawned subagents read user config too.
      settingsScope: "full",
      // MCP servers from settings — the worker reads the full disk
      // hierarchy at bootstrap (incl. ~/.code-shell). Without this the
      // factory-built session Engine has config.mcpServers === undefined,
      // so Engine.run()'s connectAll() guard never fires and no MCP server
      // (stdio OR url) is ever connected. The shared runtime.mcpPool means
      // the first session to connect populates connections for the worker.
      // Plugin-provided MCP servers (mcp-servers.json in installed plugins)
      // are merged in here so the model can actually call them.
      mcpServers: mergePluginMcpServers(
        live.mcpServers ?? {},
        (live as { disabledPlugins?: string[] }).disabledPlugins ?? [],
      ),
      // Per-session overrides from the protocol request; fall back to
      // settings.agent.* so the user's 个性化 settings actually apply
      // (previously slice arrived with only permissionMode+cwd, so these
      // were always undefined — the 自定义指令 box never took effect).
      // `live` is re-read from disk per session, so settings edits take effect
      // on the next session without a worker restart.
      permissionMode: slice.permissionMode,
      ...resolveSessionAgentConfig(slice, live),
      // Personalization + instruction compat come from disk settings only
      // (not per-request protocol overrides), so they read straight from
      // `live` here rather than through the slice. Shared helper keeps the
      // three fields wired identically across desktop / TUI / TCP.
      ...personalizationFrom(live.agent),
      maxTurns: slice.maxTurns,
      maxContextTokens: slice.maxContextTokens,
      ...(slice.cwd ? { cwd: slice.cwd } : {}),
    });
  },
  maxSessions: 16,
  idleTtlMs: 30 * 60 * 1000,
});
chatManager.startIdleSweeper();

// ─── Cron persistence ────────────────────────────────────────────
// The agent's CronCreate/Delete tools operate on the shared cronScheduler
// singleton. In the desktop host this worker is a SEPARATE process from the
// Electron main process that owns the live scheduler, so the only way a
// chat-created job reaches the automation UI is through the shared on-disk
// store (~/.code-shell/cron.json). Give this process's scheduler that store so
// CronCreate persists; loadJobs() so the agent can list/modify existing jobs.
// Execution is DISABLED here — this worker must not run scheduled jobs (the
// main process owns execution); persistence is its only cron role. Without
// this, loadJobs()/CronCreate would arm timers in this process too, double-
// running jobs and corrupting run stats.
cronScheduler.setStore(new CronStore(defaultCronStorePath()));
cronScheduler.setExecutionEnabled(false);
cronScheduler.loadJobs();

// ─── Step 5: AgentServer over stdio ──────────────────────────────

const stdioTransport = new StdioTransport(process.stdin, process.stdout);

const agentServer = new AgentServer({
  chatManager,
  transport: stdioTransport,
  // Config hot-reload (layer 2) reads disk through the SAME closure the
  // engineFactory uses for new sessions, so a reloaded running session and a
  // newly-created session converge on identical disk config (no divergence).
  settingsReader: freshSettings,
});

// Clean up on termination signals. Without this, SIGTERM (parent kill),
// SIGINT (Ctrl+C), or SIGHUP would drop the process without closing sessions,
// clearing the idle sweeper, or terminating child MCP/tool processes.
// AgentServer.close() → chatManager.closeAll() also reaps background shells.
installGracefulShutdown(agentServer);

// Reap orphaned background shells left by a previously-crashed worker
// (design §难点1): a worker crash detaches its `npm run dev` children, which
// keep holding ports. Scanning pidfiles on boot lists still-alive groups as
// `orphaned` (so ListShells/KillShell can clean them) and deletes stale ones.
try {
  const orphans = backgroundShellManager.reapOrphansFromPidfiles();
  if (orphans.length > 0) {
    logger.info("bg_shell.orphans_found", { count: orphans.length });
  }
} catch {
  /* best-effort — never block worker startup on this */
}

// Keep the process alive — readline in StdioTransport holds the event loop.
// On parent close / stdin EOF the process will exit naturally.
