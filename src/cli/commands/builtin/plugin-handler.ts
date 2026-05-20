/**
 * `/plugin` slash command dispatcher. Parses subcommand args and calls
 * into the plugin marketplace modules. Returns a multi-line status
 * string the slash command can pass to ctx.addStatus.
 */

import {
  parseMarketplaceInput,
  deriveMarketplaceName,
} from "../../../plugins/parseMarketplaceInput.js";
import {
  addMarketplace,
  listMarketplaces,
  removeMarketplace,
} from "../../../plugins/marketplaceManager.js";
import {
  installPlugin,
  uninstallPlugin,
  listInstalled,
} from "../../../plugins/pluginInstaller.js";
import { invalidateSkillCache } from "../../../skills/scanner.js";

const USAGE = [
  "Usage:",
  "  /plugin marketplace add <git-url-or-owner/repo>",
  "  /plugin marketplace remove <name>",
  "  /plugin marketplace list",
  "  /plugin install <plugin>@<marketplace>",
  "  /plugin uninstall <plugin>@<marketplace>",
  "  /plugin list",
].join("\n");

function splitInstallKey(arg: string): { plugin: string; marketplace: string } | null {
  const atIdx = arg.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === arg.length - 1) return null;
  return { plugin: arg.slice(0, atIdx), marketplace: arg.slice(atIdx + 1) };
}

export async function runPluginCommand(rawArg: string): Promise<string> {
  const args = rawArg.trim().split(/\s+/).filter(Boolean);
  if (args.length === 0) return USAGE;

  const sub = args[0]!;

  if (sub === "marketplace") {
    const op = args[1];
    if (op === "add") {
      const input = args.slice(2).join(" ").trim();
      if (!input) return "Usage: /plugin marketplace add <git-url-or-owner/repo>";
      const source = parseMarketplaceInput(input);
      if (!source) {
        return `Cannot parse "${input}" as a marketplace source.\nSupported forms: owner/repo, https://...git, git@host:owner/repo[.git], /abs/path/to/repo.git`;
      }
      const name = deriveMarketplaceName(source);
      const r = await addMarketplace(name, source);
      if (!r.ok) return `Failed to add marketplace "${name}": ${r.error}`;
      const lines = [
        r.replaced ? `Refreshed marketplace "${r.name}"` : `Added marketplace "${r.name}"`,
        `  plugins available: ${r.marketplace.plugins.length}`,
      ];
      for (const p of r.marketplace.plugins.slice(0, 10)) {
        lines.push(`    - ${p.name}${p.description ? `: ${p.description}` : ""}`);
      }
      if (r.marketplace.plugins.length > 10) {
        lines.push(`    ... (${r.marketplace.plugins.length - 10} more)`);
      }
      return lines.join("\n");
    }
    if (op === "remove") {
      const name = args[2];
      if (!name) return "Usage: /plugin marketplace remove <name>";
      const removed = removeMarketplace(name);
      invalidateSkillCache();
      return removed ? `Removed marketplace "${name}"` : `Marketplace "${name}" not found`;
    }
    if (op === "list" || op === undefined) {
      const list = listMarketplaces();
      if (list.length === 0) return "No marketplaces. Use /plugin marketplace add <url>.";
      const lines = [`Marketplaces (${list.length}):`];
      for (const m of list) {
        const src =
          m.source.source === "github" ? `github:${m.source.repo}` : m.source.url;
        const count = m.pluginCount >= 0 ? `${m.pluginCount} plugins` : "manifest unreadable";
        lines.push(`  ${m.name}  (${src})  — ${count}`);
      }
      return lines.join("\n");
    }
    return `Unknown subcommand "marketplace ${op}".\n${USAGE}`;
  }

  if (sub === "install") {
    const target = args[1];
    if (!target) return "Usage: /plugin install <plugin>@<marketplace>";
    const parsed = splitInstallKey(target);
    if (!parsed) return `Expected <plugin>@<marketplace>, got "${target}"`;
    const r = await installPlugin(parsed.plugin, parsed.marketplace);
    if (!r.ok) return `Failed to install ${target}: ${r.error}`;
    invalidateSkillCache();
    const lines = [
      `Installed ${target}`,
      `  version: ${r.entry.version}`,
      `  path:    ${r.entry.installPath}`,
    ];
    if (r.varRewrite.filesRewritten > 0) {
      // Tell the user we modified plugin files in place so a later diff
      // against upstream doesn't look like a mystery.
      lines.push(
        `  rewrote: ${r.varRewrite.filesRewritten} file(s) — \${CLAUDE_PLUGIN_ROOT} → \${CODESHELL_PLUGIN_ROOT}`,
      );
    }
    return lines.join("\n");
  }

  if (sub === "uninstall") {
    const target = args[1];
    if (!target) return "Usage: /plugin uninstall <plugin>@<marketplace>";
    const parsed = splitInstallKey(target);
    if (!parsed) return `Expected <plugin>@<marketplace>, got "${target}"`;
    const r = uninstallPlugin(parsed.plugin, parsed.marketplace);
    invalidateSkillCache();
    if (!r.removedFromManifest && !r.removedFromDisk) return `${target} was not installed`;
    const bits: string[] = [];
    if (r.removedFromManifest) bits.push("manifest entry");
    if (r.removedFromDisk) bits.push("cache dir");
    return `Uninstalled ${target} (removed ${bits.join(" + ")})`;
  }

  if (sub === "list") {
    const list = listInstalled();
    if (list.length === 0) return "No plugins installed.";
    const lines = [`Installed plugins (${list.length}):`];
    for (const { key, entry } of list) {
      lines.push(`  ${key}  v${entry.version}  ${entry.installPath}`);
    }
    return lines.join("\n");
  }

  return `Unknown subcommand "${sub}".\n${USAGE}`;
}
