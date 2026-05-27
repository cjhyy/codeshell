import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseAgentDefinition, type AgentDefinition } from "./agent-definition.js";

/**
 * Loads reusable sub-agent role definitions from a directory of `*.md` files.
 * Non-recursive. Malformed files are skipped with a warning rather than
 * failing the whole load — one bad role file must not break the agent system.
 */
export class AgentDefinitionRegistry {
  private defs = new Map<string, AgentDefinition>();
  readonly warnings: string[] = [];

  static loadFromDir(dir: string): AgentDefinitionRegistry {
    const reg = new AgentDefinitionRegistry();
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return reg;

    for (const entry of readdirSync(dir).sort()) {
      if (!entry.endsWith(".md")) continue;
      const full = join(dir, entry);
      try {
        if (!statSync(full).isFile()) continue;
        const def = parseAgentDefinition(readFileSync(full, "utf8"), entry);
        if (reg.defs.has(def.name)) {
          reg.warnings.push(`${entry}: duplicate agent name '${def.name}' ignored (first definition wins)`);
          continue;
        }
        reg.defs.set(def.name, def);
      } catch (err) {
        reg.warnings.push(`${entry}: ${(err as Error).message}`);
      }
    }
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
