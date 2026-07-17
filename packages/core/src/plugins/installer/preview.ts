import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

import { parseFrontmatter } from "../../skills/frontmatter.js";
import { readInstalledPlugins } from "../installedPlugins.js";
import { inspectPluginHooks } from "../pluginHookIntegrity.js";
import {
  deriveName,
  installLocalPlugin,
  normalizePluginName,
  type InstallLocalOptions,
  type LocalPluginSourceInput,
  withLocalPluginSourceRoot,
} from "./installFromArchive.js";
import { readPluginMcp } from "./loadPluginMcp.js";
import { pluginInstallDir } from "./paths.js";
import { assertBoundedPluginSource, projectPluginSource } from "./projectPluginSource.js";
import { PluginInstallError, type PluginPanelManifestEntry } from "./types.js";

const MAX_PREVIEW_ITEMS = 256;
const MAX_PREVIEW_SKILL_BYTES = 512 * 1024;
const MAX_PREVIEW_TEXT = 240;
const MAX_PREVIEW_DESCRIPTION = 300;
const MAX_PREVIEW_MCP_BYTES = 1024 * 1024;

export type LocalPluginPreviewWarningKind =
  | "executable-hooks"
  | "stdio-mcp"
  | "network-mcp"
  | "panel-permissions"
  | "automation-templates"
  | "external-links"
  | "media";

export interface LocalPluginPreviewWarning {
  count: number;
  kind: LocalPluginPreviewWarningKind;
  severity: "warning" | "info";
}

export interface LocalPluginHookPreview {
  command: string;
  commandTruncated: boolean;
  event: string;
  matcher?: string;
  matcherTruncated?: boolean;
}

export interface LocalPluginMcpPreview {
  command?: string;
  commandTruncated?: boolean;
  name: string;
  transport: "stdio" | "sse" | "streamable-http";
  url?: string;
  urlTruncated?: boolean;
}

export interface LocalPluginAutomationTemplatePreview {
  description?: string;
  id: string;
  permissionLevel: "read-only" | "workspace-write" | "full";
  prompt: string;
  promptTruncated: boolean;
  schedule: string;
  timezone?: string;
  title: { default: string; en?: string; "zh-CN"?: string };
  workspace: "current" | "none";
}

export interface LocalPluginMediaPreview {
  composerIcon?: string;
  logo?: string;
  logoDark?: string;
  screenshots: string[];
}

export interface LocalPluginInterfacePreview {
  brandColor?: string;
  capabilities: string[];
  category?: string;
  defaultPrompt: string[];
  developerName?: string;
  displayName?: string;
  externalLinks: Array<{
    kind: "website" | "privacy" | "terms";
    url: string;
  }>;
  longDescription?: string;
  media: LocalPluginMediaPreview;
  shortDescription?: string;
}

export interface LocalPluginPreview {
  agents: string[];
  alreadyInstalled: boolean;
  commands: string[];
  format: "cc" | "codex";
  hooks: LocalPluginHookPreview[];
  installedVersion?: string;
  interface: LocalPluginInterfacePreview;
  mcpServers: LocalPluginMcpPreview[];
  name: string;
  panels: PluginPanelManifestEntry[];
  automationTemplates: LocalPluginAutomationTemplatePreview[];
  reviewToken: string;
  skills: Array<{ description?: string; name: string }>;
  source: {
    kind: "dir" | "zip";
    label: string;
  };
  version?: string;
  warnings: LocalPluginPreviewWarning[];
}

export class LocalPluginReviewChangedError extends PluginInstallError {
  constructor() {
    super("Plugin source changed after review. Review it again before installing.");
    this.name = "LocalPluginReviewChangedError";
  }
}

function truncated(
  value: string,
  max = MAX_PREVIEW_TEXT,
): {
  text: string;
  truncated: boolean;
} {
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true };
}

function ensureItemBound(kind: string, count: number): void {
  if (count > MAX_PREVIEW_ITEMS) {
    throw new PluginInstallError(
      `plugin declares more than ${MAX_PREVIEW_ITEMS} ${kind}; preview refused`,
    );
  }
}

async function listMarkdownNames(root: string, recursive: boolean): Promise<string[]> {
  if (!existsSync(root)) return [];
  const names: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && recursive) {
        await walk(path);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      names.push(relative(root, path).replaceAll(sep, "/").replace(/\.md$/, ""));
      ensureItemBound("entries", names.length);
    }
  };
  await walk(root);
  return names.sort();
}

async function listSkills(root: string): Promise<Array<{ description?: string; name: string }>> {
  if (!existsSync(root)) return [];
  const output: Array<{ description?: string; name: string }> = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(root, entry.name, "SKILL.md");
    if (!existsSync(skillFile) || !(await stat(skillFile)).isFile()) continue;
    const info = await stat(skillFile);
    if (info.size > MAX_PREVIEW_SKILL_BYTES) {
      throw new PluginInstallError(
        `skills/${entry.name}/SKILL.md exceeds ${MAX_PREVIEW_SKILL_BYTES} bytes`,
      );
    }
    const { frontmatter } = parseFrontmatter(await readFile(skillFile, "utf-8"));
    const description =
      typeof frontmatter.description === "string"
        ? truncated(frontmatter.description, MAX_PREVIEW_DESCRIPTION).text
        : undefined;
    output.push({ name: entry.name, ...(description ? { description } : {}) });
    ensureItemBound("skills", output.length);
  }
  return output;
}

function listHooks(projectionRoot: string): LocalPluginHookPreview[] {
  const snapshot = inspectPluginHooks(projectionRoot);
  if (snapshot.state === "invalid") {
    throw new PluginInstallError(`invalid plugin hooks: ${snapshot.error ?? "unknown error"}`);
  }
  const hooks: LocalPluginHookPreview[] = [];
  for (const [event, groups] of Object.entries(snapshot.definition?.hooks ?? {})) {
    for (const group of groups ?? []) {
      const matcher = group.matcher ? truncated(group.matcher) : null;
      for (const hook of group.hooks) {
        const command = truncated(hook.command);
        hooks.push({
          event,
          command: command.text,
          commandTruncated: command.truncated,
          ...(matcher
            ? {
                matcher: matcher.text,
                matcherTruncated: matcher.truncated,
              }
            : {}),
        });
        ensureItemBound("hooks", hooks.length);
      }
    }
  }
  return hooks;
}

async function assertCcMcpPreviewComplete(
  projectionRoot: string,
  normalizedCount: number,
): Promise<void> {
  const path = join(projectionRoot, ".mcp.json");
  if (!existsSync(path)) return;
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_PREVIEW_MCP_BYTES) {
    throw new PluginInstallError("plugin .mcp.json is not a bounded regular file");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf-8"));
  } catch (error) {
    throw new PluginInstallError(
      `invalid plugin .mcp.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PluginInstallError("plugin .mcp.json root must be an object");
  }
  const raw = "mcpServers" in parsed ? (parsed as { mcpServers?: unknown }).mcpServers : parsed;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PluginInstallError("plugin .mcp.json mcpServers must be an object");
  }
  if (Object.keys(raw).length !== normalizedCount) {
    throw new PluginInstallError("plugin .mcp.json contains invalid MCP server declarations");
  }
}

async function listMcp(
  projectionRoot: string,
  pluginName: string,
  format: "cc" | "codex",
): Promise<LocalPluginMcpPreview[]> {
  const configs = readPluginMcp(projectionRoot, pluginName);
  if (format === "cc") {
    await assertCcMcpPreviewComplete(projectionRoot, Object.keys(configs).length);
  }
  const output = Object.entries(configs)
    .map(([key, config]) => {
      const transport =
        config.transport ??
        (config.url && !config.command ? ("streamable-http" as const) : ("stdio" as const));
      const command = config.command ? truncated(config.command) : null;
      const url = config.url ? truncated(config.url) : null;
      return {
        name: key.startsWith(`${pluginName}:`) ? key.slice(pluginName.length + 1) : key,
        transport:
          transport === "sse" || transport === "streamable-http" ? transport : ("stdio" as const),
        ...(command ? { command: command.text, commandTruncated: command.truncated } : {}),
        ...(url ? { url: url.text, urlTruncated: url.truncated } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  ensureItemBound("MCP servers", output.length);
  return output;
}

function interfacePreview(
  value: Awaited<ReturnType<typeof projectPluginSource>>["canonicalManifest"]["interface"],
): LocalPluginInterfacePreview {
  const externalLinks: LocalPluginInterfacePreview["externalLinks"] = [];
  if (value?.websiteURL) externalLinks.push({ kind: "website", url: value.websiteURL });
  if (value?.privacyPolicyURL) {
    externalLinks.push({ kind: "privacy", url: value.privacyPolicyURL });
  }
  if (value?.termsOfServiceURL) {
    externalLinks.push({ kind: "terms", url: value.termsOfServiceURL });
  }
  return {
    capabilities: [...(value?.capabilities ?? [])],
    defaultPrompt: [...(value?.defaultPrompt ?? [])],
    externalLinks,
    media: {
      ...(value?.composerIcon ? { composerIcon: value.composerIcon } : {}),
      ...(value?.logo ? { logo: value.logo } : {}),
      ...(value?.logoDark ? { logoDark: value.logoDark } : {}),
      screenshots: [...(value?.screenshots ?? [])],
    },
    ...(value?.displayName ? { displayName: value.displayName } : {}),
    ...(value?.shortDescription ? { shortDescription: value.shortDescription } : {}),
    ...(value?.longDescription ? { longDescription: value.longDescription } : {}),
    ...(value?.developerName ? { developerName: value.developerName } : {}),
    ...(value?.category ? { category: value.category } : {}),
    ...(value?.brandColor ? { brandColor: value.brandColor } : {}),
  };
}

function warningsFor(
  hooks: readonly LocalPluginHookPreview[],
  mcpServers: readonly LocalPluginMcpPreview[],
  panels: readonly PluginPanelManifestEntry[],
  automationTemplates: readonly LocalPluginAutomationTemplatePreview[],
  metadata: LocalPluginInterfacePreview,
): LocalPluginPreviewWarning[] {
  const warnings: LocalPluginPreviewWarning[] = [];
  if (hooks.length > 0) {
    warnings.push({ kind: "executable-hooks", severity: "warning", count: hooks.length });
  }
  const stdio = mcpServers.filter((server) => server.transport === "stdio").length;
  const network = mcpServers.length - stdio;
  if (stdio > 0) warnings.push({ kind: "stdio-mcp", severity: "warning", count: stdio });
  if (network > 0) warnings.push({ kind: "network-mcp", severity: "warning", count: network });
  const privilegedPanels = panels.filter((panel) => panel.permissions.length > 0).length;
  if (privilegedPanels > 0) {
    warnings.push({
      kind: "panel-permissions",
      severity: "warning",
      count: privilegedPanels,
    });
  }
  if (automationTemplates.length > 0) {
    warnings.push({
      kind: "automation-templates",
      severity: "warning",
      count: automationTemplates.length,
    });
  }
  if (metadata.externalLinks.length > 0) {
    warnings.push({
      kind: "external-links",
      severity: "info",
      count: metadata.externalLinks.length,
    });
  }
  const mediaCount =
    Number(Boolean(metadata.media.composerIcon)) +
    Number(Boolean(metadata.media.logo)) +
    Number(Boolean(metadata.media.logoDark)) +
    metadata.media.screenshots.length;
  if (mediaCount > 0) {
    warnings.push({ kind: "media", severity: "info", count: mediaCount });
  }
  return warnings;
}

async function digestProjection(root: string): Promise<string> {
  const hash = createHash("sha256").update("codeshell-local-plugin-review-v1").update("\0");
  const canonicalRoot = await realpath(root);
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(directory, entry.name);
      const rel = relative(canonicalRoot, path).replaceAll(sep, "/");
      // rewritePluginVars intentionally stamps this explanatory breadcrumb
      // with the current time. It does not affect runtime capabilities and
      // must not make two reviews of unchanged source produce different tokens.
      if (rel === ".code-shell-installed.json") continue;
      hash.update(rel).update("\0");
      const info = await lstat(path);
      if (info.isDirectory()) {
        hash.update("dir\0");
        await walk(path);
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path);
        hash.update("link\0").update(target).update("\0");
      } else if (info.isFile()) {
        hash
          .update("file\0")
          .update(await readFile(path))
          .update("\0");
      }
    }
  };
  await walk(canonicalRoot);
  return hash.digest("hex");
}

function installedVersion(name: string): string | undefined {
  const entries = readInstalledPlugins().plugins[`${name}@local`] ?? [];
  return entries.at(-1)?.version;
}

/**
 * Inspect a local directory/zip through the exact runtime projection used by
 * install. No plugin root or installed registry is mutated.
 */
export async function previewLocalPlugin(
  input: LocalPluginSourceInput,
): Promise<LocalPluginPreview> {
  return withLocalPluginSourceRoot(input, async (sourceRoot) => {
    const name = normalizePluginName(await deriveName(sourceRoot));
    const projectionRoot = await mkdtemp(join(tmpdir(), "cs-plugin-preview-"));
    try {
      const projected = await projectPluginSource(sourceRoot, projectionRoot, name);
      const skills = await listSkills(join(projectionRoot, "skills"));
      const commands = await listMarkdownNames(join(projectionRoot, "commands"), false);
      const agents = await listMarkdownNames(join(projectionRoot, "agents"), true);
      const hooks = listHooks(projectionRoot);
      const mcpServers = await listMcp(projectionRoot, name, projected.format);
      const panels = [...(projected.canonicalManifest.panels?.entries ?? [])];
      const automationTemplates = (projected.canonicalManifest.automations?.templates ?? []).map(
        (template) => {
          const prompt = truncated(template.prompt, 500);
          return {
            id: template.id,
            title: template.title,
            ...(template.description ? { description: template.description } : {}),
            schedule: template.schedule,
            prompt: prompt.text,
            promptTruncated: prompt.truncated,
            ...(template.timezone ? { timezone: template.timezone } : {}),
            permissionLevel: template.permissionLevel,
            workspace: template.workspace,
          };
        },
      );
      const metadata = interfacePreview(projected.canonicalManifest.interface);
      const reviewToken = await digestProjection(projectionRoot);
      const exists = existsSync(pluginInstallDir(name));
      const currentInstalledVersion = exists ? installedVersion(name) : undefined;
      return {
        name,
        format: projected.format,
        ...(projected.version ? { version: projected.version } : {}),
        source: { kind: input.kind, label: basename(input.path) },
        alreadyInstalled: exists,
        ...(currentInstalledVersion ? { installedVersion: currentInstalledVersion } : {}),
        reviewToken,
        skills,
        commands,
        agents,
        hooks,
        mcpServers,
        panels,
        automationTemplates,
        interface: metadata,
        warnings: warningsFor(hooks, mcpServers, panels, automationTemplates, metadata),
      };
    } finally {
      await rm(projectionRoot, { recursive: true, force: true });
    }
  });
}

/**
 * Install exactly the source tree represented by a review token.
 *
 * A private, symlink-free snapshot closes the gap between re-review and
 * installation: after its projection matches the token, the installer reads
 * only that snapshot, never the caller-owned directory or archive again.
 */
export async function installReviewedLocalPlugin(
  input: LocalPluginSourceInput,
  expectedReviewToken: string,
  installedAt: string,
  options?: InstallLocalOptions,
): Promise<{ dir: string; name: string }> {
  if (!/^[a-f0-9]{64}$/.test(expectedReviewToken)) {
    throw new PluginInstallError("local plugin review token is invalid");
  }
  return withLocalPluginSourceRoot(input, async (sourceRoot) => {
    const snapshotContainer = await mkdtemp(join(tmpdir(), "cs-plugin-reviewed-"));
    const snapshotRoot = join(snapshotContainer, "source");
    try {
      await assertBoundedPluginSource(sourceRoot);
      await cp(sourceRoot, snapshotRoot, { recursive: true, errorOnExist: true });
      const snapshotPreview = await previewLocalPlugin({ kind: "dir", path: snapshotRoot });
      if (snapshotPreview.reviewToken !== expectedReviewToken) {
        throw new LocalPluginReviewChangedError();
      }
      return await installLocalPlugin(
        { kind: "dir", path: snapshotRoot },
        installedAt,
        snapshotPreview.name,
        options,
      );
    } finally {
      await rm(snapshotContainer, { recursive: true, force: true });
    }
  });
}
