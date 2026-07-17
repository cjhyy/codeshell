/**
 * Plugin content inventory (插件详情页) — enumerate everything one installed
 * plugin contributes: skills, commands, agents, hooks, MCP servers. The
 * plugins list only showed "N skills", so users couldn't see what a plugin
 * actually installs (feedback#15). Read-only; reuses the same parsers the
 * loaders use so the inventory can't drift from what actually loads.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseFrontmatter } from "../skills/frontmatter.js";
import { listPluginHooks, type PluginHookEntry } from "./loadPluginHooks.js";
import { reviewPluginHooks, type PluginHookReview } from "./pluginHookApproval.js";
import { readPluginMcp } from "./installer/loadPluginMcp.js";
import {
  CANONICAL_PLUGIN_MANIFEST_FILE,
  CanonicalPluginManifest,
  type PluginAutomationTemplate,
  type PluginPanelManifestEntry,
} from "./installer/types.js";
import { pluginAutomationTemplateRevision } from "./pluginCatalog.js";

export type PluginAutomationTemplateDescriptor = PluginAutomationTemplate & {
  revision: string;
};

export interface PluginContentInventory {
  /** skills/<name>/SKILL.md — name + frontmatter description when present. */
  skills: { name: string; description?: string }[];
  /** commands/<name>.md */
  commands: string[];
  /** agents/<name>.md */
  agents: string[];
  /** hooks/hooks.json entries (event + command), owner-filtered. */
  hooks: PluginHookEntry[];
  /** Current hook definition compared with the last explicitly approved snapshot. */
  hookReview?: PluginHookReview;
  /** MCP server names as merged (keyed `<plugin>:<server>` — bare name here). */
  mcpServers: string[];
  /** Sandboxed desktop panels declared by the canonical plugin manifest. */
  panels: PluginPanelManifestEntry[];
  /** Reusable scheduled-task templates; never instantiated automatically. */
  automationTemplates: PluginAutomationTemplateDescriptor[];
}

function resolveContainedPath(root: string, candidate: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const realCandidate = realpathSync(candidate);
    const rel = relative(realRoot, realCandidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return realCandidate;
  } catch {
    return null;
  }
}

function listMdNames(installPath: string, dirName: string): string[] {
  const dir = resolveContainedPath(installPath, join(installPath, dirName));
  if (!dir) return [];
  try {
    return readdirSync(dir)
      .filter((file) => {
        if (!file.endsWith(".md")) return false;
        const target = resolveContainedPath(dir, join(dir, file));
        if (!target) return false;
        try {
          return statSync(target).isFile();
        } catch {
          return false;
        }
      })
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {
    return [];
  }
}

function listSkills(installPath: string): { name: string; description?: string }[] {
  const dir = resolveContainedPath(installPath, join(installPath, "skills"));
  if (!dir) return [];
  const out: { name: string; description?: string }[] = [];
  try {
    for (const entry of readdirSync(dir).sort()) {
      try {
        const skillDir = resolveContainedPath(dir, join(dir, entry));
        if (!skillDir || !statSync(skillDir).isDirectory()) continue;
        const skillMd = resolveContainedPath(skillDir, join(skillDir, "SKILL.md"));
        if (!skillMd || !statSync(skillMd).isFile()) continue;
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
  installKey?: string,
): PluginContentInventory {
  const mcpPrefix = `${pluginName}:`;
  const mcpServers = (() => {
    try {
      return Object.keys(readPluginMcp(installPath, pluginName))
        .filter((k) => k.startsWith(mcpPrefix))
        .map((k) => k.slice(mcpPrefix.length))
        .sort();
    } catch {
      return [];
    }
  })();
  const hooks: PluginHookEntry[] = (() => {
    try {
      return listPluginHooks().filter(
        (h) => h.plugin === pluginName && (installKey === undefined || h.installKey === installKey),
      );
    } catch {
      return [];
    }
  })();
  const hookReview = (() => {
    if (!installKey) return undefined;
    try {
      return reviewPluginHooks(installKey)[0];
    } catch {
      return undefined;
    }
  })();
  const manifest = (() => {
    try {
      return CanonicalPluginManifest.parse(
        JSON.parse(readFileSync(join(installPath, CANONICAL_PLUGIN_MANIFEST_FILE), "utf-8")),
      );
    } catch {
      return null;
    }
  })();
  return {
    skills: listSkills(installPath),
    commands: listMdNames(installPath, "commands"),
    agents: listMdNames(installPath, "agents"),
    hooks,
    ...(hookReview ? { hookReview } : {}),
    mcpServers,
    panels: manifest?.panels?.entries ?? [],
    automationTemplates: (manifest?.automations?.templates ?? []).map((template) => ({
      ...template,
      revision: pluginAutomationTemplateRevision(installKey ?? pluginName, template),
    })),
  };
}
