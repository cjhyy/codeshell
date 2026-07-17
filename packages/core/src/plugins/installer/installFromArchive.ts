import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractZip } from "./unzip.js";
import { installPluginFromPath } from "./install.js";
import { reinstallAtomic } from "./update.js";
import { pluginInstallDir } from "./paths.js";
import { PluginInstallError } from "./types.js";

/** Options for the unified local-install entry. */
export interface InstallLocalOptions {
  /**
   * When the target name is already installed, replace it instead of throwing
   * "already installed". The replace is atomic (rename-backup + rollback via
   * {@link reinstallAtomic}), so a failed overwrite keeps the old version and
   * its registration intact. Unlike a manual uninstall+install, this preserves
   * the user's disable flags in settings (an upgrade is not a removal).
   */
  overwrite?: boolean;
}

export interface LocalPluginSourceInput {
  kind: "dir" | "zip";
  path: string;
}

const MAX_LOCAL_PLUGIN_SOURCE_PATH = 4096;

/**
 * Resolve a directory/zip input to its actual plugin root. Zip extraction is
 * private and always cleaned after the callback settles.
 */
export async function withLocalPluginSourceRoot<T>(
  input: LocalPluginSourceInput,
  operation: (root: string) => Promise<T>,
): Promise<T> {
  if (
    !input ||
    (input.kind !== "dir" && input.kind !== "zip") ||
    typeof input.path !== "string" ||
    input.path.length === 0 ||
    input.path.length > MAX_LOCAL_PLUGIN_SOURCE_PATH ||
    input.path.includes("\0")
  ) {
    throw new PluginInstallError("local plugin source is invalid");
  }
  if (input.kind === "dir") {
    if (!existsSync(input.path) || !statSync(input.path).isDirectory()) {
      throw new PluginInstallError(`source is not a directory: ${input.path}`);
    }
    return operation(await findPluginRoot(input.path));
  }
  if (!existsSync(input.path) || !statSync(input.path).isFile()) {
    throw new PluginInstallError(`archive is not a file: ${input.path}`);
  }
  const tmp = await mkdtemp(join(tmpdir(), "cs-tmp-zip-"));
  try {
    await extractZip(input.path, tmp);
    return await operation(await findPluginRoot(tmp));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Install `root` as plugin `name`, atomically replacing an already-installed
 * plugin of the same name when `overwrite` is set. When no same-name plugin
 * exists this is a plain install (overwrite is a no-op). `root` must stay valid
 * for the duration of the call (zip callers keep their extracted temp dir alive
 * until this resolves).
 */
async function installRootMaybeOverwrite(
  root: string,
  resolvedName: string,
  installedAt: string,
  overwrite: boolean,
): Promise<string> {
  const finalDir = pluginInstallDir(resolvedName);
  if (overwrite && existsSync(finalDir)) {
    await reinstallAtomic(resolvedName, root, () =>
      installPluginFromPath(root, resolvedName, installedAt),
    );
    return finalDir;
  }
  return installPluginFromPath(root, resolvedName, installedAt);
}

/**
 * Install a local plugin from a .zip archive.
 *
 * Mirrors installFromSource (the git path): extract to a private temp dir,
 * locate the plugin root inside it, hand off to the local installer (which
 * does CC/Codex detect + convert + register), then always clean up the temp
 * dir. On any failure nothing is left behind.
 *
 * `name` is optional — when omitted it is derived from the plugin manifest
 * (`name` field) or, failing that, the archive's top-level directory. The
 * caller stamps `installedAt` to keep this pure of the unavailable Date.now().
 */
export async function installPluginFromArchive(
  zipPath: string,
  installedAt: string,
  name?: string,
  options?: InstallLocalOptions,
): Promise<{ dir: string; name: string }> {
  return withLocalPluginSourceRoot({ kind: "zip", path: zipPath }, async (root) => {
    const resolvedName = normalizePluginName(name ?? (await deriveName(root)));
    const dir = await installRootMaybeOverwrite(
      root,
      resolvedName,
      installedAt,
      options?.overwrite ?? false,
    );
    return { dir, name: resolvedName };
  });
}

/**
 * Unified local-install entry for the desktop/UI: takes either a directory or
 * a .zip and installs it as a global plugin, deriving the name when not given.
 * The host (which has Date.now) stamps `installedAt`.
 *
 * For a directory we still run findPluginRoot/deriveName so a user can point at
 * a repo checkout whose plugin sits one level down, and so the name comes from
 * the manifest rather than forcing the caller to guess it.
 */
export async function installLocalPlugin(
  input: LocalPluginSourceInput,
  installedAt: string,
  name?: string,
  options?: InstallLocalOptions,
): Promise<{ dir: string; name: string }> {
  return withLocalPluginSourceRoot(input, async (root) => {
    const resolvedName = normalizePluginName(name ?? (await deriveName(root)));
    const dir = await installRootMaybeOverwrite(
      root,
      resolvedName,
      installedAt,
      options?.overwrite ?? false,
    );
    return { dir, name: resolvedName };
  });
}

/**
 * A plugin root is a dir that holds a recognizable manifest or component dir.
 * Zip archives commonly wrap everything in a single top-level folder, so if
 * `dir` itself isn't a plugin root but contains exactly one subdirectory, dive
 * one level. Only one level — deeper nesting is treated as malformed.
 */
export async function findPluginRoot(dir: string): Promise<string> {
  if (looksLikePluginRoot(dir)) return dir;
  const entries = await readdir(dir, { withFileTypes: true });
  const subDirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith("."));
  if (subDirs.length === 1) {
    const nested = join(dir, subDirs[0].name);
    if (looksLikePluginRoot(nested)) return nested;
  }
  throw new PluginInstallError(
    "no plugin found in archive (expected .claude-plugin/plugin.json, .codex-plugin/plugin.json, or a skills/commands/agents/hooks directory)",
  );
}

function looksLikePluginRoot(dir: string): boolean {
  return (
    existsSync(join(dir, ".claude-plugin", "plugin.json")) ||
    existsSync(join(dir, ".codex-plugin", "plugin.json")) ||
    ["skills", "commands", "agents", "hooks"].some((d) => existsSync(join(dir, d)))
  );
}

/** Read the `name` field from a CC or Codex manifest; fall back to the dir name. */
export async function deriveName(root: string): Promise<string> {
  for (const rel of [
    [".claude-plugin", "plugin.json"],
    [".codex-plugin", "plugin.json"],
  ]) {
    const manifestPath = join(root, ...rel);
    if (!existsSync(manifestPath)) continue;
    try {
      const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as { name?: unknown };
      if (typeof parsed.name === "string" && parsed.name.trim()) return parsed.name.trim();
    } catch {
      // Malformed manifest → fall through to dir-name derivation.
    }
  }
  return root.split(/[\\/]/).filter(Boolean).pop() ?? "plugin";
}

/**
 * Coerce an arbitrary derived name into a safe single path segment:
 * lowercase, only [a-z0-9._-], collapse the rest to '-'. assertSafePluginName
 * (called by installPluginFromPath) rejects separators outright; this makes a
 * manifest name like "My Plugin" usable instead of erroring.
 */
export function normalizePluginName(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!cleaned) {
    throw new PluginInstallError(`cannot derive a valid plugin name from: ${JSON.stringify(raw)}`);
  }
  return cleaned;
}
