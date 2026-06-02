import { existsSync, statSync } from "node:fs";
import {
  mkdir, writeFile, readFile, readdir, cp, rm, rename,
} from "node:fs/promises";
import { join, relative } from "node:path";
import { detectPluginFormat } from "./detectFormat.js";
import { pluginInstallDir, pluginsRoot, assertSafePluginName } from "./paths.js";
import { CodexPluginManifest, type CSMeta, PluginInstallError } from "./types.js";
import { convertCodexAgentToml } from "./codex/convertAgents.js";
import { resolveCodexMcpServers } from "./codex/convertMcp.js";
import { copyCodexSkills } from "./codex/convertSkills.js";
import { appendInstallEntry, pluginInstallKey } from "../installedPlugins.js";

/**
 * Install a local plugin directory into ~/.code-shell/plugins/<name>/.
 * Builds into a temp sibling dir, then renames into place — a conversion
 * failure leaves nothing behind. `installedAt` is passed in (caller stamps the
 * timestamp) to keep this function pure of the unavailable Date.now().
 */
export async function installPluginFromPath(
  sourceDir: string,
  name: string,
  installedAt: string,
): Promise<string> {
  assertSafePluginName(name);
  if (!existsSync(sourceDir) || !statSync(sourceDir).isDirectory()) {
    throw new PluginInstallError(`source is not a directory: ${sourceDir}`);
  }
  const finalDir = pluginInstallDir(name);
  if (existsSync(finalDir)) {
    throw new PluginInstallError(
      `plugin '${name}' already installed; uninstall first or rename the source`,
    );
  }
  await mkdir(pluginsRoot(), { recursive: true });
  const tmpDir = join(pluginsRoot(), `.tmp-${name}-${process.pid}`);
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  try {
    const format = detectPluginFormat(sourceDir);
    let meta: CSMeta;

    if (format === "cc") {
      // Async cp: a recursive copy of a whole plugin dir is the dominant cost
      // here; awaiting it yields the event loop so the Electron main process
      // keeps answering IPC (no UI freeze during install).
      await cp(sourceDir, tmpDir, { recursive: true });
      meta = { name, format: "cc", source: sourceDir, installedAt };
    } else {
      const manifest = CodexPluginManifest.parse(
        JSON.parse(await readFile(join(sourceDir, ".codex-plugin", "plugin.json"), "utf-8")),
      );
      // skills (verbatim copy)
      copyCodexSkills(sourceDir, tmpDir);
      // agents (TOML → MD)
      await convertAgentsInto(sourceDir, tmpDir, name);
      // mcp → mcp-servers.json keyed <plugin>:<server>
      const servers = resolveCodexMcpServers(sourceDir, manifest.mcpServers);
      const keyed: Record<string, unknown> = {};
      for (const [serverName, cfg] of Object.entries(servers)) {
        const key = `${name}:${serverName}`;
        keyed[key] = { ...(cfg as object), name: key };
      }
      if (Object.keys(keyed).length > 0) {
        await writeFile(join(tmpDir, "mcp-servers.json"), JSON.stringify(keyed, null, 2));
      }
      meta = { name, format: "codex", version: manifest.version, source: sourceDir, installedAt };
    }

    await writeFile(join(tmpDir, ".cs-meta.json"), JSON.stringify(meta, null, 2));
    await rename(tmpDir, finalDir);
    // Register so existing loaders (scanInstalledPlugins / loadPluginHooks)
    // discover this local install. Marketplace tag "local" distinguishes it
    // from cache/marketplace installs.
    appendInstallEntry(pluginInstallKey(name, "local"), {
      scope: "user",
      installPath: finalDir,
      version: meta.version ?? "local",
      installedAt,
      lastUpdated: installedAt,
    });
    return finalDir;
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Walk <sourceDir>/agents/**.toml → <destDir>/agents/**.md (structure preserved). */
async function convertAgentsInto(sourceDir: string, destDir: string, pluginName: string): Promise<void> {
  const agentsSrc = join(sourceDir, "agents");
  if (!existsSync(agentsSrc)) return;

  const walk = async (dir: string): Promise<void> => {
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) { await walk(abs); continue; }
      if (!dirent.name.endsWith(".toml")) continue;
      const rel = relative(agentsSrc, abs).replace(/\.toml$/, ".md");
      const outPath = join(destDir, "agents", rel);
      await mkdir(join(outPath, ".."), { recursive: true });
      const md = convertCodexAgentToml(await readFile(abs, "utf-8"), rel, pluginName);
      await writeFile(outPath, md);
    }
  };
  await walk(agentsSrc);
}
