import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import {
  CANONICAL_PLUGIN_MANIFEST_FILE,
  CanonicalPluginManifest,
  CodexPluginManifest,
  PluginPanelsManifest,
  type CanonicalPluginManifest as CanonicalPluginManifestData,
  type PluginPanelManifestEntry,
} from "./types.js";

export interface NormalizePluginManifestOptions {
  name: string;
  version?: string;
  format: "cc" | "codex";
  destinationRoot: string;
  /** Codex conversion does not copy the source tree wholesale. */
  copyPanelAssets?: boolean;
}

function manifestPath(sourceRoot: string, format: "cc" | "codex"): string {
  return join(sourceRoot, format === "codex" ? ".codex-plugin" : ".claude-plugin", "plugin.json");
}

function isContained(root: string, candidate: string): boolean {
  const withSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(withSep);
}

async function validatePanelEntry(
  sourceRoot: string,
  entry: PluginPanelManifestEntry,
): Promise<void> {
  const root = await realpath(sourceRoot);
  const candidate = resolve(sourceRoot, ...entry.entry.split("/"));
  let target: string;
  try {
    target = await realpath(candidate);
  } catch {
    throw new Error(`panel '${entry.id}' entry does not exist: ${entry.entry}`);
  }
  if (!isContained(root, target)) {
    throw new Error(`panel '${entry.id}' entry escapes the plugin root: ${entry.entry}`);
  }
  if (!(await stat(target)).isFile()) {
    throw new Error(`panel '${entry.id}' entry is not a file: ${entry.entry}`);
  }
}

async function copyPanelTree(
  sourceRoot: string,
  destinationRoot: string,
  entry: PluginPanelManifestEntry,
): Promise<void> {
  // Copy the entry's containing tree one file at a time. Following a source
  // symlink here would make the installed tree contain files from outside the
  // plugin, so every walked path is realpath-contained before it is copied.
  const sourceDir = resolve(sourceRoot, ...dirname(entry.entry).split("/"));
  const sourceRootReal = await realpath(sourceRoot);
  const sourceDirReal = await realpath(sourceDir);
  if (sourceDirReal !== sourceRootReal && !isContained(sourceRootReal, sourceDirReal)) {
    throw new Error(`panel '${entry.id}' asset directory escapes the plugin root`);
  }

  const { cp } = await import("node:fs/promises");
  const destinationDir = resolve(destinationRoot, ...dirname(entry.entry).split("/"));
  await mkdir(dirname(destinationDir), { recursive: true });
  await cp(sourceDir, destinationDir, {
    recursive: true,
    dereference: false,
    filter: async (source) => {
      const sourceReal = await realpath(source);
      return sourceReal === sourceRootReal || isContained(sourceRootReal, sourceReal);
    },
  });
}

/**
 * Normalize either author manifest into the only runtime manifest Desktop may
 * consume. Invalid declared panels fail installation; plugins without panels
 * remain backward-compatible and still receive a canonical identity record.
 */
export async function normalizePluginManifest(
  sourceRoot: string,
  options: NormalizePluginManifestOptions,
): Promise<CanonicalPluginManifestData> {
  const authorPath = manifestPath(sourceRoot, options.format);
  let raw: Record<string, unknown> = {};
  if (existsSync(authorPath)) {
    raw = JSON.parse(await readFile(authorPath, "utf-8")) as Record<string, unknown>;
  }

  const parsed =
    options.format === "codex"
      ? CodexPluginManifest.parse(raw)
      : {
          description: typeof raw.description === "string" ? raw.description : undefined,
          panels: raw.panels === undefined ? undefined : PluginPanelsManifest.parse(raw.panels),
        };

  const panels = parsed.panels;
  for (const entry of panels?.entries ?? []) {
    await validatePanelEntry(sourceRoot, entry);
    if (options.copyPanelAssets) {
      await copyPanelTree(sourceRoot, options.destinationRoot, entry);
    }
  }

  const canonical = CanonicalPluginManifest.parse({
    schemaVersion: 1,
    name: options.name,
    version: options.version ?? (typeof raw.version === "string" ? raw.version : undefined),
    description: parsed.description,
    panels,
  });
  await mkdir(options.destinationRoot, { recursive: true });
  await writeFile(
    join(options.destinationRoot, CANONICAL_PLUGIN_MANIFEST_FILE),
    `${JSON.stringify(canonical, null, 2)}\n`,
    "utf-8",
  );
  return canonical;
}

export async function readCanonicalPluginManifest(
  installRoot: string,
): Promise<CanonicalPluginManifestData | null> {
  const file = join(installRoot, CANONICAL_PLUGIN_MANIFEST_FILE);
  if (!existsSync(file)) return null;
  try {
    return CanonicalPluginManifest.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch {
    return null;
  }
}
