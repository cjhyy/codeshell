import { Command } from "commander";
import { resolve } from "node:path";
import { installPluginFromPath, PluginInstallError } from "@cjhyy/code-shell-core";

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
      try {
        const dir = installPluginFromPath(sourceDir, name, new Date().toISOString());
        console.log(`Installed '${name}' → ${dir}`);
      } catch (err) {
        if (err instanceof PluginInstallError) {
          console.error(`plugin install failed: ${err.message}`);
          process.exitCode = 1;
          return;
        }
        throw err;
      }
    });

  return plugin;
}

function basenameOf(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}
