import { existsSync } from "node:fs";
import { cp, lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { rewritePluginVars } from "../varRewrite.js";
import { convertCodexAgentsDirectory } from "./codex/convertAgents.js";
import { copyCodexCommands } from "./codex/convertCommands.js";
import { copyCodexHooks } from "./codex/convertHooks.js";
import { resolveCodexMcpServers } from "./codex/convertMcp.js";
import { copyCodexSkills } from "./codex/convertSkills.js";
import { detectPluginFormat } from "./detectFormat.js";
import { normalizePluginMcpMap } from "./loadPluginMcp.js";
import { normalizePluginManifest } from "./normalizeManifest.js";
import {
  CodexPluginManifest,
  type CanonicalPluginManifest as CanonicalPluginManifestData,
  PluginInstallError,
} from "./types.js";

const MAX_PLUGIN_SOURCE_ENTRIES = 10_000;
const MAX_PLUGIN_SOURCE_BYTES = 256 * 1024 * 1024;
const MAX_PLUGIN_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PLUGIN_SOURCE_DEPTH = 32;
const MAX_PLUGIN_SOURCE_RELATIVE_PATH = 1_024;
const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;

export interface ProjectedPluginSource {
  canonicalManifest: CanonicalPluginManifestData;
  format: "cc" | "codex";
  version?: string;
}

interface TreeBudget {
  bytes: number;
  entries: number;
}

async function assertBoundedTreeEntry(
  root: string,
  directory: string,
  depth: number,
  budget: TreeBudget,
): Promise<void> {
  if (depth > MAX_PLUGIN_SOURCE_DEPTH) {
    throw new PluginInstallError(
      `plugin source exceeds the maximum directory depth ${MAX_PLUGIN_SOURCE_DEPTH}`,
    );
  }
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_PLUGIN_SOURCE_ENTRIES) {
      throw new PluginInstallError(
        `plugin source contains more than ${MAX_PLUGIN_SOURCE_ENTRIES} entries`,
      );
    }
    const path = join(directory, entry.name);
    const rel = relative(root, path);
    if (rel.length > MAX_PLUGIN_SOURCE_RELATIVE_PATH) {
      throw new PluginInstallError(
        `plugin source path exceeds ${MAX_PLUGIN_SOURCE_RELATIVE_PATH} characters`,
      );
    }
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new PluginInstallError(
        `plugin source must not contain symbolic links; link escapes the stable review boundary: ${rel}`,
      );
    }
    if (info.isDirectory()) {
      await assertBoundedTreeEntry(root, path, depth + 1, budget);
      continue;
    }
    if (!info.isFile()) {
      throw new PluginInstallError(`plugin source contains an unsupported file type: ${rel}`);
    }
    if (info.size > MAX_PLUGIN_SOURCE_FILE_BYTES) {
      throw new PluginInstallError(
        `plugin source file exceeds ${MAX_PLUGIN_SOURCE_FILE_BYTES} bytes: ${rel}`,
      );
    }
    budget.bytes += info.size;
    if (budget.bytes > MAX_PLUGIN_SOURCE_BYTES) {
      throw new PluginInstallError(
        `plugin source exceeds the ${MAX_PLUGIN_SOURCE_BYTES} byte size limit`,
      );
    }
  }
}

/** Bound local directory input before copying or parsing author-controlled files. */
export async function assertBoundedPluginSource(sourceDir: string): Promise<void> {
  let root: string;
  try {
    root = await realpath(sourceDir);
  } catch {
    throw new PluginInstallError(`source is not a readable directory: ${sourceDir}`);
  }
  if (!(await stat(root)).isDirectory()) {
    throw new PluginInstallError(`source is not a directory: ${sourceDir}`);
  }
  await assertBoundedTreeEntry(root, root, 0, { bytes: 0, entries: 0 });
}

async function readBoundedJson(path: string): Promise<Record<string, unknown>> {
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new PluginInstallError(
      `plugin manifest must be a regular file no larger than ${MAX_PLUGIN_MANIFEST_BYTES} bytes`,
    );
  }
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("manifest root must be an object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PluginInstallError) throw error;
    throw new PluginInstallError(
      `invalid plugin manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Build the same CodeShell-native projection used by installation, without
 * touching the plugin root or installed registry. The destination must be a
 * private temporary/staging directory owned by the caller.
 */
export async function projectPluginSource(
  sourceDir: string,
  destinationRoot: string,
  name: string,
): Promise<ProjectedPluginSource> {
  await assertBoundedPluginSource(sourceDir);
  const format = detectPluginFormat(sourceDir);
  let version: string | undefined;

  await cp(sourceDir, destinationRoot, { recursive: true });

  if (format === "codex") {
    const manifest = CodexPluginManifest.parse(
      await readBoundedJson(join(sourceDir, ".codex-plugin", "plugin.json")),
    );
    version = manifest.version;
    await copyCodexSkills(sourceDir, destinationRoot);
    await convertCodexAgentsDirectory(sourceDir, destinationRoot, name);
    await copyCodexCommands(sourceDir, destinationRoot);
    await copyCodexHooks(sourceDir, destinationRoot, manifest.hooks);

    const servers = resolveCodexMcpServers(sourceDir, manifest.mcpServers);
    const keyed: Record<string, unknown> = {};
    for (const [serverName, config] of Object.entries(servers)) {
      const key = `${name}:${serverName}`;
      keyed[key] = { ...(config as object), name: key };
    }
    if (Object.keys(keyed).length > 0) {
      const normalized = normalizePluginMcpMap(keyed, name, true);
      if (Object.keys(normalized).length !== Object.keys(keyed).length) {
        throw new PluginInstallError("invalid plugin MCP server declaration");
      }
      await writeFile(
        join(destinationRoot, "mcp-servers.json"),
        JSON.stringify(normalized, null, 2),
      );
    }
  } else {
    const manifestPath = join(sourceDir, ".claude-plugin", "plugin.json");
    if (existsSync(manifestPath)) {
      const manifest = await readBoundedJson(manifestPath);
      version =
        typeof manifest.version === "string" && manifest.version.length > 0
          ? manifest.version
          : undefined;
    }
  }

  const canonicalManifest = await normalizePluginManifest(sourceDir, {
    name,
    version,
    format,
    destinationRoot,
  });
  rewritePluginVars(destinationRoot);
  return { canonicalManifest, format, version };
}
