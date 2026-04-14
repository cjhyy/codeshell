/**
 * Plugin system — discover, load, and manage plugins.
 *
 * Plugin directories:
 *   ~/.code-shell/plugins/
 *   .code-shell/plugins/ (project-level)
 *
 * Each plugin is a directory with a manifest.json:
 *   {
 *     "name": "my-plugin",
 *     "version": "1.0.0",
 *     "description": "...",
 *     "main": "index.js",
 *     "skills": [...],
 *     "hooks": {...},
 *     "mcpServers": {...},
 *     "tools": [...]
 *   }
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  main?: string;
  enabled?: boolean;
  skills?: Array<{
    name: string;
    description: string;
    triggers?: { keywords?: string[]; tools?: string[]; intents?: string[] };
  }>;
  hooks?: Record<string, string>;
  mcpServers?: Record<string, { command: string; args?: string[] }>;
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    handler: string;
  }>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  enabled: boolean;
  error?: string;
}

export class PluginLoader {
  private plugins = new Map<string, LoadedPlugin>();

  /**
   * Scan plugin directories and load manifests.
   */
  scan(cwd: string): LoadedPlugin[] {
    const dirs = [
      join(homedir(), ".code-shell", "plugins"),
      join(cwd, ".code-shell", "plugins"),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const pluginDir = join(dir, entry.name);
          this.loadPlugin(pluginDir);
        }
      } catch {
        // Directory not readable
      }
    }

    return this.list();
  }

  /**
   * Load a single plugin from a directory.
   */
  private loadPlugin(pluginDir: string): void {
    const manifestPath = join(pluginDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      // Try package.json as fallback
      const pkgPath = join(pluginDir, "package.json");
      if (!existsSync(pkgPath)) return;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        if (!pkg.codeShellPlugin) return;
        this.registerPlugin(pluginDir, pkg.codeShellPlugin);
      } catch {
        // Skip
      }
      return;
    }

    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PluginManifest;
      this.registerPlugin(pluginDir, manifest);
    } catch (err) {
      this.plugins.set(pluginDir, {
        manifest: { name: pluginDir, version: "?", description: "Failed to load" },
        path: pluginDir,
        enabled: false,
        error: (err as Error).message,
      });
    }
  }

  private registerPlugin(path: string, manifest: PluginManifest): void {
    this.plugins.set(manifest.name, {
      manifest,
      path,
      enabled: manifest.enabled !== false,
    });
  }

  /** Get a plugin by name. */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /** List all discovered plugins. */
  list(): LoadedPlugin[] {
    return [...this.plugins.values()];
  }

  /** Enable/disable a plugin. */
  setEnabled(name: string, enabled: boolean): boolean {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    plugin.enabled = enabled;
    return true;
  }

  /** Get all enabled plugins. */
  getEnabled(): LoadedPlugin[] {
    return [...this.plugins.values()].filter((p) => p.enabled);
  }
}
