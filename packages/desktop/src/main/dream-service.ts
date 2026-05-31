/**
 * dream-service — manual "整理 / Dream" trigger for the desktop host.
 *
 * The renderer's memory page exposes a button to run a one-off dream
 * consolidation (dedup / merge / drop-stale across the `dream` memory scope).
 * That work needs an LLM client + the Memory* tools, but the Electron MAIN
 * process never constructs an Engine — only the agent worker subprocess does
 * (see core's cli/agent-server-stdio.ts). Rather than build request/response
 * correlation over the fire-and-forget AgentBridge pipe, we reuse the worker's
 * exact "seed Engine" bootstrap here: construct an Engine purely to populate
 * the model pool + tool registry from settings, then hand its tool registry +
 * a freshly-built LLM client to core's runDreamConsolidation.
 *
 * The seed Engine never runs a turn — it's discarded after we extract the
 * pieces. Dream writes only to the `dream` scope (core enforces this), and the
 * MemoryManager it uses points at the same on-disk memory dir the worker and
 * the renderer's memory:* handlers use, so the data stays consistent.
 */

import {
  Engine,
  SettingsManager,
  createLLMClient,
  runDreamConsolidation,
} from "@cjhyy/code-shell-core";
import { dlog } from "./desktop-logger.js";

export type DreamLevel = "user" | "project";

export interface DreamResult {
  ran: boolean;
  summary: string;
}

/**
 * Run one dream consolidation pass.
 *
 *   - level="user":    consolidate the global dream scope (~/.code-shell/memory).
 *   - level="project": consolidate the active repo's dream scope; requires cwd.
 *
 * Returns { ran, summary }. `ran` is false only when the tool registry is
 * missing the Memory* tools (shouldn't happen with default settings). Throws
 * on bootstrap failure (e.g. no model/API key configured) so the IPC layer can
 * surface it to the renderer.
 */
export async function runDream(level: DreamLevel, cwd?: string): Promise<DreamResult> {
  if (level === "project" && !cwd) {
    throw new Error("project dream requires a cwd (open a project first)");
  }
  // For user-level dream we still need a cwd to seed the Engine (settings read,
  // working dir); the consolidation itself runs with projectDir undefined so it
  // targets the global memory dir. Fall back to process.cwd() for the seed.
  const seedCwd = cwd ?? process.cwd();
  const projectDir = level === "project" ? cwd : undefined;

  dlog("main", "start", { level, cwd, projectDir });

  // ─── Seed Engine — same bootstrap the agent worker uses ───────────
  // Read settings to derive the seed llm config, exactly like
  // cli/agent-server-stdio.ts. Engine's constructor then calls
  // populateModelPoolFromSettings() which resolves the active model from
  // settings.models[]/activeKey (overwriting this seed) and builds the tool
  // registry. "full" scope so we read the user's ~/.code-shell config too.
  const settings = new SettingsManager(seedCwd, "full").get();
  const llmConfig = {
    provider: settings.model.provider,
    model: settings.model.name,
    apiKey: settings.model.apiKey ?? "",
    baseUrl: settings.model.baseUrl,
    maxTokens: settings.model.maxTokens,
  };
  const seedEngine = new Engine({
    llm: llmConfig,
    cwd: seedCwd,
    settingsScope: "full",
    // Memory tools aren't in the default agent preset, so a plain seed Engine's
    // registry lacks them and runDreamConsolidation would bail with "缺少记忆
    // 工具". Enable them explicitly — the dream loop only ever calls these four.
    enabledBuiltinTools: ["MemoryList", "MemoryRead", "MemorySave", "MemoryDelete"],
  });

  const toolRegistry = seedEngine.getToolRegistry();
  const resolved = seedEngine.getConfig();
  const llmClient = await createLLMClient(resolved.llm, resolved.clientDefaults);

  try {
    const result = await runDreamConsolidation({
      llmClient,
      toolRegistry,
      toolContext: seedEngine.buildToolContext(),
      projectDir,
    });
    dlog("main", "done", { level, ran: result.ran, summaryLen: result.summary.length });
    return result;
  } catch (err) {
    dlog("main", "error", { level, error: (err as Error).message });
    throw err;
  }
}
