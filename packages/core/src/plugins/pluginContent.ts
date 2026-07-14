/**
 * Plugin content inventory (插件详情页) — enumerate everything one installed
 * plugin contributes: skills, commands, agents, hooks, MCP servers. The
 * plugins list only showed "N skills", so users couldn't see what a plugin
 * actually installs (feedback#15). Read-only; reuses the same parsers the
 * loaders use so the inventory can't drift from what actually loads.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../skills/frontmatter.js";
import { listPluginHooks, type PluginHookEntry } from "./loadPluginHooks.js";
import { mergePluginMcpServers } from "./installer/loadPluginMcp.js";
import {
  CANONICAL_PLUGIN_MANIFEST_FILE,
  CanonicalPluginManifest,
  type PluginPanelManifestEntry,
} from "./installer/types.js";

export interface PluginContentInventory {
  /** skills/<name>/SKILL.md — name + frontmatter description when present. */
  skills: { name: string; description?: string }[];
  /** commands/<name>.md */
  commands: string[];
  /** agents/<name>.md */
  agents: string[];
  /** hooks/hooks.json entries (event + command), owner-filtered. */
  hooks: PluginHookEntry[];
  /** MCP server names as merged (keyed `<plugin>:<server>` — bare name here). */
  mcpServers: string[];
  /** Sandboxed desktop panels declared by the canonical plugin manifest. */
  panels: PluginPanelManifestEntry[];
}

function listMdNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function listSkills(installPath: string): { name: string; description?: string }[] {
  const dir = join(installPath, "skills");
  if (!existsSync(dir)) return [];
  const out: { name: string; description?: string }[] = [];
  try {
    for (const entry of readdirSync(dir).sort()) {
      const skillMd = join(dir, entry, "SKILL.md");
      try {
        if (!statSync(join(dir, entry)).isDirectory() || !existsSync(skillMd)) continue;
        const { frontmatter } = parseFrontmatter(readFileSync(skillMd, "utf-8"));
        const desc =
          typeof frontmatter.description === "string" ? frontmatter.description : undefined;
        out.push({ name: entry, description: desc });
      } catch {
        // unreadable skill dir — skip, same as the loader would
      }
    }
  } catch {
    return [];
  }
  return out;
}

/**
 * Inventory one plugin's contributions. `pluginName` is the bare name (no
 * @marketplace); `installPath` its install dir. Hooks/MCP go through the same
 * scanners the runtime loaders use (filtered to this plugin) so naming —
 * e.g. MCP's `<plugin>:<server>` record keys — matches what users see live.
 */
export function describePluginContent(
  pluginName: string,
  installPath: string,
): PluginContentInventory {
  const mcpPrefix = `${pluginName}:`;
  const mcpServers = (() => {
    try {
      return Object.keys(mergePluginMcpServers({}))
        .filter((k) => k.startsWith(mcpPrefix))
        .map((k) => k.slice(mcpPrefix.length))
        .sort();
    } catch {
      return [];
    }
  })();
  const hooks: PluginHookEntry[] = (() => {
    try {
      return listPluginHooks().filter((h) => h.plugin === pluginName);
    } catch {
      return [];
    }
  })();
  const panels: PluginPanelManifestEntry[] = (() => {
    try {
      const canonical = CanonicalPluginManifest.parse(
        JSON.parse(readFileSync(join(installPath, CANONICAL_PLUGIN_MANIFEST_FILE), "utf-8")),
      );
      return canonical.panels?.entries ?? [];
    } catch {
      return [];
    }
  })();
  return {
    skills: listSkills(installPath),
    commands: listMdNames(join(installPath, "commands")),
    agents: listMdNames(join(installPath, "agents")),
    hooks,
    mcpServers,
    panels,
  };
}
