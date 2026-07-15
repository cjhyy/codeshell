/** 全局数据源目录：codeShellHome()/sources.json。损坏条目隔离，原子写。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logging/logger.js";
import { codeShellHome } from "../session/session-manager.js";
import { SourceDefinitionSchema, type SourceDefinition } from "./types.js";

export function sourceCatalogPath(): string {
  return join(codeShellHome(), "sources.json");
}

function load(): SourceDefinition[] {
  const path = sourceCatalogPath();
  if (!existsSync(path)) return [];

  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as {
      version?: number;
      sources?: unknown[];
    };
    if (raw.version !== 1 || !Array.isArray(raw.sources)) return [];

    const sources: SourceDefinition[] = [];
    for (const entry of raw.sources) {
      const parsed = SourceDefinitionSchema.safeParse(entry);
      if (parsed.success) {
        sources.push(parsed.data);
      } else {
        logger.warn("sources.catalog_entry_invalid", {
          cat: "sources",
          entry: JSON.stringify(entry).slice(0, 200),
        });
      }
    }
    return sources;
  } catch (error) {
    logger.warn("sources.catalog_unreadable", {
      cat: "sources",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function persist(sources: SourceDefinition[]): void {
  const path = sourceCatalogPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, sources }, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmp, path);
}

export function listSourceDefinitions(): SourceDefinition[] {
  return load().sort((a, b) => a.id.localeCompare(b.id));
}

export function readSourceDefinition(id: string): SourceDefinition | undefined {
  return load().find((source) => source.id === id);
}

export function saveSourceDefinition(definition: SourceDefinition): void {
  const parsed = SourceDefinitionSchema.parse(definition);
  const rest = load().filter((source) => source.id !== parsed.id);
  persist([...rest, parsed]);
}

export function deleteSourceDefinition(id: string): void {
  persist(load().filter((source) => source.id !== id));
}
