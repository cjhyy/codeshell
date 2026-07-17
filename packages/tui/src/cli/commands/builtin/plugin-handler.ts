/**
 * `/plugin` slash command dispatcher. Parses subcommand args and calls
 * into the plugin marketplace modules. Returns a multi-line status
 * string the slash command can pass to ctx.addStatus.
 */

import {
  parseMarketplaceInput,
  deriveMarketplaceName,
  SettingsManager,
} from "@cjhyy/code-shell-core";
import { addMarketplace, listMarketplaces, removeMarketplace } from "@cjhyy/code-shell-core";
import {
  approvePluginHooks,
  approvePluginMcp,
  installPlugin,
  listPluginMcpTrust,
  listPluginHooks,
  reviewPluginHooks,
  revokePluginMcp,
  revokePluginHooks,
  uninstallPlugin,
  listInstalled,
  loadPluginAutomationTemplateContributions,
  instantiatePluginAutomationTemplate,
} from "@cjhyy/code-shell-core";
import { invalidateSkillCache } from "@cjhyy/code-shell-core";
import {
  computeEffectiveDisabledLists,
  cronScheduler,
  type CronScheduler,
} from "@cjhyy/code-shell-core/internal";

const USAGE = [
  "Usage:",
  "  /plugin marketplace add <git-url-or-owner/repo>",
  "  /plugin marketplace remove <name>",
  "  /plugin marketplace list",
  "  /plugin install <plugin>@<marketplace>",
  "  /plugin uninstall <plugin>@<marketplace>",
  "  /plugin list",
  "  /plugin hooks list",
  "  /plugin hooks diff <plugin-or-install-key>",
  "  /plugin hooks approve <plugin-or-install-key>",
  "  /plugin hooks revoke <plugin-or-install-key>",
  "  /plugin mcp list",
  "  /plugin mcp approve <plugin-or-install-key>",
  "  /plugin mcp revoke <plugin-or-install-key>",
  "  /plugin mcp enable <plugin:server>",
  "  /plugin mcp disable <plugin:server>",
  "  /plugin mcp tools <plugin:server>",
  "  /plugin mcp allow <plugin:server> <tool...>",
  "  /plugin mcp deny <plugin:server> <tool...>",
  "  /plugin mcp tools-reset <plugin:server>",
  "  /plugin automations list",
  "  /plugin automations show <install-key> <template-id>",
  "  /plugin automations create <install-key> <template-id> --revision <sha256> --confirm",
].join("\n");

function splitInstallKey(arg: string): { plugin: string; marketplace: string } | null {
  const atIdx = arg.lastIndexOf("@");
  if (atIdx <= 0 || atIdx === arg.length - 1) return null;
  return { plugin: arg.slice(0, atIdx), marketplace: arg.slice(atIdx + 1) };
}

export function pluginHookDecisionSucceeded(rawArg: string, output: string): boolean {
  return pluginTrustDecisionSucceeded(rawArg, output);
}

export function pluginTrustDecisionSucceeded(rawArg: string, output: string): boolean {
  return (
    /^(?:hooks\s+(?:approve|revoke)|mcp\s+(?:approve|revoke|enable|disable|allow|deny|tools-reset))\s+\S+/u.test(
      rawArg.trim(),
    ) &&
    !output.startsWith("Failed to ") &&
    !output.startsWith("Usage:")
  );
}

function isInstalledPluginMcpServer(target: string): boolean {
  return listPluginMcpTrust().some((entry) =>
    entry.serverNames.some((name) => `${entry.plugin}:${name}` === target),
  );
}

function validateMcpToolNames(names: string[]): string | null {
  if (names.length === 0) return "at least one exact MCP tool name is required";
  if (names.length > 256) return "at most 256 MCP tool names are allowed";
  const invalid = names.find(
    (name) => name.length === 0 || name.length > 256 || name.includes("\0") || /\s/u.test(name),
  );
  return invalid ? `invalid MCP tool name "${invalid}"` : null;
}

export interface RunPluginCommandOptions {
  /** Injection point for isolated hosts/tests; the interactive TUI uses its singleton. */
  automationScheduler?: CronScheduler;
}

export async function runPluginCommand(
  rawArg: string,
  cwd = process.cwd(),
  options: RunPluginCommandOptions = {},
): Promise<string> {
  const automationScheduler = options.automationScheduler ?? cronScheduler;
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
        const src = m.source.source === "github" ? `github:${m.source.repo}` : m.source.url;
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
    if (r.entry.hookDigest && !r.entry.approvedHookDigest) {
      lines.push(`  hooks:   pending approval — run /plugin hooks approve ${target}`);
    }
    if (r.entry.mcpDigest && !r.entry.approvedMcpDigest) {
      lines.push(`  MCP:     pending approval — run /plugin mcp approve ${target}`);
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

  if (sub === "automations") {
    const op = args[1] ?? "list";
    const templates = loadPluginAutomationTemplateContributions();
    if (op === "list") {
      if (templates.length === 0) return "No installed plugin automation templates.";
      const lines = [`Plugin automation templates (${templates.length}):`];
      for (const entry of templates) {
        lines.push(
          `  ${entry.installKey}/${entry.template.id}  ${entry.template.title.default}`,
          `    schedule=${entry.template.schedule} permission=${entry.template.permissionLevel} workspace=${entry.template.workspace}`,
          `    revision=${entry.revision}`,
        );
      }
      lines.push("Review one with /plugin automations show <install-key> <template-id>.");
      return lines.join("\n");
    }
    if (op === "show" || op === "create") {
      const installKey = args[2];
      const templateId = args[3];
      if (!installKey || !templateId) {
        return `Usage: /plugin automations ${op} <install-key> <template-id>${
          op === "create" ? " --revision <sha256> --confirm" : ""
        }`;
      }
      const contribution = templates.find(
        (entry) => entry.installKey === installKey && entry.template.id === templateId,
      );
      if (!contribution) {
        return `Failed to ${op === "show" ? "inspect" : "create"} automation: template ${installKey}/${templateId} is not installed`;
      }
      const template = contribution.template;
      const review = [
        `Automation template ${installKey}/${templateId}`,
        `  title:      ${template.title.default}`,
        `  schedule:   ${template.schedule}${template.timezone ? ` (${template.timezone})` : ""}`,
        `  permission: ${template.permissionLevel}`,
        `  workspace:  ${template.workspace}`,
        `  revision:   ${contribution.revision}`,
        "  prompt:",
        ...template.prompt.split("\n").map((line) => `    ${line}`),
      ];
      if (op === "show") {
        review.push(
          "Create only after review:",
          `  /plugin automations create ${installKey} ${templateId} --revision ${contribution.revision} --confirm`,
        );
        return review.join("\n");
      }
      const revisionIndex = args.indexOf("--revision");
      const expectedRevision = revisionIndex >= 0 ? args[revisionIndex + 1] : undefined;
      if (!args.includes("--confirm") || !expectedRevision) {
        review.push(
          "Not created: explicit confirmation and the reviewed revision are required.",
          `  /plugin automations create ${installKey} ${templateId} --revision ${contribution.revision} --confirm`,
        );
        return review.join("\n");
      }
      if (expectedRevision !== contribution.revision) {
        return `Failed to create automation from ${installKey}/${templateId}: template changed after review; run /plugin automations show again`;
      }
      try {
        const disabled = new Set(
          computeEffectiveDisabledLists(
            new SettingsManager(cwd || process.cwd(), "full"),
            cwd || undefined,
          ).disabledPlugins,
        );
        const job = instantiatePluginAutomationTemplate({
          scheduler: automationScheduler,
          installKey,
          templateId,
          expectedRevision,
          ...(template.workspace === "current" ? { cwd } : {}),
          disabledPluginNames: disabled,
        });
        return [
          `Created automation ${job.id} from ${installKey}/${templateId}`,
          `  schedule:   ${job.schedule}`,
          `  permission: ${job.permissionLevel ?? "read-only"}`,
          `  workspace:  ${job.cwd ?? "(none)"}`,
        ].join("\n");
      } catch (error) {
        return `Failed to create automation from ${installKey}/${templateId}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return `Unknown subcommand "automations ${op}".\n${USAGE}`;
  }

  if (sub === "hooks") {
    const op = args[1] ?? "list";
    if (op === "list") {
      const hooks = listPluginHooks();
      if (hooks.length === 0) return "No installed plugin hooks.";
      const lines = [`Plugin hooks (${hooks.length}):`];
      let previousKey: string | null = null;
      for (const hook of hooks) {
        if (hook.installKey !== previousKey) {
          lines.push(`  ${hook.installKey}  [${hook.approval}]`);
          previousKey = hook.installKey;
        }
        lines.push(`    ${hook.rawEvent} -> ${hook.command}`);
      }
      return lines.join("\n");
    }
    if (op === "diff") {
      const target = args[2];
      if (!target) return "Usage: /plugin hooks diff <plugin-or-install-key>";
      try {
        const reviews = reviewPluginHooks(target);
        return reviews
          .map((review) => {
            const lines = [
              `Hook review for ${review.installKey} [${review.status}]`,
              review.baselineAvailable
                ? "  baseline: last explicitly approved definition"
                : "  baseline: none (first approval; every command is new)",
            ];
            for (const item of review.items) {
              const current = item.current;
              const previous = item.previous;
              const marker =
                item.change === "added"
                  ? "+"
                  : item.change === "removed"
                    ? "-"
                    : item.change === "changed"
                      ? "~"
                      : "=";
              const hook = current ?? previous;
              if (!hook) continue;
              lines.push(`  ${marker} ${hook.rawEvent}  matcher=${hook.matcher || "(all)"}`);
              if (item.change === "changed" && previous && current) {
                lines.push(`      old: ${previous.command}`);
                lines.push(`      new: ${current.command}`);
              } else {
                lines.push(`      ${hook.command}`);
              }
            }
            if (review.items.length === 0) lines.push("  (no executable hooks)");
            if (review.error) lines.push(`  error: ${review.error}`);
            return lines.join("\n");
          })
          .join("\n\n");
      } catch (error) {
        return `Failed to review hooks for ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (op === "approve" || op === "revoke") {
      const target = args[2];
      if (!target) return `Usage: /plugin hooks ${op} <plugin-or-install-key>`;
      try {
        const results = op === "approve" ? approvePluginHooks(target) : revokePluginHooks(target);
        return results
          .map(
            (result) =>
              `${op === "approve" ? "Approved" : "Revoked"} hooks for ${result.installKey} [${result.status}]`,
          )
          .join("\n");
      } catch (error) {
        return `Failed to ${op} hooks for ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return `Unknown subcommand "hooks ${op}".\n${USAGE}`;
  }

  if (sub === "mcp") {
    const op = args[1] ?? "list";
    if (op === "list") {
      const entries = listPluginMcpTrust().filter((entry) => entry.status !== "none");
      if (entries.length === 0) return "No installed plugin MCP servers.";
      const lines = [`Plugin MCP trust (${entries.length}):`];
      for (const entry of entries) {
        lines.push(
          `  ${entry.installKey}  [${entry.status}]  ${entry.serverNames
            .map((name) => `${entry.plugin}:${name}`)
            .join(", ")}`,
        );
      }
      return lines.join("\n");
    }
    if (op === "approve" || op === "revoke") {
      const target = args[2];
      if (!target) return `Usage: /plugin mcp ${op} <plugin-or-install-key>`;
      try {
        const results = op === "approve" ? approvePluginMcp(target) : revokePluginMcp(target);
        return results
          .map(
            (result) =>
              `${op === "approve" ? "Approved" : "Revoked"} MCP for ${result.installKey} [${result.status}]`,
          )
          .join("\n");
      } catch (error) {
        return `Failed to ${op} MCP for ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (op === "enable" || op === "disable") {
      const target = args[2];
      if (!target) return `Usage: /plugin mcp ${op} <plugin:server>`;
      if (!isInstalledPluginMcpServer(target)) {
        return `Failed to ${op} MCP server ${target}: server is not installed`;
      }
      try {
        const settings = new SettingsManager(cwd, "full");
        const current = settings.getForScope("user").mcpServerOverrides ?? {};
        settings.saveUserSetting("mcpServerOverrides", {
          ...current,
          [target]: {
            ...(current[target] ?? {}),
            enabled: op === "enable",
          },
        });
        return `${op === "enable" ? "Enabled" : "Disabled"} MCP server ${target}`;
      } catch (error) {
        return `Failed to ${op} MCP server ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (op === "tools") {
      const target = args[2];
      if (!target) return "Usage: /plugin mcp tools <plugin:server>";
      if (!isInstalledPluginMcpServer(target)) {
        return `Failed to inspect MCP server ${target}: server is not installed`;
      }
      const settings = new SettingsManager(cwd, "full");
      const policy = settings.getForScope("user").mcpServerOverrides?.[target];
      return [
        `MCP tool policy for ${target}:`,
        `  allow: ${policy?.allowedTools?.join(", ") || "(all)"}`,
        `  deny:  ${policy?.disabledTools?.join(", ") || "(none)"}`,
      ].join("\n");
    }
    if (op === "allow" || op === "deny") {
      const target = args[2];
      if (!target) return `Usage: /plugin mcp ${op} <plugin:server> <tool...>`;
      if (!isInstalledPluginMcpServer(target)) {
        return `Failed to set MCP tool policy for ${target}: server is not installed`;
      }
      const names = [...new Set(args.slice(3))];
      const invalid = validateMcpToolNames(names);
      if (invalid) return `Failed to set MCP tool policy for ${target}: ${invalid}`;
      try {
        const settings = new SettingsManager(cwd, "full");
        const current = settings.getForScope("user").mcpServerOverrides ?? {};
        settings.saveUserSetting("mcpServerOverrides", {
          ...current,
          [target]: {
            ...(current[target] ?? {}),
            [op === "allow" ? "allowedTools" : "disabledTools"]: names,
          },
        });
        return `${op === "allow" ? "Allowed only" : "Denied"} ${names.length} MCP tool(s) for ${target}: ${names.join(", ")}`;
      } catch (error) {
        return `Failed to set MCP tool policy for ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (op === "tools-reset") {
      const target = args[2];
      if (!target) return "Usage: /plugin mcp tools-reset <plugin:server>";
      if (!isInstalledPluginMcpServer(target)) {
        return `Failed to reset MCP tool policy for ${target}: server is not installed`;
      }
      try {
        const settings = new SettingsManager(cwd, "full");
        const current = settings.getForScope("user").mcpServerOverrides ?? {};
        const { allowedTools: _allowed, disabledTools: _disabled, ...rest } = current[target] ?? {};
        const next = { ...current };
        if (Object.keys(rest).length > 0) next[target] = rest;
        else delete next[target];
        settings.saveUserSetting("mcpServerOverrides", next);
        return `Reset MCP tool policy for ${target}`;
      } catch (error) {
        return `Failed to reset MCP tool policy for ${target}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return `Unknown subcommand "mcp ${op}".\n${USAGE}`;
  }

  return `Unknown subcommand "${sub}".\n${USAGE}`;
}
