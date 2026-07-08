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
import { SessionManager } from "../session/session-manager.js";
import { validateSettings, type ValidatedSettings } from "../settings/schema.js";
import { AgentServer } from "../protocol/server.js";
import { StdioTransport } from "../protocol/transport.js";
import { createNotification } from "../protocol/types.js";
import { setCronChangedSink } from "../tool-system/builtin/cron.js";
import { SettingsManager, noRepoDir } from "../settings/manager.js";
import { personalizationFrom } from "../settings/personalization.js";
import { MCPManager } from "../tool-system/mcp-manager.js";
import { mergePluginMcpServers } from "../plugins/installer/loadPluginMcp.js";
import { computeEffectiveDisabledLists } from "../capability-control/disabled-lists.js";
import { CostTracker } from "../cost-tracker.js";
import { installGracefulShutdown } from "./graceful-shutdown.js";
import { backgroundShellManager } from "../runtime/background-shell.js";
import { logger } from "../logging/logger.js";
import { cronScheduler } from "../automation/scheduler.js";
import { CronStore, defaultCronStorePath } from "../automation/store.js";
import { resolveLLMConfigForTag } from "../engine/resolve-llm-config.js";

/**
 * Resolve per-session agent config: protocol slice overrides win, else fall
 * back to disk settings.agent.*. Fixes the bug where settings.agent.* never
 * reached session engines (slice arrived with only permissionMode+cwd).
 */
export function resolveSessionAgentConfig(slice: EngineConfigSlice, settings: ValidatedSettings) {
  return {
    preset: slice.preset ?? settings.agent.preset,
    customSystemPrompt: slice.customSystemPrompt ?? settings.agent.customSystemPrompt,
    appendSystemPrompt: slice.appendSystemPrompt ?? settings.agent.appendSystemPrompt,
  };
}

/**
 * Resolve a session's effective cwd. A protocol slice with an explicit cwd
 * points the session at that project; a slice WITHOUT a cwd is a no-repo
 * "纯聊天" session (the renderer omits cwd when no project is selected) and must
 * land in the no-repo sandbox (~/.code-shell/no-repo) — NOT the worker's boot
 * cwd.
 *
 * Why not the boot cwd: this stdio worker is long-lived and reused across
 * sessions/projects, so its boot cwd is whatever project first spawned it.
 * Inheriting it for a no-repo chat would (a) silently run the chat against a
 * stale, unrelated project's files and (b) defeat the no-repo skill/plugin
 * whitelist inversion (which only fires when cwd === noRepoDir).
 */
export function resolveSessionCwd(slice: EngineConfigSlice): string {
  return slice.cwd ?? noRepoDir();
}

// ─── Read base config from environment / settings ─────────────────

const cwd = process.env.AGENT_CWD ?? process.cwd();

// Load settings once to derive llm config for the seed engine.
// Desktop is a host application: read the full disk hierarchy (incl. the
// user's ~/.code-shell). The SDK default 'project' would skip user config.
const settingsManager = new SettingsManager(cwd, "full");
// Bootstrap load must NOT crash the worker on a schema-invalid (but JSON-valid)
// settings file: a hand-edited settings.json with e.g. `permissions.defaultMode:
// "ask"` or `env.FOO: 123` makes SettingsSchema.parse throw a ZodError at module
// top level, which the desktop/mobile host sees as "connection lost" / a
// nonzero-exit worker. Fall back to schema defaults and print a readable,
// truncated reason so the user can fix the file (freshSettings() applies the
// same best-effort contract per session once the worker is up).
let settings: ValidatedSettings;
try {
  settings = settingsManager.get();
} catch (err) {
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
  console.error(`[agent-server] settings.json 校验失败,已回退到默认配置(请修正后重启):\n${reason}`);
  settings = validateSettings({});
}

// LLMConfig is pure model identity now — only the bare identity fields go here.
// temperature/imageDetail/timeout/retryMaxAttempts are ClientDefaults, derived
// inside Engine.populateModelPoolFromSettings (temperature is a ClientDefaults
// knob; imageDetail from settings.images.detail).
const seedLlm = resolveLLMConfigForTag(
  settings,
  "text",
  (settings as { defaults?: { text?: string } }).defaults?.text,
);
if (!seedLlm) {
  console.error(
    `[agent-server] 没有可用的文本模型连接(defaults.text=${
      (settings as { defaults?: { text?: string } }).defaults?.text ?? "未设置"
    })。` + `请在「连接」页添加并填写凭证。`,
  );
  process.exit(1);
}
const llmConfig = seedLlm;

// ─── Step 1: seed engine — populates model pool from settings ─────

const seedEngine = new Engine({
  llm: llmConfig,
  cwd,
  preset: settings.agent.preset,
  enabledBuiltinTools: settings.agent.enabledBuiltinTools,
  disabledBuiltinTools: settings.agent.disabledBuiltinTools,
  builtinToolHost: "desktop",
  settingsScope: "full",
  // No runtime — Engine.populateModelPoolFromSettings() runs in ctor.
});

// ─── Step 2: extract shared resources ────────────────────────────

const modelPool = seedEngine.getModelPool();
const toolRegistry = seedEngine.getToolRegistry();

// Capture the seed engine's resolved llmConfig + clientDefaults
// (post-populateModelPoolFromSettings). Session engines inherit defaults so
// the temperature ClientDefault / images.detail apply uniformly without each
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
    // Effective cwd for THIS session: explicit slice.cwd → that project; absent
    // → the no-repo sandbox (NOT the worker's stale boot cwd). See
    // resolveSessionCwd for the full rationale.
    const sessionCwd = resolveSessionCwd(slice);
    // Read settings for THIS session's cwd, not the worker's boot cwd. A single
    // worker serves many projects; the boot-cwd `freshSettings()` snapshot pins
    // every session to the first project's project-layer settings, so project
    // `mcpServers` / `agent.*` / permissions from the boot project would leak
    // into (and shadow) other projects' sessions. A per-session SettingsManager
    // still reads the full hierarchy (user ~/.code-shell + THIS project's
    // .code-shell), keeping user-global settings while picking up the correct
    // project overlay. Falls back to the boot snapshot if this project's file is
    // malformed (same best-effort contract as freshSettings()).
    const sessionSettingsManager = new SettingsManager(sessionCwd, "full");
    let live: typeof settings;
    try {
      live = sessionSettingsManager.load();
    } catch {
      live = freshSettings();
    }
    // Fold project capabilityOverrides over the global disabledPlugins before
    // the MCP merge — a plugin force-enabled in 能力总览 (project "on") must
    // contribute its MCP servers even while globally disabled, and vice versa.
    // Raw `live.disabledPlugins` alone ignored the project layer.
    const { disabledPlugins } = computeEffectiveDisabledLists(sessionSettingsManager, sessionCwd);
    return new Engine({
      llm: runtime.modelPool.resolveLLMConfig() ?? resolvedLlmConfig,
      // Inherit the seed engine's resolved clientDefaults so every session
      // engine sees the user's temperature/imageDetail without each factory
      // call re-running populateModelPoolFromSettings.
      clientDefaults: resolvedClientDefaults,
      // sessionCwd resolves slice.cwd → no-repo sandbox (never the stale boot
      // cwd). The slice.cwd spread below is now redundant with this but kept
      // for clarity / explicitness.
      cwd: sessionCwd,
      runtime,
      // This stdio worker exists only to serve the desktop app, so every
      // session it creates is a desktop-origin session.
      origin: "desktop",
      builtinToolHost: "desktop",
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
        disabledPlugins,
        live.mcpServerOverrides ?? {},
      ),
      // Per-session overrides from the protocol request; fall back to
      // settings.agent.* so the user's 个性化 settings actually apply
      // (previously slice arrived with only permissionMode+cwd, so these
      // were always undefined — the 自定义指令 box never took effect).
      // `live` is re-read from disk per session, so settings edits take effect
      // on the next session without a worker restart.
      permissionMode: slice.permissionMode,
      // Workspace trust for this project (asserted by desktop main's
      // trust-store, threaded via RunParams). When false, core strips the
      // project's dangerous .code-shell settings (permissions/env/hooks/…).
      projectTrusted: slice.projectTrusted,
      ...resolveSessionAgentConfig(slice, live),
      // Personalization + instruction compat come from disk settings only
      // (not per-request protocol overrides), so they read straight from
      // `live` here rather than through the slice. Shared helper keeps the
      // three fields wired identically across desktop / TUI / TCP.
      ...personalizationFrom(live.agent),
      maxTurns: slice.maxTurns,
      maxContextTokens: slice.maxContextTokens,
      // cwd already set to sessionCwd above (slice.cwd → no-repo fallback).
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

// Cron jobs are persisted by this worker but only main arms/executes their
// timers (this worker keeps setExecutionEnabled(false) above). When an AI tool
// creates/deletes a cron job here, notify main over stdio so it reloads the
// store and (re)arms its scheduler — otherwise AI-created jobs never fire.
setCronChangedSink(() => {
  stdioTransport.send(createNotification("agent/cronChanged", {}));
});

// Disk-only active-goal reader for agent/goalGet. In worker mode there is no
// legacyEngine, and reopening a session after restart doesn't create a live
// ChatSession (that only happens on a send), so chatManager.get() misses. This
// reads the same ~/.code-shell/sessions/<id>/state.json every Engine writes, so
// the goal block re-surfaces on load ("goal 还在但页面不显示" fix).
const goalDiskReader = new SessionManager();

const agentServer = new AgentServer({
  chatManager,
  transport: stdioTransport,
  workspaceBridge: true,
  // Config hot-reload (layer 2) reads disk through the SAME closure the
  // engineFactory uses for new sessions, so a reloaded running session and a
  // newly-created session converge on identical disk config (no divergence).
  settingsReader: freshSettings,
  readActiveGoalFromDisk: (sessionId) => goalDiskReader.readActiveGoal(sessionId),
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
