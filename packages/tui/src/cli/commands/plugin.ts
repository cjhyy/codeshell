import { Command } from "commander";
import { PluginInstallError } from "@cjhyy/code-shell-core";
import {
  installPluginFromPath,
  installPluginFromNpm,
  installPluginFromSource,
  parseSource,
  uninstallPluginByName,
  listInstalledPlugins,
  updatePluginByName,
} from "@cjhyy/code-shell-core/internal";

export function createPluginCommand(): Command {
  const plugin = new Command("plugin").description("Manage plugins (CC + Codex formats)");

  plugin
    .command("install")
    .description(
      "Install from a local directory, git source, or public npm source (npm:package@version-or-tag)",
    )
    .argument("<source>", "Local path, git source, or public npm: source")
    .option("--name <name>", "Override the installed plugin name")
    .option(
      "--allow-unsafe-transport",
      "Allow http://, git://, or file:// plugin source transports",
    )
    .action(async (source: string, opts: { name?: string; allowUnsafeTransport?: boolean }) => {
      await runGuarded(`plugin install`, async () => {
        const parsed = parseSource(source, {
          allowUnsafeTransport: Boolean(opts.allowUnsafeTransport),
        });
        const name =
          opts.name ?? (parsed.kind === "local" ? basenameOf(parsed.path) : parsed.inferredName);
        const ts = new Date().toISOString();
        if (parsed.kind === "npm") {
          const result = await installPluginFromNpm(parsed, name, ts);
          console.log(
            `Installed '${result.name}' v${result.resolution.resolvedVersion} from public npm → ${result.dir}`,
          );
          return;
        }
        const dir =
          parsed.kind === "local"
            ? installPluginFromPath(parsed.path, name, ts)
            : await installPluginFromSource(parsed, name, ts);
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
    .action(async (name: string, opts: { force?: boolean }) => {
      await runGuarded(`update`, async () => {
        const r = await updatePluginByName(name, new Date().toISOString(), Boolean(opts.force));
        console.log(r.updated ? `Updated '${name}'` : `'${name}': ${r.reason}`);
      });
    });

  plugin
    .command("uninstall")
    .description("Remove an installed plugin")
    .argument("<name>", "Installed plugin name")
    .action(async (name: string) => {
      await runGuarded(`uninstall`, () => {
        uninstallPluginByName(name);
        console.log(`Uninstalled '${name}'`);
      });
    });

  return plugin;
}

/** Run an installer action, turning PluginInstallError into a clean exit. */
async function runGuarded(label: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
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
