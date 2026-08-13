/**
 * Read + write sub-agent role definitions for the Settings panel.
 *
 * Mirrors skills-service.ts: the main process imports core's registry
 * directly (data is "what's on disk"). Listing merges project-level
 * (.code-shell/agents, ships the built-in 4) with user-level
 * (~/.code-shell/agents). Writes only ever touch the USER-level dir —
 * editing a built-in produces a same-named user override file; the
 * project-level built-in files are never modified.
 */

import {
  loadAgentDefinitionsForCwd,
  serializeAgentDefinition,
  SettingsManager,
  type AgentDefinition,
} from "@cjhyy/code-shell-core";
import { computeEffectiveDisabledLists } from "@cjhyy/code-shell-core/internal";
import { assertCodeShellMarkdownPath, rememberCodeShellMarkdownPath } from "./safe-read.js";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";

export interface AgentSummary {
  name: string;
  description: string;
  model?: string;
  maxTurns?: number;
  tools?: string[];
  systemPrompt: string;
  // Mirrors the registry's source union — agents can also come from plugins
  // (pluginAgentDirs). The previous "project" | "user" couldn't hold a
  // plugin-sourced agent and broke the desktop typecheck.
  source: "project" | "user" | "plugin";
  override: boolean;
  /** Sources this def shadows (e.g. ["user"] when a project agent overrides a
   *  same-named user one). Drives the "本项目覆盖" warning in the settings UI. */
  shadowedSources?: Array<"project" | "user" | "plugin">;
  filePath: string;
}

function userAgentsRoot(): string {
  return path.join(os.homedir(), ".code-shell", "agents");
}

function projectAgentsRoot(cwd: string): string {
  if (!cwd || !cwd.trim()) throw new Error("project-scope agent write requires cwd");
  return path.join(cwd, ".code-shell", "agents");
}

/** Resolve the agents dir for a write/delete. Default (no opts) = user dir. */
function agentsRootFor(opts?: { scope?: "user" | "project"; cwd?: string }): string {
  if (opts?.scope === "project") return projectAgentsRoot(opts.cwd ?? "");
  return userAgentsRoot();
}

/**
 * List merged agents (project + user + plugin). Does NOT apply disabledAgents
 * — the UI shows disabled agent ROWS too (with a checkbox), so it needs them
 * all. But it DOES exclude agents from plugins that are disabled in this cwd:
 * a closed plugin isn't used in this project, so its sub-agents shouldn't
 * clutter the list (mirrors the engine, which passes disabledPlugins too).
 */
export function listAgents(cwd: string): AgentSummary[] {
  let disabledPlugins: string[];
  try {
    disabledPlugins = computeEffectiveDisabledLists(
      new SettingsManager(cwd || process.cwd(), "full"),
      cwd || undefined,
    ).disabledPlugins;
  } catch {
    disabledPlugins = [];
  }
  const reg = loadAgentDefinitionsForCwd(cwd, [], disabledPlugins);
  return reg.list().map((d) => {
    if (d.filePath) rememberCodeShellMarkdownPath(d.filePath);
    return {
      name: d.name,
      description: d.description,
      model: d.model,
      maxTurns: d.maxTurns,
      tools: d.tools,
      systemPrompt: d.systemPrompt,
      source: d.source ?? "project",
      override: d.override === true,
      shadowedSources: d.shadowedSources,
      filePath: d.filePath ?? "",
    };
  });
}

export async function readAgentBody(filePath: string): Promise<string> {
  assertCodeShellMarkdownPath(filePath);
  const info = await fs.stat(filePath);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) {
    throw new Error("agent file is not a bounded regular file");
  }
  return fs.readFile(filePath, "utf8");
}

function normalizeAgentName(input: string): string {
  const name = input
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!name) throw new Error("子代理名称不能为空");
  return name;
}

function assertAgentDefinition(def: AgentDefinition): void {
  if (
    typeof def.description !== "string" ||
    def.description.length > 4_096 ||
    def.description.includes("\0") ||
    (def.model !== undefined &&
      (typeof def.model !== "string" || def.model.length > 512 || def.model.includes("\0"))) ||
    (def.maxTurns !== undefined &&
      (!Number.isSafeInteger(def.maxTurns) || def.maxTurns < 1 || def.maxTurns > 1_000)) ||
    (def.systemPrompt !== undefined &&
      (typeof def.systemPrompt !== "string" || def.systemPrompt.length > 1024 * 1024)) ||
    (def.tools !== undefined &&
      (!Array.isArray(def.tools) ||
        def.tools.length > 256 ||
        def.tools.some(
          (tool) =>
            typeof tool !== "string" || !tool || tool.length > 512 || tool.includes("\0"),
        )))
  ) {
    throw new Error("invalid or unbounded agent definition");
  }
}

async function safeAgentsRootFor(opts?: {
  scope?: "user" | "project";
  cwd?: string;
}): Promise<string> {
  const root = agentsRootFor(opts);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await fs.realpath(root);
  if (opts?.scope === "project") {
    const realProject = await fs.realpath(opts.cwd ?? "");
    const rel = path.relative(realProject, realRoot);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("project agents directory escapes the project root");
    }
  }
  return realRoot;
}

/**
 * Write an agent definition as <name>.md (atomic: .tmp + rename). Default
 * scope is "user" (~/.code-shell/agents) — back-compat for existing callers.
 * scope:"project" writes ${cwd}/.code-shell/agents (requires cwd), so a repo
 * can ship/override an agent that wins over the user version (spec §7.2).
 */
export async function saveAgent(
  def: AgentDefinition,
  opts?: { scope?: "user" | "project"; cwd?: string },
): Promise<AgentSummary> {
  assertAgentDefinition(def);
  const name = normalizeAgentName(def.name);
  const clean: AgentDefinition = {
    name,
    description: def.description,
    model: def.model || undefined,
    maxTurns: typeof def.maxTurns === "number" ? def.maxTurns : undefined,
    tools: Array.isArray(def.tools) && def.tools.length > 0 ? def.tools : undefined,
    systemPrompt: def.systemPrompt ?? "",
  };
  const root = await safeAgentsRootFor(opts);
  const target = path.join(root, `${name}.md`);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refuse to write outside agents dir: ${target}`);
  }
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, serializeAgentDefinition(clean), { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, target);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
  rememberCodeShellMarkdownPath(target);
  return {
    name,
    description: clean.description,
    model: clean.model,
    maxTurns: clean.maxTurns,
    tools: clean.tools,
    systemPrompt: clean.systemPrompt,
    source: opts?.scope === "project" ? "project" : "user",
    override: false,
    filePath: target,
  };
}

/**
 * Delete an agent file. Default scope "user" (~/.code-shell/agents);
 * scope:"project" deletes from ${cwd}/.code-shell/agents. Refuses anything
 * outside the resolved agents dir. Deleting a project agent only removes the
 * project definition — a same-named user/plugin agent stays intact.
 */
export async function deleteAgent(
  name: string,
  opts?: { scope?: "user" | "project"; cwd?: string },
): Promise<void> {
  const safe = normalizeAgentName(name);
  const root = await safeAgentsRootFor(opts);
  const target = path.join(root, `${safe}.md`);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refuse to delete outside agents dir: ${target}`);
  }
  await fs.rm(target, { force: true });
}
