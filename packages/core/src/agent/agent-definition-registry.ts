import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { parseAgentDefinition, type AgentDefinition } from "./agent-definition.js";

export interface AgentSourceDir {
  dir: string;
  source: "project" | "user" | "plugin";
  /** For source === "plugin": the owning plugin name, carried onto each def
   *  so the spawn layer can namespace bare skill allowlists. */
  pluginName?: string;
}

/**
 * Loads reusable sub-agent role definitions recursively from one or more
 * directories. Malformed `.md` files are skipped with a
 * warning rather than failing the whole load — one bad role file must
 * not break the agent system.
 *
 * When multiple dirs define the same role name, the LAST dir wins. This is
 * pure mechanism — the project>user POLICY lives in the caller's dir ORDER
 * (loadAgentDefinitionsForCwd passes [user, ...plugins, project] so a repo's
 * in-tree agent wins; see spec §7.2). The shadowing def is marked
 * `override: true` and records the sources it shadowed in `shadowedSources`.
 * Names in `disabled` are filtered out entirely after the merge, so the LLM
 * never sees them.
 */
export class AgentDefinitionRegistry {
  private defs = new Map<string, AgentDefinition>();
  readonly warnings: string[] = [];

  /** Back-compat single-dir loader (project source, no disabled filter). */
  static loadFromDir(dir: string): AgentDefinitionRegistry {
    return AgentDefinitionRegistry.loadFromDirs([{ dir, source: "project" }], []);
  }

  static loadFromDirs(dirs: AgentSourceDir[], disabled: string[]): AgentDefinitionRegistry {
    const reg = new AgentDefinitionRegistry();

    for (const { dir, source, pluginName } of dirs) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      const pluginRoot = source === "plugin" ? safeRealpath(dir) : null;
      if (source === "plugin" && !pluginRoot) continue;
      for (const { full, sourceName } of collectAgentMarkdownFiles(dir, pluginRoot)) {
        try {
          if (!statSync(full).isFile()) continue;
          const def = parseAgentDefinition(readFileSync(full, "utf8"), sourceName);
          def.source = source;
          if (pluginName) def.pluginName = pluginName;
          def.filePath = full;
          // A later dir overriding an earlier one. Carry forward the shadowed
          // sources (the prev def's own source + anything it already shadowed)
          // so a project def that shadows a plugin def that shadowed a user
          // def reports both.
          const prev = reg.defs.get(def.name);
          if (prev) {
            def.override = true;
            const shadowed = new Set<"project" | "user" | "plugin">(prev.shadowedSources ?? []);
            if (prev.source) shadowed.add(prev.source);
            def.shadowedSources = [...shadowed];
          }
          reg.defs.set(def.name, def);
        } catch (err) {
          reg.warnings.push(`${sourceName}: ${(err as Error).message}`);
        }
      }
    }

    // Filter disabled roles after the merge so a user override of a
    // disabled name is still removed.
    for (const name of new Set(disabled)) reg.defs.delete(name);
    return reg;
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }
  get(name: string): AgentDefinition | undefined {
    return this.defs.get(name);
  }
  list(): AgentDefinition[] {
    return [...this.defs.values()];
  }
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function resolveContainedPluginAgent(root: string, candidate: string): string | null {
  const target = safeRealpath(candidate);
  if (!target) return null;
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return target;
}

function collectAgentMarkdownFiles(
  root: string,
  pluginRoot: string | null,
): Array<{ full: string; sourceName: string }> {
  const files: Array<{ full: string; sourceName: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const candidate = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(candidate);
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const full =
        pluginRoot === null ? candidate : resolveContainedPluginAgent(pluginRoot, candidate);
      if (!full) continue;
      files.push({ full, sourceName: relative(root, candidate) });
    }
  };
  walk(root);
  return files;
}
