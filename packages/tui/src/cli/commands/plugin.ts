import { Command } from "commander";
import { resolve } from "node:path";
import {
  installPluginFromPath,
  uninstallPluginByName,
  listInstalledPlugins,
  updatePluginByName,
  PluginInstallError,
} from "@cjhyy/code-shell-core";

export function createPluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage plugins (CC + Codex formats)");

  plugin
    .command("install")
    .description("Install a local CC or Codex plugin directory")
    .argument("<source>", "Path to the plugin source directory")
    .option("--name <name>", "Override the installed plugin name")
    .action(async (source: string, opts: { name?: string }) => {
      const sourceDir = resolve(source);
      const name = opts.name ?? basenameOf(sourceDir);
      runGuarded(`plugin install`, () => {
        const dir = installPluginFromPath(sourceDir, name, new Date().toISOString());
        console.log(`Installed '${name}' → ${dir}`);
      });
    });

  plugin
    .command("list")
    .description("List installed plugins")
    .action(() => {
      const rows = listInstalledPlugins();
      if (rows.length === 0) {
        console.log("No plugins installed.");
        return;
      }
      for (const r of rows) {
        console.log(`${r.name}  [${r.format}]  v${r.version ?? "?"}  ${r.source}`);
      }
    });

  plugin
    .command("update")
    .description("Re-install a plugin from its source if changed")
    .argument("<name>", "Installed plugin name")
    .option("--force", "Reinstall even if unchanged")
    .action((name: string, opts: { force?: boolean }) => {
      runGuarded(`update`, () => {
        const r = updatePluginByName(name, new Date().toISOString(), Boolean(opts.force));
        console.log(r.updated ? `Updated '${name}'` : `'${name}': ${r.reason}`);
      });
    });

  plugin
    .command("uninstall")
    .description("Remove an installed plugin")
    .argument("<name>", "Installed plugin name")
    .action((name: string) => {
      runGuarded(`uninstall`, () => {
        uninstallPluginByName(name);
        console.log(`Uninstalled '${name}'`);
      });
    });

  return plugin;
}

/** Run an installer action, turning PluginInstallError into a clean exit. */
function runGuarded(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof PluginInstallError) {
      console.error(`${label} failed: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

function basenameOf(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
