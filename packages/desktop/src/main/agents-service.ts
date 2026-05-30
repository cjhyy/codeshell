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
  source: "project" | "user";
  override: boolean;
  filePath: string;
}

function userAgentsRoot(): string {
  return path.join(os.homedir(), ".code-shell", "agents");
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
 * Write an agent definition to the user-level dir as <name>.md (atomic:
 * .tmp + rename). Used for both new user agents and overrides of a
 * built-in (same name → creates ~/.code-shell/agents/<name>.md).
 */
export async function saveAgent(def: AgentDefinition): Promise<AgentSummary> {
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
  const root = userAgentsRoot();
  await fs.mkdir(root, { recursive: true });
  const target = path.join(root, `${name}.md`);
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
    source: "user",
    override: false,
    filePath: target,
  };
}

/**
 * Delete a USER-level agent file (a custom agent or a built-in override).
 * Refuses anything outside ~/.code-shell/agents — built-in project files
 * are never deletable here (the UI offers "disable" for those instead).
 */
export async function deleteAgent(name: string): Promise<void> {
  const safe = normalizeAgentName(name);
  const root = userAgentsRoot();
  const target = path.join(root, `${safe}.md`);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`refuse to delete outside user agents dir: ${target}`);
  }
  await fs.rm(target, { force: true });
}
