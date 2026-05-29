import {
  existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
  cpSync, rmSync, renameSync, statSync,
} from "node:fs";
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
export function installPluginFromPath(
  sourceDir: string,
  name: string,
  installedAt: string,
): string {
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
  mkdirSync(pluginsRoot(), { recursive: true });
  const tmpDir = join(pluginsRoot(), `.tmp-${name}-${process.pid}`);
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    const format = detectPluginFormat(sourceDir);
    let meta: CSMeta;

    if (format === "cc") {
      cpSync(sourceDir, tmpDir, { recursive: true });
      meta = { name, format: "cc", source: sourceDir, installedAt };
    } else {
      const manifest = CodexPluginManifest.parse(
        JSON.parse(readFileSync(join(sourceDir, ".codex-plugin", "plugin.json"), "utf-8")),
      );
      // skills (verbatim copy)
      copyCodexSkills(sourceDir, tmpDir);
      // agents (TOML → MD)
      convertAgentsInto(sourceDir, tmpDir, name);
      // mcp → mcp-servers.json keyed <plugin>:<server>
      const servers = resolveCodexMcpServers(sourceDir, manifest.mcpServers);
      const keyed: Record<string, unknown> = {};
      for (const [serverName, cfg] of Object.entries(servers)) {
        const key = `${name}:${serverName}`;
        keyed[key] = { ...(cfg as object), name: key };
      }
      if (Object.keys(keyed).length > 0) {
        writeFileSync(join(tmpDir, "mcp-servers.json"), JSON.stringify(keyed, null, 2));
      }
      meta = { name, format: "codex", version: manifest.version, source: sourceDir, installedAt };
    }

    writeFileSync(join(tmpDir, ".cs-meta.json"), JSON.stringify(meta, null, 2));
    renameSync(tmpDir, finalDir);
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
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

/** Walk <sourceDir>/agents/**.toml → <destDir>/agents/**.md (structure preserved). */
function convertAgentsInto(sourceDir: string, destDir: string, pluginName: string): void {
  const agentsSrc = join(sourceDir, "agents");
  if (!existsSync(agentsSrc)) return;

  const walk = (dir: string): void => {
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, dirent.name);
      if (dirent.isDirectory()) { walk(abs); continue; }
      if (!dirent.name.endsWith(".toml")) continue;
      const rel = relative(agentsSrc, abs).replace(/\.toml$/, ".md");
      const outPath = join(destDir, "agents", rel);
      mkdirSync(join(outPath, ".."), { recursive: true });
      const md = convertCodexAgentToml(readFileSync(abs, "utf-8"), rel, pluginName);
      writeFileSync(outPath, md);
    }
  };
  walk(agentsSrc);
}
