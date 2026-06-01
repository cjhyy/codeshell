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
  type AgentDefinition,
} from "@cjhyy/code-shell-core";
import { assertCodeShellMarkdownPath } from "./safe-read.js";
import { promises as fs } from "node:fs";
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
 * List merged agents (project + user). Does NOT apply disabledAgents —
 * the UI shows disabled rows too (with a checkbox), so it needs them all.
 */
export function listAgents(cwd: string): AgentSummary[] {
  const reg = loadAgentDefinitionsForCwd(cwd, []);
  return reg.list().map((d) => ({
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
  }));
}

export async function readAgentBody(filePath: string): Promise<string> {
  assertCodeShellMarkdownPath(filePath);
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
  const name = normalizeAgentName(def.name);
  const clean: AgentDefinition = {
    name,
    description: def.description,
    model: def.model || undefined,
    maxTurns: typeof def.maxTurns === "number" ? def.maxTurns : undefined,
    tools:
      Array.isArray(def.tools) && def.tools.length > 0 ? def.tools : undefined,
    systemPrompt: def.systemPrompt ?? "",
  };
  const root = agentsRootFor(opts);
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, `${name}.md`);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refuse to write outside agents dir: ${target}`);
  }
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, serializeAgentDefinition(clean), "utf8");
  await fs.rename(tmp, target);
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
  const root = agentsRootFor(opts);
  const target = path.join(root, `${safe}.md`);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refuse to delete outside agents dir: ${target}`);
  }
  await fs.rm(target, { force: true });
}
