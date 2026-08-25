/**
 * First-party conversational lifecycle manager for CodeShell capabilities.
 *
 * Read-only list/inspect actions are preset-allowed; every mutation is narrowed
 * by an action-specific permission rule and remains approval-gated. Arguments
 * contain the exact source, scope and executable/URL that will be persisted or
 * run. The implementation deliberately reuses host installers instead of
 * asking the model to synthesize shell commands or edit settings JSON by hand.
 */

import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { ToolDefinition } from "../../types.js";
import type { ToolContext } from "../context.js";
import { SettingsManager } from "../../settings/manager.js";
import { SKILL_REPO_RE, type SkillRequirement } from "../../profile/types.js";
import { buildSkillInstallArgs, summarizeSkillConflicts } from "../../profile/requirements.js";
import { invalidateSkillCache, scanSkills } from "../../skills/scanner.js";
import { installPlugin, listInstalled, uninstallPlugin } from "../../plugins/pluginInstaller.js";
import { describePluginContent } from "../../plugins/pluginContent.js";
import { listPluginMcpTrust } from "../../plugins/pluginMcpApproval.js";
import { loadMarketplace, refreshMarketplace } from "../../plugins/marketplaceManager.js";
import { readKnownMarketplaces } from "../../plugins/knownMarketplaces.js";
import { gitSparseCheckoutAdd } from "../../plugins/gitOps.js";
import { resolveContainedPluginSubpath } from "../../plugins/installer/sourcePath.js";
import { previewLocalPlugin, type LocalPluginPreview } from "../../plugins/installer/preview.js";
import type { PluginMarketplaceEntry } from "../../plugins/types.js";
import { computeEffectiveDisabledLists } from "../../capability-control/disabled-lists.js";
import { safeSpawn, type SafeSpawnResult } from "../../runtime/safe-spawn.js";
import { resolveExecutable } from "../../utils/exec.js";

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SAFE_PLUGIN_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SAFE_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_OVERRIDE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const MCP_TOOL_NAME_RE = /^[^\s\u0000-\u001F\u007F]{1,256}$/;
const INLINE_SECRET_FLAG_RE = /^--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)/i;
const INSTALL_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const MAX_RESULT_CHARS = 3_000;

interface MarketplacePluginPreview {
  entry: PluginMarketplaceEntry;
  inventory: LocalPluginPreview | null;
  note?: string;
}

type CapabilityChangedSink = () => void;
let capabilityChangedSink: CapabilityChangedSink | null = null;

/** Host notification seam. Desktop maps this to agent/settingsChanged. */
export function setCapabilityChangedSink(sink: CapabilityChangedSink | null): void {
  capabilityChangedSink = sink;
}

function fireCapabilityChanged(): void {
  try {
    capabilityChangedSink?.();
  } catch {
    // The capability is already installed. Host refresh is best-effort.
  }
}

export const installCapabilityToolDef: ToolDefinition = {
  name: "InstallCapability",
  description:
    "Inspect, install, update, enable, disable, or uninstall a CodeShell capability. Supports: " +
    "(1) a plugin from an already-added marketplace, (2) standalone Skills from a " +
    "trusted GitHub owner/repo into the current project, or (3) an MCP stdio/HTTP " +
    "server in local, project, or user settings. Use action='inspect' before installing unfamiliar " +
    "plugins or Skill repositories. Listing and plugin/MCP inspection are read-only; Skill " +
    "repository inspection starts an external discovery command. Every mutation and Skill " +
    "repository inspection requires user approval. Use AddMarketplace first when a plugin " +
    "marketplace is not registered. Never put " +
    "tokens, passwords, API keys, Authorization header values, or other secret values " +
    "in the arguments; reference environment-variable names instead.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "inspect", "install", "update", "enable", "disable", "uninstall"],
        description: "Lifecycle action. Defaults to install for backward compatibility.",
      },
      kind: {
        type: "string",
        enum: ["plugin", "skill", "mcp"],
        description: "Capability type to manage.",
      },
      scope: {
        type: "string",
        enum: ["local", "project", "user"],
        description:
          "MCP scope: local is private to this project, project is the shareable project layer " +
          "(default), and user applies across projects. Standalone Skills install at project " +
          "scope; marketplace plugin bundles install at user scope.",
      },
      plugin: {
        type: "string",
        description: "Plugin name for kind=plugin.",
      },
      marketplace: {
        type: "string",
        description: "Already-added marketplace name for kind=plugin.",
      },
      repo: {
        type: "string",
        description: "Trusted GitHub owner/repo (or https://github.com/owner/repo) for kind=skill.",
      },
      skills: {
        type: "array",
        items: { type: "string" },
        description:
          "Skill names to install from the repository. Omit to install every discovered Skill.",
      },
      full_depth: {
        type: "boolean",
        description: "For kind=skill, search all repository subdirectories.",
      },
      name: {
        type: "string",
        description: "MCP server name for kind=mcp.",
      },
      transport: {
        type: "string",
        enum: ["stdio", "sse", "streamable-http"],
        description: "MCP transport. Defaults to stdio when command is set, otherwise HTTP.",
      },
      command: {
        type: "string",
        description: "Executable only for a stdio MCP server (for example npx). Put flags in args.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Argument vector for a stdio MCP server.",
      },
      url: {
        type: "string",
        description: "HTTP/SSE MCP endpoint URL.",
      },
      env_vars: {
        type: "array",
        items: { type: "string" },
        description:
          "Environment-variable NAMES to forward to a stdio server. Never include values.",
      },
      bearer_token_env_var: {
        type: "string",
        description:
          "Environment-variable NAME containing the bearer token. Never include the token.",
      },
      env_headers: {
        type: "object",
        additionalProperties: { type: "string" },
        description:
          "HTTP header name to environment-variable NAME mapping. Never include header values.",
      },
      replace: {
        type: "boolean",
        description:
          "Allow replacing an existing MCP server or overwriting/shadowing an existing Skill.",
      },
      allowed_tools: {
        type: "array",
        items: { type: "string" },
        description: "Optional exact MCP tool allowlist. An empty list exposes no tools.",
      },
      disabled_tools: {
        type: "array",
        items: { type: "string" },
        description: "Optional exact MCP tool denylist, applied after allowed_tools.",
      },
    },
    required: ["kind"],
  },
};

export interface InstallCapabilityDeps {
  computeEffectiveDisabledLists: typeof computeEffectiveDisabledLists;
  describePluginContent: typeof describePluginContent;
  installPlugin: typeof installPlugin;
  invalidateSkillCache: typeof invalidateSkillCache;
  listInstalled: typeof listInstalled;
  listPluginMcpTrust: typeof listPluginMcpTrust;
  makeSettingsManager: (cwd: string, scope: "full" | "project") => SettingsManager;
  previewMarketplacePlugin: (
    plugin: string,
    marketplace: string,
  ) => Promise<MarketplacePluginPreview | { error: string }>;
  refreshMarketplace: typeof refreshMarketplace;
  resolveExecutable: typeof resolveExecutable;
  safeSpawn: typeof safeSpawn;
  scanSkills: typeof scanSkills;
  uninstallPlugin: typeof uninstallPlugin;
}

async function previewMarketplacePlugin(
  plugin: string,
  marketplace: string,
): Promise<MarketplacePluginPreview | { error: string }> {
  const manifest = loadMarketplace(marketplace);
  const entry = manifest?.plugins.find((candidate) => candidate.name === plugin);
  if (!manifest || !entry) {
    return { error: `plugin "${plugin}" was not found in marketplace "${marketplace}".` };
  }
  if (typeof entry.source !== "string") {
    return {
      entry,
      inventory: null,
      note: "This plugin uses an external Git source; its components will be discovered during installation.",
    };
  }

  const known = readKnownMarketplaces()[marketplace];
  if (!known) return { error: `marketplace "${marketplace}" is not registered.` };
  await gitSparseCheckoutAdd(known.installLocation, entry.source.replace(/^\.\//, ""));
  const contained = resolveContainedPluginSubpath(
    known.installLocation,
    entry.source,
    "plugin source path",
  );
  if (!contained.ok) return { error: contained.error };
  try {
    return {
      entry,
      inventory: await previewLocalPlugin({ kind: "dir", path: contained.path }),
    };
  } catch (error) {
    return {
      error: `plugin preview failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const defaultDeps: InstallCapabilityDeps = {
  computeEffectiveDisabledLists,
  describePluginContent,
  installPlugin,
  invalidateSkillCache,
  listInstalled,
  listPluginMcpTrust,
  makeSettingsManager: (cwd, scope) => new SettingsManager(cwd, scope),
  previewMarketplacePlugin,
  refreshMarketplace,
  resolveExecutable,
  safeSpawn,
  scanSkills,
  uninstallPlugin,
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeSegment(value: unknown): string | null {
  const candidate = text(value);
  return SAFE_NAME_RE.test(candidate) ? candidate : null;
}

function safePluginSegment(value: unknown): string | null {
  const candidate = text(value);
  return SAFE_PLUGIN_SEGMENT_RE.test(candidate) && candidate !== "." && candidate !== ".."
    ? candidate
    : null;
}

function actionOf(args: Record<string, unknown>): string {
  return text(args.action) || "install";
}

function normalizeGithubRepo(value: unknown): string | null {
  const candidate = text(value);
  if (SKILL_REPO_RE.test(candidate)) return candidate;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "github.com") return null;
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const repo = `${parts[0]}/${parts[1]!.replace(/\.git$/, "")}`;
  return SKILL_REPO_RE.test(repo) ? repo : null;
}

function cleanOutput(raw: string): string {
  const cleaned = stripVTControlCharacters(raw)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (cleaned.length <= MAX_RESULT_CHARS) return cleaned;
  const edge = Math.floor(MAX_RESULT_CHARS / 2);
  return `${cleaned.slice(0, edge)}\n… output truncated …\n${cleaned.slice(-edge)}`;
}

function validStringArray(value: unknown, pattern: RegExp, max = 128): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !pattern.test(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

function validArgv(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128) return null;
  for (const item of value) {
    if (typeof item !== "string" || item.length > 4_096 || /[\u0000\r\n]/.test(item)) {
      return null;
    }
  }
  return [...value] as string[];
}

function hasInlineCredentialArg(argv: readonly string[]): boolean {
  return argv.some((item) => {
    if (INLINE_SECRET_FLAG_RE.test(item) || /^authorization\s*:/i.test(item)) return true;
    try {
      const parsed = new URL(item);
      return Boolean(parsed.username || parsed.password);
    } catch {
      return false;
    }
  });
}

function validEnvHeaders(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) return null;
  const output: Record<string, string> = {};
  for (const [header, envName] of entries) {
    if (!HEADER_NAME_RE.test(header) || typeof envName !== "string" || !ENV_NAME_RE.test(envName)) {
      return null;
    }
    output[header] = envName;
  }
  return output;
}

function pluginPreviewLines(
  plugin: string,
  marketplace: string,
  preview: MarketplacePluginPreview,
): string[] {
  const metadata = preview.entry;
  const inventory = preview.inventory;
  const lines = [
    `Plugin ${plugin}@${marketplace}`,
    ...(metadata.description ? [`Description: ${metadata.description}`] : []),
    ...(metadata.version ? [`Declared version: ${metadata.version}`] : []),
    ...(metadata.author?.name ? [`Author: ${metadata.author.name}`] : []),
    ...(metadata.homepage ? [`Homepage: ${metadata.homepage}`] : []),
  ];
  if (!inventory) {
    lines.push(preview.note ?? "Component inventory is unavailable until installation.");
    return lines;
  }
  lines.push(
    `Skills: ${inventory.skills.map((skill) => skill.name).join(", ") || "none"}.`,
    `Agents: ${inventory.agents.join(", ") || "none"}.`,
    `Commands: ${inventory.commands.join(", ") || "none"}.`,
    `MCP servers: ${inventory.mcpServers.map((server) => `${server.name} (${server.transport})`).join(", ") || "none"}.`,
    `Executable hooks: ${inventory.hooks.length}.`,
    `Automation templates: ${inventory.automationTemplates.length}.`,
  );
  if (inventory.warnings.length > 0) {
    lines.push(
      `Review warnings: ${inventory.warnings.map((warning) => `${warning.kind}=${warning.count}`).join(", ")}.`,
    );
  }
  return lines;
}

function isSafeRemoteUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname.toLowerCase());
}

async function installMarketplacePlugin(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  if (args.scope !== undefined && args.scope !== "user") {
    return "Error: marketplace plugins currently install at user scope; omit scope or use scope='user'.";
  }
  if (ctx?.settingsScope !== "full") {
    return "Error: this host isolates user settings; marketplace plugins cannot be installed.";
  }
  const plugin = safePluginSegment(args.plugin);
  const marketplace = safePluginSegment(args.marketplace);
  if (!plugin) return "Error: kind=plugin requires a safe `plugin` name.";
  if (!marketplace) return "Error: kind=plugin requires a safe `marketplace` name.";

  let result = await deps.installPlugin(plugin, marketplace);
  if (!result.ok && result.error.includes("not found in marketplace")) {
    const refreshed = await deps.refreshMarketplace(marketplace);
    if (refreshed.ok) result = await deps.installPlugin(plugin, marketplace);
  }
  if (!result.ok) {
    return `Error: plugin installation failed: ${result.error}`;
  }

  deps.invalidateSkillCache();
  const installKey = `${plugin}@${marketplace}`;
  const content = deps.describePluginContent(plugin, result.entry.installPath, installKey);
  const mcpTrust = deps.listPluginMcpTrust().find((entry) => entry.installKey === installKey);
  fireCapabilityChanged();

  const lines = [
    `Installed plugin ${installKey} (${result.entry.version}).`,
    `Skills: ${content.skills.map((skill) => `${plugin}:${skill.name}`).join(", ") || "none"}.`,
    `Agents: ${content.agents.join(", ") || "none"}.`,
    `Commands: ${content.commands.join(", ") || "none"}.`,
  ];
  if (content.mcpServers.length > 0) {
    lines.push(
      `MCP servers: ${content.mcpServers.join(", ")} (trust: ${mcpTrust?.status ?? "pending"}).`,
    );
  }
  if (content.hooks.length > 0) {
    lines.push(
      `Executable hooks: ${content.hooks.length} (trust: ${content.hookReview?.status ?? "pending"}).`,
    );
  }
  if (mcpTrust?.status === "pending" || content.hookReview?.status === "pending") {
    lines.push(
      "The plugin is installed, but pending MCP/hooks remain disabled until the user reviews and approves them in Extensions.",
    );
  }
  lines.push(
    "Skills are visible on the next message; the Desktop host is refreshing live settings.",
  );
  return lines.join("\n");
}

async function inspectMarketplacePlugin(
  args: Record<string, unknown>,
  deps: InstallCapabilityDeps,
): Promise<string> {
  const plugin = safePluginSegment(args.plugin);
  const marketplace = safePluginSegment(args.marketplace);
  if (!plugin) return "Error: kind=plugin action=inspect requires a safe `plugin` name.";
  if (!marketplace) {
    return "Error: kind=plugin action=inspect requires a safe `marketplace` name.";
  }
  const installKey = `${plugin}@${marketplace}`;
  const installed = deps.listInstalled().find((candidate) => candidate.key === installKey);
  if (installed) {
    const content = deps.describePluginContent(plugin, installed.entry.installPath, installKey);
    const trust = deps.listPluginMcpTrust().find((entry) => entry.installKey === installKey);
    return [
      `Installed plugin ${installKey} (${installed.entry.version}).`,
      `Skills: ${content.skills.map((skill) => `${plugin}:${skill.name}`).join(", ") || "none"}.`,
      `Agents: ${content.agents.join(", ") || "none"}.`,
      `Commands: ${content.commands.join(", ") || "none"}.`,
      `MCP servers: ${content.mcpServers.join(", ") || "none"}${content.mcpServers.length > 0 ? ` (trust: ${trust?.status ?? "pending"})` : ""}.`,
      `Executable hooks: ${content.hooks.length}${content.hooks.length > 0 ? ` (trust: ${content.hookReview?.status ?? "pending"})` : ""}.`,
      `Automation templates: ${content.automationTemplates.length}.`,
    ].join("\n");
  }

  const preview = await deps.previewMarketplacePlugin(plugin, marketplace);
  if ("error" in preview) return `Error: ${preview.error}`;
  return [
    ...pluginPreviewLines(plugin, marketplace, preview),
    "Not installed. If the source and components are trusted, call InstallCapability again with action='install'.",
  ].join("\n");
}

function listMarketplacePlugins(ctx: ToolContext | undefined, deps: InstallCapabilityDeps): string {
  const installed = deps.listInstalled();
  if (installed.length === 0) return "No marketplace plugins are installed.";
  const cwd = ctx?.cwd ?? process.cwd();
  const manager = deps.makeSettingsManager(cwd, ctx?.settingsScope === "full" ? "full" : "project");
  const disabled = new Set(deps.computeEffectiveDisabledLists(manager, cwd).disabledPlugins);
  return [
    `Installed plugins (${installed.length}):`,
    ...installed.map(({ key, entry }) => {
      const at = key.lastIndexOf("@");
      const name = at > 0 ? key.slice(0, at) : key;
      return `- ${key} v${entry.version} — ${disabled.has(name) ? "disabled" : "enabled"}`;
    }),
  ].join("\n");
}

async function mutateMarketplacePlugin(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  const action = actionOf(args);
  const plugin = safePluginSegment(args.plugin);
  const marketplace = safePluginSegment(args.marketplace);
  if (!plugin) return `Error: kind=plugin action=${action} requires a safe \`plugin\` name.`;
  if (!marketplace) {
    return `Error: kind=plugin action=${action} requires a safe \`marketplace\` name.`;
  }
  const installKey = `${plugin}@${marketplace}`;
  if (!deps.listInstalled().some((candidate) => candidate.key === installKey)) {
    return `Error: plugin ${installKey} is not installed.`;
  }

  if ((action === "update" || action === "uninstall") && ctx?.settingsScope !== "full") {
    return "Error: this host isolates user settings; marketplace plugins cannot be changed.";
  }

  if (action === "update") {
    const refreshed = await deps.refreshMarketplace(marketplace);
    if (!refreshed.ok) {
      return `Error: could not refresh marketplace "${marketplace}": ${refreshed.error}`;
    }
    const installed = await deps.installPlugin(plugin, marketplace);
    if (!installed.ok) return `Error: plugin update failed: ${installed.error}`;
    deps.invalidateSkillCache();
    fireCapabilityChanged();
    return `Updated plugin ${installKey} to ${installed.entry.version}. Pending changed MCP servers or hooks remain disabled until reviewed in Extensions.`;
  }

  if (action === "uninstall") {
    if (args.scope !== undefined && args.scope !== "user") {
      return "Error: marketplace plugin bundles are user-scoped; uninstall with scope='user' or omit scope.";
    }
    const removed = deps.uninstallPlugin(plugin, marketplace);
    if (!removed.ok) return `Error: plugin ${installKey} could not be uninstalled.`;
    deps.invalidateSkillCache();
    fireCapabilityChanged();
    return `Uninstalled plugin ${installKey}.`;
  }

  if (action !== "enable" && action !== "disable") {
    return `Error: unsupported plugin action "${action}".`;
  }
  const cwd = ctx?.cwd ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) {
    return "Error: plugin enable/disable requires an existing absolute workspace.";
  }
  const scope = args.scope === "project" ? "project" : "user";
  if (args.scope !== undefined && args.scope !== "project" && args.scope !== "user") {
    return "Error: plugin enable/disable scope must be `project` or `user`.";
  }
  if (scope === "user" && ctx?.settingsScope !== "full") {
    return "Error: this host isolates user settings; use project scope.";
  }
  const manager = deps.makeSettingsManager(cwd, scope === "user" ? "full" : "project");
  const enabled = action === "enable";
  if (scope === "project") {
    if (!SAFE_OVERRIDE_NAME_RE.test(plugin)) {
      return "Error: project-scoped plugin overrides do not support dots in plugin names; use user scope.";
    }
    manager.saveProjectSetting(
      `capabilityOverrides.plugins.${plugin}`,
      enabled ? "on" : "off",
      cwd,
    );
  } else {
    const current = manager.getForScope("user").disabledPlugins ?? [];
    const disabled = new Set(current);
    if (enabled) disabled.delete(plugin);
    else disabled.add(plugin);
    manager.saveUserSetting("disabledPlugins", [...disabled].sort());
  }
  fireCapabilityChanged();
  return `${enabled ? "Enabled" : "Disabled"} plugin ${installKey} at ${scope} scope.`;
}

function skillSpawnError(result: SafeSpawnResult): string | null {
  if (result.aborted) return "installation was cancelled";
  if (result.timedOut) return "installation timed out";
  if (result.spawnFailed) return result.error ?? "could not start npx";
  if (result.exitCode !== 0)
    return cleanOutput(result.stderr || result.stdout || "installer failed");
  return null;
}

async function installGithubSkills(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  if (args.scope !== undefined && args.scope !== "project") {
    return "Error: standalone conversational Skill installation currently supports project scope only.";
  }
  const cwd = ctx?.cwd ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    return "Error: Skill installation requires an existing absolute project workspace.";
  }
  const repo = normalizeGithubRepo(args.repo);
  if (!repo) {
    return "Error: kind=skill requires a trusted GitHub owner/repo or https://github.com/owner/repo URL.";
  }
  const skills = validStringArray(args.skills, SAFE_SKILL_NAME_RE, 64);
  if (!skills) return "Error: `skills` contains an invalid Skill name or too many entries.";

  const discoveredBefore = deps.scanSkills(cwd);
  const conflicts = summarizeSkillConflicts(
    skills,
    discoveredBefore.map((skill) => ({ name: skill.name, source: skill.source })),
  );
  if (conflicts.length > 0 && args.replace !== true) {
    return [
      "Error: Skill name conflict detected; nothing was installed.",
      ...conflicts.map(
        (conflict) => `- ${conflict.name} already exists from ${conflict.existingSource}`,
      ),
      "Inspect the existing Skill first, then set replace=true only if overwriting or shadowing it is intended.",
    ].join("\n");
  }

  const before = new Set(
    discoveredBefore.filter((skill) => skill.source === "project").map((skill) => skill.name),
  );
  const requirement: SkillRequirement = {
    source: "github",
    repo,
    ...(skills.length > 0 ? { skills } : {}),
    scope: "project",
    fullDepth: args.full_depth === true,
  };
  const result = await deps.safeSpawn(
    deps.resolveExecutable("npx", process.env),
    ["--yes", ...buildSkillInstallArgs(requirement)],
    {
      cwd,
      env: process.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: ctx?.signal,
      processGroup: true,
    },
  );
  const error = skillSpawnError(result);
  if (error) return `Error: Skill installation failed: ${error}`;

  deps.invalidateSkillCache();
  const after = deps
    .scanSkills(cwd)
    .filter((skill) => skill.source === "project")
    .map((skill) => skill.name);
  const missing = skills.filter((skill) => !after.includes(skill));
  if (missing.length > 0) {
    return `Error: installer exited successfully, but CodeShell could not discover: ${missing.join(", ")}.`;
  }
  fireCapabilityChanged();
  const installed = after.filter((skill) => !before.has(skill));
  const summary =
    installed.length > 0 ? installed.join(", ") : skills.join(", ") || "repository Skills";
  const log = cleanOutput(result.stdout);
  return [
    `Installed project Skill capability from ${repo}: ${summary}.`,
    "The Skills catalog and the next chat message will see the new capability.",
    ...(log ? [`Installer: ${log}`] : []),
  ].join("\n");
}

async function inspectGithubSkills(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  const cwd = ctx?.cwd ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) {
    return "Error: Skill inspection requires an existing absolute project workspace.";
  }
  const repo = normalizeGithubRepo(args.repo);
  if (!repo) {
    return "Error: kind=skill action=inspect requires a trusted GitHub owner/repo or HTTPS GitHub URL.";
  }
  const result = await deps.safeSpawn(
    deps.resolveExecutable("npx", process.env),
    [
      "--yes",
      "skills",
      "add",
      repo,
      "--list",
      ...(args.full_depth === true ? ["--full-depth"] : []),
    ],
    {
      cwd,
      env: process.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: ctx?.signal,
      processGroup: true,
    },
  );
  const error = skillSpawnError(result);
  if (error) return `Error: Skill repository inspection failed: ${error}`;
  return [
    `Available Skills from ${repo}:`,
    cleanOutput(result.stdout) || "The repository did not report any Skills.",
    "Nothing was installed. Choose exact Skill names and call InstallCapability with action='install'.",
  ].join("\n");
}

function listAvailableSkills(ctx: ToolContext | undefined, deps: InstallCapabilityDeps): string {
  const cwd = ctx?.cwd ?? process.cwd();
  const skills = deps.scanSkills(cwd);
  if (skills.length === 0) return "No Skills are installed for this workspace.";
  return [
    `Installed Skills (${skills.length}):`,
    ...skills.map(
      (skill) =>
        `- ${skill.name} [${skill.source}]${skill.description ? ` — ${skill.description}` : ""}`,
    ),
  ].join("\n");
}

async function mutateProjectSkills(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  const action = actionOf(args);
  const cwd = ctx?.cwd ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) {
    return "Error: Skill management requires an existing absolute project workspace.";
  }
  const skills = validStringArray(args.skills, SAFE_SKILL_NAME_RE, 64);
  if (!skills || skills.length === 0) {
    return `Error: kind=skill action=${action} requires one or more exact \`skills\` names.`;
  }
  const discovered = deps.scanSkills(cwd);
  const knownNames = new Set(discovered.map((skill) => skill.name));
  const missing = skills.filter((skill) => !knownNames.has(skill));
  if (missing.length > 0) {
    return `Error: these Skills are not installed in this workspace: ${missing.join(", ")}.`;
  }

  if (action === "update" || action === "uninstall") {
    if (args.scope !== undefined && args.scope !== "project") {
      return "Error: standalone Skill update/uninstall currently supports project scope only.";
    }
    const projectNames = new Set(
      discovered.filter((skill) => skill.source === "project").map((skill) => skill.name),
    );
    const notProjectSkills = skills.filter((skill) => !projectNames.has(skill));
    if (notProjectSkills.length > 0) {
      return `Error: update/uninstall only manages project Skills; not project-scoped: ${notProjectSkills.join(", ")}.`;
    }
    const argv =
      action === "update"
        ? ["--yes", "skills", "update", ...skills, "--project", "--yes"]
        : ["--yes", "skills", "remove", "--skill", skills.join(","), "--agent", "*", "--yes"];
    const result = await deps.safeSpawn(deps.resolveExecutable("npx", process.env), argv, {
      cwd,
      env: process.env,
      timeoutMs: INSTALL_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      signal: ctx?.signal,
      processGroup: true,
    });
    const error = skillSpawnError(result);
    if (error) return `Error: Skill ${action} failed: ${error}`;
    deps.invalidateSkillCache();
    if (action === "uninstall") {
      const remaining = new Set(
        deps
          .scanSkills(cwd)
          .filter((skill) => skill.source === "project")
          .map((skill) => skill.name),
      );
      const failed = skills.filter((skill) => remaining.has(skill));
      if (failed.length > 0) {
        return `Error: installer exited successfully, but these project Skills remain: ${failed.join(", ")}.`;
      }
    }
    fireCapabilityChanged();
    return `${action === "update" ? "Updated" : "Uninstalled"} project Skills: ${skills.join(", ")}.`;
  }

  if (action !== "enable" && action !== "disable") {
    return `Error: unsupported Skill action "${action}".`;
  }
  const scope = args.scope === "user" ? "user" : "project";
  if (args.scope !== undefined && args.scope !== "project" && args.scope !== "user") {
    return "Error: Skill enable/disable scope must be `project` or `user`.";
  }
  if (scope === "user" && ctx?.settingsScope !== "full") {
    return "Error: this host isolates user settings; use project scope.";
  }
  const manager = deps.makeSettingsManager(cwd, scope === "user" ? "full" : "project");
  const enabled = action === "enable";
  if (scope === "project") {
    const unsafe = skills.filter((skill) => !SAFE_OVERRIDE_NAME_RE.test(skill));
    if (unsafe.length > 0) {
      return `Error: project-scoped Skill overrides do not support dots in names: ${unsafe.join(", ")}.`;
    }
    for (const skill of skills) {
      manager.saveProjectSetting(
        `capabilityOverrides.skills.${skill}`,
        enabled ? "on" : "off",
        cwd,
      );
    }
  } else {
    const current = manager.getForScope("user").disabledSkills ?? [];
    const disabled = new Set(current);
    for (const skill of skills) {
      if (enabled) disabled.delete(skill);
      else disabled.add(skill);
    }
    manager.saveUserSetting("disabledSkills", [...disabled].sort());
  }
  fireCapabilityChanged();
  return `${enabled ? "Enabled" : "Disabled"} Skills at ${scope} scope: ${skills.join(", ")}.`;
}

function buildMcpConfig(
  args: Record<string, unknown>,
): { ok: true; name: string; config: Record<string, unknown> } | { ok: false; error: string } {
  const name = safeSegment(args.name);
  if (!name) return { ok: false, error: "kind=mcp requires a safe `name`." };

  const command = text(args.command);
  const url = text(args.url);
  const transport = text(args.transport) || (command ? "stdio" : "streamable-http");
  if (!["stdio", "sse", "streamable-http"].includes(transport)) {
    return { ok: false, error: "unsupported MCP transport." };
  }
  const argv = validArgv(args.args);
  if (!argv) return { ok: false, error: "invalid MCP `args` vector." };
  if (hasInlineCredentialArg(argv)) {
    return {
      ok: false,
      error:
        "MCP `args` appears to contain an inline credential; reference an environment-variable name instead.",
    };
  }
  const envVars = validStringArray(args.env_vars, ENV_NAME_RE);
  if (!envVars)
    return { ok: false, error: "`env_vars` must contain only environment-variable names." };
  const bearerTokenEnvVar = text(args.bearer_token_env_var);
  if (bearerTokenEnvVar && !ENV_NAME_RE.test(bearerTokenEnvVar)) {
    return { ok: false, error: "`bearer_token_env_var` must be an environment-variable name." };
  }
  const envHeaders = validEnvHeaders(args.env_headers);
  if (!envHeaders) {
    return {
      ok: false,
      error: "`env_headers` must map valid HTTP header names to environment-variable names.",
    };
  }
  const allowedTools = validStringArray(args.allowed_tools, MCP_TOOL_NAME_RE, 256);
  if (!allowedTools) {
    return { ok: false, error: "`allowed_tools` must contain exact MCP tool names." };
  }
  const disabledTools = validStringArray(args.disabled_tools, MCP_TOOL_NAME_RE, 256);
  if (!disabledTools) {
    return { ok: false, error: "`disabled_tools` must contain exact MCP tool names." };
  }
  const toolPolicy = {
    ...(args.allowed_tools !== undefined ? { allowedTools } : {}),
    ...(args.disabled_tools !== undefined ? { disabledTools } : {}),
  };

  if (transport === "stdio") {
    if (!command || command.length > 2_048 || /[\u0000\r\n]/.test(command)) {
      return { ok: false, error: "stdio MCP requires a valid executable in `command`." };
    }
    // `command` is an executable, not a command LINE — safeSpawn never shells
    // out, so an embedded flag would not run anyway, it would just be persisted
    // verbatim into settings. Without this the inline-credential guard was
    // trivially sidestepped: `args:["--token=X"]` was rejected while
    // `command:"npx --token=X"` was written straight to disk.
    if (hasInlineCredentialArg(command.split(/\s+/))) {
      return {
        ok: false,
        error:
          "MCP `command` appears to contain an inline credential; reference an " +
          "environment-variable name instead and put flags in `args`.",
      };
    }
    if (url) return { ok: false, error: "stdio MCP cannot also declare `url`." };
    if (bearerTokenEnvVar || Object.keys(envHeaders).length > 0) {
      return { ok: false, error: "HTTP authentication fields cannot be used with stdio MCP." };
    }
    return {
      ok: true,
      name,
      config: {
        command,
        ...(argv.length > 0 ? { args: argv } : {}),
        ...(envVars.length > 0 ? { envVars } : {}),
        ...toolPolicy,
        transport: "stdio",
        enabled: true,
      },
    };
  }

  if (command) return { ok: false, error: "HTTP/SSE MCP cannot also declare `command`." };
  if (argv.length > 0 || envVars.length > 0) {
    return { ok: false, error: "HTTP/SSE MCP cannot use stdio `args` or `env_vars`." };
  }
  if (!url || !isSafeRemoteUrl(url)) {
    return {
      ok: false,
      error:
        "HTTP/SSE MCP requires an HTTPS URL (plain HTTP is allowed only for localhost) without embedded credentials.",
    };
  }
  return {
    ok: true,
    name,
    config: {
      url,
      transport,
      ...(bearerTokenEnvVar ? { bearerTokenEnvVar } : {}),
      ...(Object.keys(envHeaders).length > 0 ? { envHeaders } : {}),
      ...toolPolicy,
      enabled: true,
    },
  };
}

async function installMcpServer(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  const cwd = ctx?.cwd ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) {
    return "Error: MCP installation requires an existing absolute workspace.";
  }
  const resolved = mcpScope(args);
  if (!resolved.ok) return `Error: ${resolved.error}`;
  const scope = resolved.scope;
  if (scope === "user" && ctx?.settingsScope !== "full") {
    return "Error: this host isolates user settings; install the MCP server at local or project scope.";
  }
  const built = buildMcpConfig(args);
  if (!built.ok) return `Error: ${built.error}`;

  const manager = deps.makeSettingsManager(cwd, scope === "user" ? "full" : "project");
  const current = manager.getForScope(scope, cwd) as {
    mcpServers?: Record<string, unknown>;
  };
  if (current.mcpServers?.[built.name] !== undefined && args.replace !== true) {
    return `Error: MCP server "${built.name}" already exists at ${scope} scope; set replace=true to replace it.`;
  }
  if (scope === "user") manager.saveUserSetting(`mcpServers.${built.name}`, built.config);
  else if (scope === "local") {
    manager.saveLocalSetting(`mcpServers.${built.name}`, built.config, cwd);
  } else manager.saveProjectSetting(`mcpServers.${built.name}`, built.config, cwd);
  fireCapabilityChanged();

  const target =
    scope === "user"
      ? "user settings"
      : scope === "local"
        ? "this project's private local settings"
        : "this project's shared settings";
  const auth =
    "bearerTokenEnvVar" in built.config || "envHeaders" in built.config
      ? " Authentication will be read from the referenced environment variable(s)."
      : built.config.transport === "stdio"
        ? ""
        : " If the server requires OAuth, complete sign-in from Extensions → MCP.";
  return (
    `Installed MCP server "${built.name}" for ${target} (${String(built.config.transport)}).` +
    `${auth} The Desktop host is refreshing the connection; its tools become visible on the next message.`
  );
}

function mcpScope(
  args: Record<string, unknown>,
): { ok: true; scope: "local" | "project" | "user" } | { ok: false; error: string } {
  if (args.scope === undefined || args.scope === "project") return { ok: true, scope: "project" };
  if (args.scope === "local") return { ok: true, scope: "local" };
  if (args.scope === "user") return { ok: true, scope: "user" };
  return { ok: false, error: "MCP `scope` must be `local`, `project`, or `user`." };
}

function readScopedMcpServers(
  manager: SettingsManager,
  scope: "local" | "project" | "user",
  cwd: string,
): Record<string, Record<string, unknown>> {
  const raw = manager.getForScope(scope, cwd).mcpServers ?? {};
  const servers: Record<string, Record<string, unknown>> = {};
  for (const [name, config] of Object.entries(raw)) {
    if (!config || typeof config !== "object" || Array.isArray(config)) continue;
    servers[name] = { ...config } as Record<string, unknown>;
  }
  return servers;
}

function mcpTransport(config: Record<string, unknown>): string {
  if (typeof config.transport === "string") return config.transport;
  return typeof config.url === "string" ? "streamable-http" : "stdio";
}

function safeDisplayUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "(invalid URL hidden)";
  }
}

function mcpDetailLines(
  name: string,
  scope: "local" | "project" | "user",
  config: Record<string, unknown>,
): string[] {
  const args = Array.isArray(config.args)
    ? config.args.filter((item): item is string => typeof item === "string")
    : [];
  const envVars = Array.isArray(config.envVars)
    ? config.envVars.filter((item): item is string => typeof item === "string")
    : [];
  const envNames =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? Object.keys(config.env)
      : [];
  const staticHeaderNames =
    config.headers && typeof config.headers === "object" && !Array.isArray(config.headers)
      ? Object.keys(config.headers)
      : [];
  const envHeaders =
    config.envHeaders && typeof config.envHeaders === "object" && !Array.isArray(config.envHeaders)
      ? Object.entries(config.envHeaders)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([header, env]) => `${header}<-${env}`)
      : [];
  const command =
    typeof config.command === "string"
      ? /\s|=/.test(config.command)
        ? `${config.command.split(/\s/, 1)[0] || "(configured)"} (remaining text hidden)`
        : config.command
      : null;
  return [
    `MCP server ${name} [${scope}] — ${config.enabled === false ? "disabled" : "enabled"}`,
    `Transport: ${mcpTransport(config)}`,
    ...(command ? [`Command: ${command}`] : []),
    ...(args.length > 0 ? [`Args: ${args.length} value(s) hidden to avoid exposing secrets`] : []),
    ...(safeDisplayUrl(config.url) ? [`URL: ${safeDisplayUrl(config.url)}`] : []),
    ...(envVars.length > 0 ? [`Forwarded environment names: ${envVars.join(", ")}`] : []),
    ...(envNames.length > 0
      ? [`Stored environment keys: ${envNames.join(", ")} (values hidden)`]
      : []),
    ...(typeof config.bearerTokenEnvVar === "string"
      ? [`Bearer token environment: ${config.bearerTokenEnvVar}`]
      : []),
    ...(envHeaders.length > 0 ? [`Environment headers: ${envHeaders.join(", ")}`] : []),
    ...(staticHeaderNames.length > 0
      ? [`Static header names: ${staticHeaderNames.join(", ")} (values hidden)`]
      : []),
    ...(Array.isArray(config.allowedTools)
      ? [`Allowed tools: ${config.allowedTools.join(", ") || "none"}`]
      : []),
    ...(Array.isArray(config.disabledTools) && config.disabledTools.length > 0
      ? [`Disabled tools: ${config.disabledTools.join(", ")}`]
      : []),
  ];
}

function listMcpServers(ctx: ToolContext | undefined, deps: InstallCapabilityDeps): string {
  const cwd = ctx?.cwd ?? process.cwd();
  const full = ctx?.settingsScope === "full";
  const manager = deps.makeSettingsManager(cwd, full ? "full" : "project");
  const scopes: Array<"local" | "project" | "user"> = full
    ? ["local", "project", "user"]
    : ["local", "project"];
  const lines: string[] = [];
  for (const scope of scopes) {
    for (const [name, config] of Object.entries(readScopedMcpServers(manager, scope, cwd))) {
      lines.push(
        `- ${name} [${scope}] — ${mcpTransport(config)}, ${config.enabled === false ? "disabled" : "enabled"}`,
      );
    }
  }
  return lines.length > 0
    ? [`Configured MCP servers (${lines.length}):`, ...lines].join("\n")
    : "No MCP servers are configured.";
}

function inspectMcpServer(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): string {
  const cwd = ctx?.cwd ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) {
    return "Error: MCP inspection requires an existing absolute workspace.";
  }
  const name = safeSegment(args.name);
  if (!name) return "Error: kind=mcp action=inspect requires a safe `name`.";
  const resolved = mcpScope(args);
  if (!resolved.ok) return `Error: ${resolved.error}`;
  if (resolved.scope === "user" && ctx?.settingsScope !== "full") {
    return "Error: this host isolates user settings; user MCP configuration is unavailable.";
  }
  const manager = deps.makeSettingsManager(cwd, resolved.scope === "user" ? "full" : "project");
  const config = readScopedMcpServers(manager, resolved.scope, cwd)[name];
  if (!config) return `Error: MCP server "${name}" does not exist at ${resolved.scope} scope.`;
  return mcpDetailLines(name, resolved.scope, config).join("\n");
}

async function mutateMcpServer(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  const action = actionOf(args);
  if (
    action !== "update" &&
    action !== "enable" &&
    action !== "disable" &&
    action !== "uninstall"
  ) {
    return `Error: unsupported MCP action "${action}".`;
  }
  const cwd = ctx?.cwd ?? "";
  if (!cwd || !isAbsolute(cwd) || !existsSync(cwd)) {
    return "Error: MCP management requires an existing absolute workspace.";
  }
  const name = safeSegment(args.name);
  if (!name) return `Error: kind=mcp action=${action} requires a safe \`name\`.`;
  const resolved = mcpScope(args);
  if (!resolved.ok) return `Error: ${resolved.error}`;
  if (resolved.scope === "user" && ctx?.settingsScope !== "full") {
    return "Error: this host isolates user settings; use local or project scope.";
  }
  const manager = deps.makeSettingsManager(cwd, resolved.scope === "user" ? "full" : "project");
  const servers = readScopedMcpServers(manager, resolved.scope, cwd);
  const existing = servers[name];
  if (!existing) {
    return `Error: MCP server "${name}" does not exist at ${resolved.scope} scope.`;
  }
  if (action === "update") return installMcpServer({ ...args, replace: true }, ctx, deps);
  const settingKey = `mcpServers.${name}`;
  if (action === "uninstall") {
    if (resolved.scope === "user") manager.deleteUserSetting(settingKey);
    else if (resolved.scope === "local") manager.deleteLocalSetting(settingKey, cwd);
    else manager.deleteProjectSetting(settingKey, cwd);
  } else {
    const enabledKey = `${settingKey}.enabled`;
    if (resolved.scope === "user") manager.saveUserSetting(enabledKey, action === "enable");
    else if (resolved.scope === "local") {
      manager.saveLocalSetting(enabledKey, action === "enable", cwd);
    } else manager.saveProjectSetting(enabledKey, action === "enable", cwd);
  }
  fireCapabilityChanged();
  if (action === "uninstall") {
    return `Uninstalled MCP server "${name}" from ${resolved.scope} scope.`;
  }
  return `${action === "enable" ? "Enabled" : "Disabled"} MCP server "${name}" at ${resolved.scope} scope.`;
}

export async function installCapabilityTool(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  return installCapabilityWithDeps(args, ctx, defaultDeps);
}

/** Test seam: production always calls {@link installCapabilityTool}. */
export async function installCapabilityWithDeps(
  args: Record<string, unknown>,
  ctx: ToolContext | undefined,
  deps: InstallCapabilityDeps,
): Promise<string> {
  const action = actionOf(args);
  if (
    !["list", "inspect", "install", "update", "enable", "disable", "uninstall"].includes(action)
  ) {
    return "Error: unsupported capability lifecycle action.";
  }
  if (args.kind !== "plugin" && args.kind !== "skill" && args.kind !== "mcp") {
    return "Error: `kind` must be `plugin`, `skill`, or `mcp`.";
  }

  if (action === "list") {
    if (args.kind === "plugin") return listMarketplacePlugins(ctx, deps);
    if (args.kind === "skill") return listAvailableSkills(ctx, deps);
    return listMcpServers(ctx, deps);
  }
  if (action === "inspect") {
    if (args.kind === "plugin") return inspectMarketplacePlugin(args, deps);
    if (args.kind === "skill") return inspectGithubSkills(args, ctx, deps);
    return inspectMcpServer(args, ctx, deps);
  }
  if (action === "install") {
    if (args.kind === "plugin") return installMarketplacePlugin(args, ctx, deps);
    if (args.kind === "skill") return installGithubSkills(args, ctx, deps);
    return installMcpServer(args, ctx, deps);
  }
  if (args.kind === "plugin") return mutateMarketplacePlugin(args, ctx, deps);
  if (args.kind === "skill") return mutateProjectSkills(args, ctx, deps);
  return mutateMcpServer(args, ctx, deps);
}
