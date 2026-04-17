/**
 * ArenaToolSelector — selects tool packs based on ArenaPlan sources.
 *
 * Maps evidence sources to subsets of the existing context tools.
 * This replaces the hard-coded "always give all tools" approach.
 */

import type { ArenaPlan, ArenaToolPack, ArenaSourceKind } from "../types.js";
import type { ToolDefinition } from "../../types.js";
import { CONTEXT_TOOLS } from "../context/context-tools.js";

/** Predefined tool packs by source kind */
const TOOL_PACKS: Record<string, ArenaToolPack> = {
  repo_readonly: {
    name: "repo_readonly",
    toolNames: ["read_file", "grep_code", "list_files"],
  },
  git: {
    name: "git",
    toolNames: ["read_file", "grep_code", "list_files", "git_show", "git_blame"],
  },
  docs: {
    name: "docs",
    toolNames: ["read_file", "list_files"],
  },
  no_tools: {
    name: "no_tools",
    toolNames: [],
  },
};

/** Map source kind to default tool pack */
const SOURCE_TO_PACK: Record<ArenaSourceKind, string> = {
  git: "git",
  repo: "repo_readonly",
  docs: "docs",
  web: "no_tools", // web tools not yet available in arena context
  none: "no_tools",
};

/**
 * Select the appropriate tools for a given plan.
 * Merges tool packs from all active sources, deduplicating by name.
 */
export function selectTools(plan: ArenaPlan): ToolDefinition[] {
  const toolNames = new Set<string>();

  for (const source of plan.sources) {
    const packName = source.toolPack ?? SOURCE_TO_PACK[source.kind] ?? "no_tools";
    const pack = TOOL_PACKS[packName] ?? TOOL_PACKS.no_tools;
    for (const name of pack.toolNames) {
      toolNames.add(name);
    }
  }

  if (toolNames.size === 0) return [];

  return CONTEXT_TOOLS.filter((t) => toolNames.has(t.name));
}

/**
 * Check whether any tools are available for the plan.
 */
export function hasTools(plan: ArenaPlan): boolean {
  return plan.sources.some((s) => {
    const packName = SOURCE_TO_PACK[s.kind];
    const pack = TOOL_PACKS[packName];
    return pack && pack.toolNames.length > 0;
  });
}
