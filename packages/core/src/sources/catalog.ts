/** 全局数据源目录：codeShellHome()/sources.json。损坏条目隔离，原子写。 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../logging/logger.js";
import { codeShellHome } from "../session/session-manager.js";
import { mutateJsonFile } from "../utils/file-mutex.js";
import { SourceDefinitionSchema, type SourceDefinition } from "./types.js";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const MAX_CATALOG_SOURCES = 1_000;
const MAX_SOURCE_DEFINITION_BYTES = 1024 * 1024;

export function sourceCatalogPath(): string {
  return join(codeShellHome(), "sources.json");
}

function parseCatalog(rawText: string | undefined): SourceDefinition[] {
  if (rawText === undefined) return [];
  if (Buffer.byteLength(rawText, "utf8") > MAX_CATALOG_BYTES) return [];
  try {
    const raw = JSON.parse(rawText) as {
      version?: number;
      sources?: unknown[];
    };
    if (raw.version !== 1 || !Array.isArray(raw.sources)) return [];

    const sources = new Map<string, SourceDefinition>();
    for (const entry of raw.sources.slice(0, MAX_CATALOG_SOURCES)) {
      const parsed = SourceDefinitionSchema.safeParse(entry);
      if (parsed.success) {
        let encoded: string;
        try {
          encoded = JSON.stringify(parsed.data);
        } catch {
          continue;
        }
        if (Buffer.byteLength(encoded, "utf8") <= MAX_SOURCE_DEFINITION_BYTES) {
          sources.set(parsed.data.id, parsed.data);
        }
      } else {
        logger.warn("sources.catalog_entry_invalid", {
          cat: "sources",
          entry: JSON.stringify(entry).slice(0, 200),
        });
      }
    }
    return [...sources.values()];
  } catch (error) {
    logger.warn("sources.catalog_unreadable", {
      cat: "sources",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function load(): SourceDefinition[] {
  const path = sourceCatalogPath();
  if (!existsSync(path)) return [];
  try {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CATALOG_BYTES) return [];
    return parseCatalog(readFileSync(path, "utf-8"));
  } catch {
    return [];
  }
}

function mutateCatalog(mutation: (current: SourceDefinition[]) => SourceDefinition[]): void {
  const path = sourceCatalogPath();
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") chmodSync(directory, 0o700);
  mutateJsonFile<SourceDefinition[]>(path, {
    parse: parseCatalog,
    serialize: (sources) => `${JSON.stringify({ version: 1, sources }, null, 2)}\n`,
    mutation: (current) => ({ value: mutation(current) }),
    mode: 0o600,
  });
}

export function listSourceDefinitions(): SourceDefinition[] {
  return load().sort((a, b) => a.id.localeCompare(b.id));
}

export function readSourceDefinition(id: string): SourceDefinition | undefined {
  return load().find((source) => source.id === id);
}

export function saveSourceDefinition(definition: SourceDefinition): void {
  const parsed = SourceDefinitionSchema.parse(definition);
  let encoded: string;
  try {
    encoded = JSON.stringify(parsed);
  } catch {
    throw new Error("source definition must be JSON-serializable");
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_SOURCE_DEFINITION_BYTES) {
    throw new Error("source definition exceeds the size limit");
  }
  mutateCatalog((current) => {
    const rest = current.filter((source) => source.id !== parsed.id);
    if (rest.length >= MAX_CATALOG_SOURCES) throw new Error("source catalog is full");
    return [...rest, parsed];
  });
}

export function deleteSourceDefinition(id: string): void {
  SourceDefinitionSchema.shape.id.parse(id);
  mutateCatalog((current) => current.filter((source) => source.id !== id));
}
