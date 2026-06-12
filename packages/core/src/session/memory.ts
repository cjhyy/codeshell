/**
 * Memory system — persistent cross-session memory.
 *
 * Stores structured memory entries as individual markdown files under a base
 * directory. Resolution order for the base directory:
 *   1. explicit `baseDir` constructor arg
 *   2. CODE_SHELL_HOME env var
 *   3. ~/.code-shell
 *
 * Two scopes are isolated on disk:
 *   - user/    Things the user explicitly asked to remember, plus the legacy
 *              auto-extracted entries (extract-memories output). LLM may
 *              only modify these through permission-gated tool calls.
 *   - dream/   The dream pipeline's workspace. The LLM is free to add /
 *              merge / delete entries here; user/ is read-only to dream.
 *
 * MEMORY.md is the index file (one per scope).
 *
 * Deletes are SOFT — files are moved to <baseDir>/memory-trash/<ISO>/<scope>/
 * rather than removed, so accidental deletions are recoverable.
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type MemoryScope = "user" | "dream";

export interface MemoryEntry {
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  fileName: string;
  scope: MemoryScope;
  /** File mtime in epoch ms — drives maxAge filtering (TODO 8.1). 0 if unknown. */
  updatedAt?: number;
  /**
   * 固定/置顶 (feedback#18 方案 A): a pinned memory is exempt from maxAge
   * injection filtering and sorts first in the injected context. UI surfaces
   * pin/unpin; auto flows never set it.
   */
  pinned?: boolean;
  /**
   * Provenance (方案 C): "auto" = written by the end-of-session extractor,
   * "manual" (or absent — legacy files) = written by the user/UI. Lets the
   * UI distinguish curated memories from extractor noise.
   */
  origin?: "auto" | "manual";
}

/**
 * Drop memories older than `maxAgeDays` (by file mtime) for context injection
 * (TODO 8.1). A non-positive/undefined maxAge means no filtering. Entries with
 * an unknown mtime (updatedAt 0/undefined) are KEPT — we never hide a memory
 * just because we couldn't read its timestamp. Pure + testable.
 */
export function filterByAge(
  entries: MemoryEntry[],
  maxAgeDays?: number,
  now: number = Date.now(),
): MemoryEntry[] {
  if (!maxAgeDays || maxAgeDays <= 0) return entries;
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
  // Pinned memories never age out of injection — that's the point of the pin.
  return entries.filter((e) => e.pinned || !e.updatedAt || e.updatedAt >= cutoff);
}

export interface MemoryManagerOptions {
  /** Project root path; when set, memories are scoped under projects/<hash>/memory. */
  projectDir?: string;
  /** Override the base directory (~/.code-shell by default). Takes precedence over env. */
  baseDir?: string;
  /** Which scope this manager operates on. Defaults to "user". */
  scope?: MemoryScope;
}

export function resolveMemoryBaseDir(override?: string): string {
  if (override) return override;
  const fromEnv = process.env.CODE_SHELL_HOME;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return join(homedir(), ".code-shell");
}

export class MemoryManager {
  private readonly baseDir: string;
  /** Root containing both scope subdirs (the "memory" dir per project/global). */
  private readonly memoryRoot: string;
  private readonly scope: MemoryScope;
  /** Scope-specific directory: <memoryRoot>/<scope>. */
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
    this.scope = opts.scope ?? "user";

    if (opts.projectDir) {
      const projectHash = opts.projectDir.replace(/[/\\:]/g, "-").replace(/^-/, "");
      this.memoryRoot = join(this.baseDir, "projects", projectHash, "memory");
    } else {
      this.memoryRoot = join(this.baseDir, "memory");
    }

    this.memoryDir = join(this.memoryRoot, this.scope);
    this.indexPath = join(this.memoryDir, "MEMORY.md");
    mkdirSync(this.memoryDir, { recursive: true });

    // One-shot migration: if memoryRoot contains *.md files directly (pre-scope
    // layout), move them into user/. Idempotent — once migrated, the root has
    // no flat .md files and this becomes a no-op.
    this.migrateFlatLayout();
  }

  getMemoryDir(): string { return this.memoryDir; }
  getScope(): MemoryScope { return this.scope; }

  /**
   * Save a memory entry. Creates the file and updates the index.
   */
  save(entry: Omit<MemoryEntry, "fileName" | "scope">): string {
    const fileName = this.slugify(entry.name) + ".md";
    const filePath = join(this.memoryDir, fileName);

    // pinned/origin are written only when meaningful so legacy-shaped files
    // stay byte-identical for unpinned manual saves.
    const content =
      `---\n` +
      `name: ${entry.name}\n` +
      `description: ${entry.description}\n` +
      `type: ${entry.type}\n` +
      (entry.pinned ? `pinned: true\n` : "") +
      (entry.origin ? `origin: ${entry.origin}\n` : "") +
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
      const pinned = frontmatter.match(/pinned:\s*(.+)/)?.[1]?.trim() === "true";
      const originRaw = frontmatter.match(/origin:\s*(.+)/)?.[1]?.trim();
      const origin = originRaw === "auto" || originRaw === "manual" ? originRaw : undefined;
      let updatedAt = 0;
      try {
        updatedAt = statSync(filePath).mtimeMs;
      } catch {
        // mtime best-effort; 0 = unknown (never filtered out by maxAge).
      }

      return { name, description, type, content, fileName, scope: this.scope, updatedAt, pinned, origin };
    } catch {
      return null;
    }
  }

  /**
   * Soft-delete a memory by name or filename — moves the file into
   * <baseDir>/memory-trash/<ISO>/<scope>/ instead of unlinking it. The user
   * can recover by moving it back; we never hard-delete from this code path.
   */
  delete(nameOrFile: string): boolean {
    const entries = this.loadAll();
    const entry = entries.find(
      (e) => e.name === nameOrFile || e.fileName === nameOrFile,
    );
    if (!entry) return false;

    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const trashDir = join(this.baseDir, "memory-trash", stamp, this.scope);
      mkdirSync(trashDir, { recursive: true });
      renameSync(join(this.memoryDir, entry.fileName), join(trashDir, entry.fileName));
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
   * Build a prompt-friendly summary of all memories. Includes BOTH scopes
   * (user + dream) regardless of the manager's own scope, since prompts
   * should surface every memory the LLM might care about. Entries are
   * tagged with their origin so the model can tell user-owned from
   * dream-generated.
   */
  buildMemoryContext(opts?: { maxAgeDays?: number; now?: number }): string {
    const userEntries = filterByAge(
      this.scope === "user" ? this.loadAll() : this.loadScope("user"),
      opts?.maxAgeDays,
      opts?.now,
    );
    const dreamEntries = filterByAge(
      this.scope === "dream" ? this.loadAll() : this.loadScope("dream"),
      opts?.maxAgeDays,
      opts?.now,
    );

    if (userEntries.length === 0 && dreamEntries.length === 0) return "";

    // Pinned memories lead the list so the user's hand-picked context is what
    // the model reads first (sort is stable — unpinned keep their order).
    const pinnedFirst = (a: MemoryEntry, b: MemoryEntry): number =>
      Number(b.pinned ?? false) - Number(a.pinned ?? false);
    userEntries.sort(pinnedFirst);

    const lines: string[] = [];
    if (userEntries.length > 0) {
      lines.push("## User memories (you own these — needs permission to modify)");
      for (const e of userEntries) {
        lines.push(`- ${e.pinned ? "[pinned] " : ""}[${e.type}] ${e.name}: ${e.description}`);
      }
    }
    if (dreamEntries.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("## Dream memories (auto-consolidated workspace — freely modifiable)");
      for (const e of dreamEntries) {
        lines.push(`- [${e.type}] ${e.name}: ${e.description}`);
      }
    }

    return (
      `# Persistent Memory\n\n` +
      `The following memories from previous sessions may be relevant:\n\n` +
      lines.join("\n") +
      `\n\nTo read a specific memory, look under ${this.memoryRoot}/{user,dream}/`
    );
  }

  /**
   * Load every entry belonging to the given scope, without changing the
   * manager's own scope. Used by buildMemoryContext to merge user + dream
   * in one pass and by tools that need cross-scope visibility.
   */
  loadScope(scope: MemoryScope): MemoryEntry[] {
    const dir = join(this.memoryRoot, scope);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".md") && f !== "MEMORY.md",
    );
    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const e = this.loadFileFromDir(dir, file, scope);
      if (e) entries.push(e);
    }
    return entries;
  }

  private loadFileFromDir(
    dir: string,
    fileName: string,
    scope: MemoryScope,
  ): MemoryEntry | null {
    const filePath = join(dir, fileName);
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
      const pinned = frontmatter.match(/pinned:\s*(.+)/)?.[1]?.trim() === "true";
      const originRaw = frontmatter.match(/origin:\s*(.+)/)?.[1]?.trim();
      const origin = originRaw === "auto" || originRaw === "manual" ? originRaw : undefined;
      let updatedAt = 0;
      try {
        updatedAt = statSync(filePath).mtimeMs;
      } catch {
        // best-effort
      }
      return { name, description, type, content, fileName, scope, updatedAt, pinned, origin };
    } catch {
      return null;
    }
  }

  /**
   * Move pre-scope flat-layout entries (entries that lived directly under
   * <memoryRoot>/ before user/dream split) into <memoryRoot>/user/. Runs at
   * most once per directory — subsequent constructions find no flat .md
   * files and return immediately.
   */
  private migrateFlatLayout(): void {
    if (!existsSync(this.memoryRoot)) return;
    let entries: string[];
    try {
      entries = readdirSync(this.memoryRoot);
    } catch {
      return;
    }
    const flatFiles = entries.filter((f) => {
      if (!f.endsWith(".md")) return false;
      try {
        return statSync(join(this.memoryRoot, f)).isFile();
      } catch {
        return false;
      }
    });
    if (flatFiles.length === 0) return;

    const userDir = join(this.memoryRoot, "user");
    mkdirSync(userDir, { recursive: true });
    for (const file of flatFiles) {
      const src = join(this.memoryRoot, file);
      const dst = join(userDir, file);
      if (existsSync(dst)) continue; // don't clobber
      try {
        renameSync(src, dst);
      } catch {
        // best-effort migration; partial failure leaves user with a hybrid
        // layout but loadScope("user") will still pick up whatever moved.
      }
    }
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
