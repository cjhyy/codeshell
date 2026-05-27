import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDefinition, type AgentDefinition } from "./agent-definition.js";

export interface AgentSourceDir {
  dir: string;
  source: "project" | "user";
}

/**
 * Loads reusable sub-agent role definitions from one or more directories
 * of `*.md` files. Non-recursive. Malformed files are skipped with a
 * warning rather than failing the whole load — one bad role file must
 * not break the agent system.
 *
 * When multiple dirs define the same role name, the LAST dir wins
 * (callers pass [project, user] so user-level overrides project-level).
 * The shadowing def is marked `override: true`. Names in `disabled` are
 * filtered out entirely after the merge, so the LLM never sees them.
 */
export class AgentDefinitionRegistry {
  private defs = new Map<string, AgentDefinition>();
  readonly warnings: string[] = [];

  /** Back-compat single-dir loader (project source, no disabled filter). */
  static loadFromDir(dir: string): AgentDefinitionRegistry {
    return AgentDefinitionRegistry.loadFromDirs([{ dir, source: "project" }], []);
  }

  static loadFromDirs(
    dirs: AgentSourceDir[],
    disabled: string[],
  ): AgentDefinitionRegistry {
    const reg = new AgentDefinitionRegistry();

    for (const { dir, source } of dirs) {
      if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir).sort()) {
        if (!entry.endsWith(".md")) continue;
        const full = join(dir, entry);
        try {
          if (!statSync(full).isFile()) continue;
          const def = parseAgentDefinition(readFileSync(full, "utf8"), entry);
          def.source = source;
          def.filePath = full;
          // A later dir overriding an earlier one (user over project).
          if (reg.defs.has(def.name)) def.override = true;
          reg.defs.set(def.name, def);
        } catch (err) {
          reg.warnings.push(`${entry}: ${(err as Error).message}`);
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
