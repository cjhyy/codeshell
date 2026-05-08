/**
 * Memory system — persistent cross-session memory.
 *
 * Stores structured memory entries as individual markdown files under a base
 * directory. Resolution order for the base directory:
 *   1. explicit `baseDir` constructor arg
 *   2. CODE_SHELL_HOME env var
 *   3. ~/.code-shell
 *
 * MEMORY.md is the index file.
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  fileName: string;
}

export interface MemoryManagerOptions {
  /** Project root path; when set, memories are scoped under projects/<hash>/memory. */
  projectDir?: string;
  /** Override the base directory (~/.code-shell by default). Takes precedence over env. */
  baseDir?: string;
}

export function resolveMemoryBaseDir(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.CODE_SHELL_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".code-shell");
}

export class MemoryManager {
  private readonly baseDir: string;
  private readonly memoryDir: string;
  private readonly indexPath: string;
  // Per-instance cache of {fileName -> {name, description}} so the
  // index can be rewritten without re-reading every memory file
  // every time a single entry is saved/deleted (the previous code
  // path called loadAll() on every save, giving O(N²) total I/O).
  // null = "not initialized yet, fall back to disk on next access."
  private indexCache: Map<string, { name: string; description: string }> | null = null;

  constructor(options?: MemoryManagerOptions | string) {
    // Back-compat: old signature was `new MemoryManager(projectDir?: string)`.
    const opts: MemoryManagerOptions =
      typeof options === "string" ? { projectDir: options } : (options ?? {});

    this.baseDir = resolveMemoryBaseDir(opts.baseDir);
    if (opts.projectDir) {
      const projectHash = opts.projectDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
      this.memoryDir = join(this.baseDir, "projects", projectHash, "memory");
    } else {
      this.memoryDir = join(this.baseDir, "memory");
    }
    this.indexPath = join(this.memoryDir, "MEMORY.md");
    mkdirSync(this.memoryDir, { recursive: true });
  }

  getMemoryDir(): string { return this.memoryDir; }

  /**
   * Save a memory entry. Creates the file and updates the index.
   */
  save(entry: Omit<MemoryEntry, "fileName">): string {
    const fileName = this.slugify(entry.name) + ".md";
    const filePath = join(this.memoryDir, fileName);

    const content =
      `---\n` +
      `name: ${entry.name}\n` +
      `description: ${entry.description}\n` +
      `type: ${entry.type}\n` +
      `---\n\n` +
      `${entry.content}\n`;

    writeFileSync(filePath, content, "utf-8");

    // Incremental index update. Initialize the cache on first
    // save by paying one loadAll() — every save after that just
    // mutates the cache and rewrites MEMORY.md.
    const cache = this.ensureIndexCache();
    cache.set(fileName, { name: entry.name, description: entry.description });
    this.writeIndex(cache);
    return fileName;
  }

  /**
   * Load all memory entries.
   */
  loadAll(): MemoryEntry[] {
    if (!existsSync(this.memoryDir)) return [];

    const files = readdirSync(this.memoryDir).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const entry = this.loadFile(file);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * Load a single memory file.
   */
  private loadFile(fileName: string): MemoryEntry | null {
    const filePath = join(this.memoryDir, fileName);
    if (!existsSync(filePath)) return null;

    try {
      const raw = readFileSync(filePath, "utf-8");
      const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
      if (!frontmatterMatch) return null;

      const frontmatter = frontmatterMatch[1];
      const content = frontmatterMatch[2].trim();

      const name = frontmatter.match(/name:\s*(.+)/)?.[1]?.trim() ?? fileName;
      const description = frontmatter.match(/description:\s*(.+)/)?.[1]?.trim() ?? "";
      const type = (frontmatter.match(/type:\s*(.+)/)?.[1]?.trim() ?? "project") as MemoryEntry["type"];

      return { name, description, type, content, fileName };
    } catch {
      return null;
    }
  }

  /**
   * Delete a memory by name or filename.
   */
  delete(nameOrFile: string): boolean {
    const entries = this.loadAll();
    const entry = entries.find(
      (e) => e.name === nameOrFile || e.fileName === nameOrFile,
    );
    if (!entry) return false;

    try {
      unlinkSync(join(this.memoryDir, entry.fileName));
      const cache = this.ensureIndexCache();
      cache.delete(entry.fileName);
      this.writeIndex(cache);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the MEMORY.md index content for injection into prompts.
   */
  getIndex(): string {
    if (!existsSync(this.indexPath)) return "";
    return readFileSync(this.indexPath, "utf-8");
  }

  /**
   * Build a prompt-friendly summary of all memories.
   */
  buildMemoryContext(): string {
    const entries = this.loadAll();
    if (entries.length === 0) return "";

    const lines = entries.map(
      (e) => `- [${e.type}] ${e.name}: ${e.description}`,
    );

    return (
      `# Persistent Memory\n\n` +
      `The following memories from previous sessions may be relevant:\n\n` +
      lines.join("\n") +
      `\n\nTo read a specific memory, check ${this.memoryDir}/`
    );
  }

  /**
   * Lazy-build the in-memory index from disk on first use, then
   * keep it in sync incrementally via save/delete. Avoids the
   * O(N²) re-read of every memory file on every save.
   */
  private ensureIndexCache(): Map<string, { name: string; description: string }> {
    if (this.indexCache !== null) return this.indexCache;
    const cache = new Map<string, { name: string; description: string }>();
    for (const entry of this.loadAll()) {
      cache.set(entry.fileName, { name: entry.name, description: entry.description });
    }
    this.indexCache = cache;
    return cache;
  }

  private writeIndex(cache: Map<string, { name: string; description: string }>): void {
    const lines: string[] = [];
    for (const [fileName, meta] of cache) {
      lines.push(`- [${meta.name}](${fileName}) — ${meta.description}`);
    }
    const content = lines.length > 0
      ? lines.join("\n") + "\n"
      : "(no memories stored)\n";
    writeFileSync(this.indexPath, content, "utf-8");
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
  }
}
