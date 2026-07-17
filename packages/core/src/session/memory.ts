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
 *              merge / delete entries here. The dream loop may ALSO maintain
 *              user/ entries whose origin is `auto` or `dream` (dedup/merge/
 *              improve), but origin:`manual` user entries — things the user
 *              explicitly asked to remember — are never touched by dream.
 *              See dream-consolidation.ts (the origin guard at ~:240).
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
import { createHash, randomUUID } from "node:crypto";

/**
 * Memory scopes (storage subdirs under a memory root):
 *  - user    user-owned; tool writes here are permission-gated
 *  - dream   the auto-consolidation workspace (LLM free-write)
 *  - pending 待审批门 (用户拍板): auto-extracted memories the LLM 判为"提全局"
 *            land here (global root only) and are NOT injected. The user
 *            approves (→ moves to user/) or rejects (→ trash) in the settings
 *            panel. Keeps the global layer curated — nothing auto-lands global.
 */
export type MemoryScope = "user" | "dream" | "pending";
export type MemoryOrigin = "auto" | "manual" | "dream";

export interface MemoryEntry {
  /** Stable identity. Legacy files without frontmatter id read as legacy:<scope>:<fileName>. */
  id?: string;
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  content: string;
  fileName: string;
  scope: MemoryScope;
  /** Semantic last content update time from frontmatter. */
  updatedAt?: string;
  /** File mtime in epoch ms — drives maxAge filtering (TODO 8.1). 0 if unknown. */
  mtimeMs?: number;
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
  origin?: MemoryOrigin;
  /**
   * Recall lifecycle (召回 TTL). `useCount` increments each time MemoryRead
   * hits this entry; `lastUsedAt` is the ISO timestamp of that last hit;
   * `createdAt` is set on first save and preserved across UPDATE. Drives recall-based TTL:
   * a `project`-type memory not read for N days is pruned. Stored in frontmatter
   * — no SQLite. Legacy `usageCount/lastUsed/created` fields are still read and
   * exposed through their old aliases for compatibility.
   */
  useCount?: number;
  updateCount?: number;
  lastUsedAt?: string;
  createdAt?: string;
  /** Legacy compatibility aliases. New writes use useCount/lastUsedAt/createdAt. */
  usageCount?: number;
  lastUsed?: string;
  created?: string;
  /**
   * 审批门 (用户拍板): for `pending`-scope entries, the project cwd the memory
   * was extracted in. On "不批准/降级" the entry falls back to THIS project's
   * user store (not the current one). Absent → fall back to no-repo / global.
   */
  originProject?: string;
  /** Global dream promotion metadata (P1). */
  promotionKey?: string;
  originProjects?: string[];
  evidenceCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  promotionReason?: string;
  promotionStatus?: "pending" | "rejected";
  promotionSourceId?: string;
}

function frontmatterLine(key: string, value: string | number | boolean | string[]): string {
  return `${key}: ${JSON.stringify(value)}\n`;
}

function parseFrontmatterValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
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
  return entries.filter((e) => {
    const updatedMs = e.mtimeMs ?? (e.updatedAt ? new Date(e.updatedAt).getTime() : Number.NaN);
    return e.pinned || !Number.isFinite(updatedMs) || updatedMs <= 0 || updatedMs >= cutoff;
  });
}

export interface SaveMemoryOptions {
  /** False for lifecycle-only writes such as recordRecall and pin/unpin. */
  incrementUpdateCount?: boolean;
  /** Force provenance regardless of model/tool args. Used by origin guards. */
  forceOrigin?: MemoryOrigin;
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
  // `process.env.HOME ?? homedir()` (NOT raw homedir()): bun caches homedir()
  // at process start and never re-reads it, so a test's HOME override — and any
  // code that relies on $HOME — would be ignored, and memory would read the
  // REAL ~/.code-shell (leaking global memories into isolated tests). See the
  // homedir()-cache trap; mirrors settings/manager.ts userHome().
  const home = process.env.HOME ?? homedir();
  return join(home, ".code-shell");
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

  getMemoryDir(): string {
    return this.memoryDir;
  }
  getScope(): MemoryScope {
    return this.scope;
  }

  /**
   * Save a memory entry. New entries get a stable id and `<id>.md`; entries
   * carrying an existing id update that file even when name changes.
   */
  save(entry: Omit<MemoryEntry, "fileName" | "scope">, opts: SaveMemoryOptions = {}): string {
    const nowIso = new Date().toISOString();
    const inputId = entry.id;
    const syntheticLegacy = inputId ? this.parseSyntheticLegacyId(inputId) : null;
    const existing =
      inputId && !syntheticLegacy
        ? (this.findById(inputId) ?? null)
        : syntheticLegacy && syntheticLegacy.scope === this.scope
          ? this.loadFile(syntheticLegacy.fileName)
          : null;
    const id = inputId && !syntheticLegacy ? inputId : this.generateId();
    const fileName = existing?.fileName ?? this.availableFileNameForId(id);
    const filePath = join(this.memoryDir, fileName);

    const origin: MemoryOrigin = opts.forceOrigin ?? entry.origin ?? existing?.origin ?? "manual";
    const pinned = entry.pinned ?? existing?.pinned;
    const createdAt = entry.createdAt ?? entry.created ?? existing?.createdAt ?? nowIso;
    const useCount = entry.useCount ?? entry.usageCount ?? existing?.useCount ?? 0;
    const lastUsedAt = entry.lastUsedAt ?? entry.lastUsed ?? existing?.lastUsedAt ?? createdAt;
    const originProject = entry.originProject ?? existing?.originProject;
    const promotionKey = entry.promotionKey ?? existing?.promotionKey;
    const originProjects = entry.originProjects ?? existing?.originProjects;
    const evidenceCount = entry.evidenceCount ?? existing?.evidenceCount;
    const firstSeenAt = entry.firstSeenAt ?? existing?.firstSeenAt;
    const lastSeenAt = entry.lastSeenAt ?? existing?.lastSeenAt;
    const promotionReason = entry.promotionReason ?? existing?.promotionReason;
    const promotionStatus = entry.promotionStatus ?? existing?.promotionStatus;
    const promotionSourceId = entry.promotionSourceId ?? existing?.promotionSourceId;

    const contentChanged =
      existing != null &&
      (existing.name !== entry.name ||
        existing.description !== entry.description ||
        existing.type !== entry.type ||
        existing.content !== entry.content);
    const incrementUpdateCount = opts.incrementUpdateCount !== false && contentChanged;
    const updateCount =
      (entry.updateCount ?? existing?.updateCount ?? 0) + (incrementUpdateCount ? 1 : 0);
    const updatedAt = incrementUpdateCount
      ? nowIso
      : (entry.updatedAt ?? existing?.updatedAt ?? nowIso);

    const content =
      `---\n` +
      frontmatterLine("id", id) +
      frontmatterLine("name", entry.name) +
      frontmatterLine("description", entry.description) +
      frontmatterLine("type", entry.type) +
      frontmatterLine("origin", origin) +
      (pinned ? frontmatterLine("pinned", true) : "") +
      (originProject ? frontmatterLine("originProject", originProject) : "") +
      (promotionKey ? frontmatterLine("promotionKey", promotionKey) : "") +
      (originProjects && originProjects.length > 0
        ? frontmatterLine("originProjects", originProjects)
        : "") +
      (typeof evidenceCount === "number" ? frontmatterLine("evidenceCount", evidenceCount) : "") +
      (firstSeenAt ? frontmatterLine("firstSeenAt", firstSeenAt) : "") +
      (lastSeenAt ? frontmatterLine("lastSeenAt", lastSeenAt) : "") +
      (promotionReason ? frontmatterLine("promotionReason", promotionReason) : "") +
      (promotionStatus ? frontmatterLine("promotionStatus", promotionStatus) : "") +
      (promotionSourceId ? frontmatterLine("promotionSourceId", promotionSourceId) : "") +
      frontmatterLine("createdAt", createdAt) +
      frontmatterLine("updatedAt", updatedAt) +
      frontmatterLine("lastUsedAt", lastUsedAt) +
      frontmatterLine("useCount", useCount) +
      frontmatterLine("updateCount", updateCount) +
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

    const files = readdirSync(this.memoryDir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");

    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const entry = this.loadFile(file);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  findById(id: string): MemoryEntry | undefined {
    return this.loadAll().find((e) => e.id === id);
  }

  find(nameOrFileOrId: string): MemoryEntry | undefined {
    return this.loadAll().find(
      (e) => e.id === nameOrFileOrId || e.name === nameOrFileOrId || e.fileName === nameOrFileOrId,
    );
  }

  isOwnedBy(entry: MemoryEntry | undefined, allowedOrigins: readonly MemoryOrigin[]): boolean {
    if (!entry) return false;
    return allowedOrigins.includes(entry.origin ?? "manual");
  }

  deleteIfOwned(
    nameOrFileOrId: string,
    allowedOrigins: readonly MemoryOrigin[],
  ): "deleted" | "not_found" | "protected" {
    const entry = this.find(nameOrFileOrId);
    if (!entry) return "not_found";
    if (!this.isOwnedBy(entry, allowedOrigins)) return "protected";
    return this.delete(entry.id ?? entry.fileName) ? "deleted" : "not_found";
  }

  /**
   * Load a single memory file.
   */
  private loadFile(fileName: string): MemoryEntry | null {
    const filePath = join(this.memoryDir, fileName);
    if (!existsSync(filePath)) return null;

    return this.loadFileFromDir(this.memoryDir, fileName, this.scope);
  }

  /**
   * Parse a memory file's frontmatter + body into a MemoryEntry. Shared by both
   * loadFile (own scope) and loadScope (cross-scope) so the parsing of every
   * field — including the lifecycle fields — lives in exactly one place.
   * Returns null on missing file / unparseable frontmatter.
   */
  private parseMemoryFile(
    filePath: string,
    fileName: string,
    scope: MemoryScope,
  ): MemoryEntry | null {
    if (!existsSync(filePath)) return null;
    try {
      const raw = readFileSync(filePath, "utf-8");
      const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
      if (!frontmatterMatch) return null;

      const frontmatter = frontmatterMatch[1];
      const content = frontmatterMatch[2].trim();

      const readRaw = (key: string): string | undefined =>
        frontmatter.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim();
      const readValue = (key: string): unknown | undefined => {
        const raw = readRaw(key);
        return raw === undefined ? undefined : parseFrontmatterValue(raw);
      };
      const read = (key: string): string | undefined => {
        const value = readValue(key);
        if (value === undefined || value === null) return undefined;
        if (Array.isArray(value)) return value.map(String).join(",");
        return String(value);
      };
      const readList = (key: string): string[] | undefined => {
        const raw = readRaw(key);
        if (raw !== undefined && raw.length > 0) {
          const value = parseFrontmatterValue(raw);
          if (Array.isArray(value)) {
            const values = value.map((item) => String(item)).filter(Boolean);
            return values.length > 0 ? values : undefined;
          }
          if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
            const values = value
              .slice(1, -1)
              .split(",")
              .map((item) => item.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean);
            return values.length > 0 ? values : undefined;
          }
          return [String(value)];
        }
        const block = frontmatter.match(new RegExp(`^${key}:\\s*\\n((?:\\s+-\\s+.*\\n?)*)`, "m"));
        if (block?.[1]) {
          const values = block[1]
            .split(/\n/)
            .map((line) => line.match(/^\s+-\s+(.+)\s*$/)?.[1]?.trim())
            .filter((value): value is string => Boolean(value));
          return values.length > 0 ? values : undefined;
        }
        return undefined;
      };
      const readNumber = (key: string): number | undefined => {
        const value = readValue(key);
        if (value === undefined || value === null || value === "") return undefined;
        if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
        const parsed = parseInt(String(value), 10);
        return Number.isFinite(parsed) ? parsed : undefined;
      };
      const readBoolean = (key: string): boolean => {
        const value = readValue(key);
        return value === true || value === "true";
      };
      const id = read("id") ?? `legacy:${scope}:${fileName}`;
      const name = read("name") ?? fileName;
      const description = read("description") ?? "";
      const type = (read("type") ?? "project") as MemoryEntry["type"];
      const pinned = readBoolean("pinned");
      // Anchor with ^…/m so `origin:` doesn't accidentally match the
      // `originProject:` line (and vice-versa).
      const originRaw = read("origin");
      const origin: MemoryOrigin =
        originRaw === "auto" || originRaw === "manual" || originRaw === "dream"
          ? originRaw
          : "manual";
      const originProject = read("originProject") || undefined;

      let mtimeMs = 0;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        // mtime best-effort; 0 = unknown (never filtered out by maxAge).
      }

      // Lifecycle fields. Legacy files lack them → fall back to mtime so a TTL
      // sweep treats them as "last used = file age" rather than "never used".
      const mtimeIso = mtimeMs > 0 ? new Date(mtimeMs).toISOString() : undefined;
      const createdAt = read("createdAt") ?? read("created") ?? mtimeIso;
      const updatedAt = read("updatedAt") ?? mtimeIso ?? createdAt;
      const lastUsedAt = read("lastUsedAt") ?? read("lastUsed") ?? createdAt;
      const useRaw = read("useCount") ?? read("usageCount");
      const updateRaw = read("updateCount");
      const useCount = useRaw ? parseInt(useRaw, 10) : 0;
      const updateCount = updateRaw ? parseInt(updateRaw, 10) : 0;
      const promotionKey = read("promotionKey");
      const originProjects = readList("originProjects");
      const evidenceCount = readNumber("evidenceCount");
      const firstSeenAt = read("firstSeenAt");
      const lastSeenAt = read("lastSeenAt");
      const promotionReason = read("promotionReason");
      const promotionStatusRaw = read("promotionStatus");
      const promotionStatus =
        promotionStatusRaw === "pending" || promotionStatusRaw === "rejected"
          ? promotionStatusRaw
          : undefined;
      const promotionSourceId = read("promotionSourceId");

      return {
        id,
        name,
        description,
        type,
        content,
        fileName,
        scope,
        updatedAt,
        mtimeMs,
        pinned,
        origin,
        useCount,
        updateCount,
        lastUsedAt,
        createdAt,
        usageCount: useCount,
        lastUsed: lastUsedAt,
        created: createdAt,
        originProject,
        promotionKey,
        originProjects,
        evidenceCount,
        firstSeenAt,
        lastSeenAt,
        promotionReason,
        promotionStatus,
        promotionSourceId,
      };
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
      (e) => e.id === nameOrFile || e.name === nameOrFile || e.fileName === nameOrFile,
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
   * Record a recall: a MemoryRead hit this entry. Bumps usageCount and sets
   * lastUsed=now, rewriting only the frontmatter (content untouched). This is
   * the signal that drives recall-based TTL — a memory that keeps getting read
   * never ages out. Idempotent-safe: missing entry → false, no throw.
   */
  recordRecall(nameOrFile: string, now: Date = new Date()): boolean {
    const entry = this.loadAll().find(
      (e) => e.id === nameOrFile || e.name === nameOrFile || e.fileName === nameOrFile,
    );
    if (!entry) return false;
    try {
      this.save(
        {
          id: entry.id,
          name: entry.name,
          description: entry.description,
          type: entry.type,
          content: entry.content,
          pinned: entry.pinned,
          origin: entry.origin,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          useCount: (entry.useCount ?? 0) + 1,
          updateCount: entry.updateCount,
          lastUsedAt: now.toISOString(),
          originProject: entry.originProject,
        },
        { incrementUpdateCount: false },
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Recall-based TTL sweep. Soft-deletes `project`-type memories not read for
   * more than `ttlDays` (by lastUsed). Stable types (user/feedback/reference)
   * and pinned entries are NEVER pruned — only ephemeral project events age out.
   * Returns the names pruned. ttlDays<=0 disables the sweep.
   */
  pruneByRecall(ttlDays: number, now: Date = new Date()): string[] {
    if (!ttlDays || ttlDays <= 0) return [];
    const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
    const pruned: string[] = [];
    for (const e of this.loadAll()) {
      if (e.type !== "project") continue; // stable types are exempt
      if (e.pinned) continue; // pinned exempt
      const lastUsedMs = e.lastUsedAt ? new Date(e.lastUsedAt).getTime() : NaN;
      // Unknown lastUsed (unparseable) → keep, never prune on missing data.
      if (!Number.isFinite(lastUsedMs)) continue;
      if (lastUsedMs < cutoff) {
        if (this.delete(e.name)) pruned.push(e.name);
      }
    }
    return pruned;
  }

  /**
   * Approve a pending memory: move it from the pending scope into the global
   * dream scope of the SAME memory root. Pending only ever exists at the global
   * root; approval gates whether a suggested global dream becomes injected.
   * Must be called on a pending-scope manager. Returns the new global dream
   * filename, or null if not found / wrong scope.
   *
   * 审批门 (用户拍板): the only path that moves a suggested global dream into the
   * injected global dream store.
   */
  approvePending(nameOrFile: string): string | null {
    return this.movePending(nameOrFile, "global");
  }

  /**
   * Demote a pending memory: 不批准升全局,但它仍是有用记忆 → 落回它来源项目的
   * user store (originProject)。无 originProject 时落全局 user(兜底,不丢)。
   */
  demotePending(nameOrFile: string): string | null {
    return this.movePending(nameOrFile, "project");
  }

  /**
   * Reject a pending global-dream suggestion. The project dream entry stays in
   * place, but is marked so the same source is not suggested again.
   */
  rejectPending(nameOrFile: string): boolean {
    if (this.scope !== "pending") return false;
    const entry = this.find(nameOrFile);
    if (!entry) return false;

    if (entry.originProject) {
      const projectDream = new MemoryManager({
        baseDir: this.baseDir,
        projectDir: entry.originProject,
        scope: "dream",
      });
      const source =
        (entry.promotionSourceId ? projectDream.findById(entry.promotionSourceId) : undefined) ??
        projectDream.loadAll().find((candidate) => candidate.name === entry.name);
      if (source && source.origin !== "manual") {
        projectDream.save(
          {
            id: source.id,
            name: source.name,
            description: source.description,
            type: source.type,
            content: source.content,
            origin: source.origin ?? "dream",
            pinned: source.pinned,
            createdAt: source.createdAt,
            updatedAt: source.updatedAt,
            lastUsedAt: source.lastUsedAt,
            useCount: source.useCount,
            updateCount: source.updateCount,
            originProject: source.originProject,
            originProjects: source.originProjects,
            evidenceCount: source.evidenceCount,
            firstSeenAt: source.firstSeenAt,
            lastSeenAt: source.lastSeenAt,
            promotionReason: entry.promotionReason ?? source.promotionReason,
            promotionStatus: "rejected",
          },
          { incrementUpdateCount: false, forceOrigin: source.origin ?? "dream" },
        );
      }
    }

    return this.delete(entry.id ?? entry.name);
  }

  /** Shared move for approve(→global dream)/demote(→origin-project user). */
  private movePending(nameOrFile: string, dest: "global" | "project"): string | null {
    if (this.scope !== "pending") return null;
    const entry = this.find(nameOrFile);
    if (!entry) return null;
    const targetMgr =
      dest === "global"
        ? new MemoryManager({ baseDir: this.baseDir, scope: "dream" })
        : dest === "project" && entry.originProject
          ? new MemoryManager({
              baseDir: this.baseDir,
              projectDir: entry.originProject,
              scope: "user",
            })
          : new MemoryManager({ baseDir: this.baseDir, scope: "user" }); // demote fallback
    const destinationOrigin: MemoryOrigin = dest === "global" ? "dream" : (entry.origin ?? "auto");
    const fileName = targetMgr.save(
      {
        name: entry.name,
        description: entry.description,
        type: entry.type,
        content: entry.content,
        origin: destinationOrigin,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        lastUsedAt: entry.lastUsedAt,
        useCount: entry.useCount,
        updateCount: entry.updateCount,
        originProjects: entry.originProjects ?? (entry.originProject ? [entry.originProject] : []),
        evidenceCount: entry.evidenceCount,
        firstSeenAt: entry.firstSeenAt,
        lastSeenAt: entry.lastSeenAt,
        promotionReason: entry.promotionReason,
        // originProject/promotionSourceId are no longer needed once it has landed
        // in a real store.
      },
      { forceOrigin: destinationOrigin },
    );
    this.delete(entry.name); // soft-delete the pending copy
    return fileName;
  }

  /**
   * Promote a project-level user memory to the GLOBAL user store (用户手动点
   * "提升到全局")。Must be called on a project-scoped user manager. Copies the
   * entry into global user/ and soft-deletes the project copy. Returns the new
   * global filename, or null if not found.
   */
  promoteToGlobal(nameOrFile: string): string | null {
    const entry = this.loadAll().find((e) => e.name === nameOrFile || e.fileName === nameOrFile);
    if (!entry) return null;
    const globalMgr = new MemoryManager({ baseDir: this.baseDir, scope: "user" });
    const fileName = globalMgr.save({
      name: entry.name,
      description: entry.description,
      type: entry.type,
      content: entry.content,
      origin: entry.origin,
      pinned: entry.pinned,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      lastUsedAt: entry.lastUsedAt,
      useCount: entry.useCount,
      updateCount: entry.updateCount,
    });
    this.delete(entry.name); // remove from the project store
    return fileName;
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
   * Three-layer injection index (用户拍板). Merges GLOBAL (cross-project
   * experience) + DIGITAL-HUMAN (portable profile experience) + PROJECT
   * (this repo's facts) memories into a compact index — one line per entry,
   * name + description only, NO body.
   *
   * This is what fixes "global memory never shows up": global memories are now
   * injected alongside project ones, every session, regardless of cwd.
   *
   * Static because it must construct the managers for each configured layer.
   * `projectDir` undefined → no project layer; `profileDir` undefined → no
   * digital-human layer.
   */
  static buildInjectionIndex(opts: {
    projectDir?: string;
    profileDir?: string;
    baseDir?: string;
    maxAgeDays?: number;
    now?: number;
  }): string {
    const global = new MemoryManager({ baseDir: opts.baseDir });
    const project = opts.projectDir
      ? new MemoryManager({ baseDir: opts.baseDir, projectDir: opts.projectDir })
      : null;
    // 数字人层：baseDir 直接指向 profiles/<name>（其 memory/ 子目录随
    // MemoryManager 的常规布局落盘）。跟着 Profile 走、跨 workspace 复用。
    const profile = opts.profileDir ? new MemoryManager({ baseDir: opts.profileDir }) : null;

    const pinnedFirst = (a: MemoryEntry, b: MemoryEntry): number =>
      Number(b.pinned ?? false) - Number(a.pinned ?? false);

    const collect = (mm: MemoryManager): MemoryEntry[] =>
      filterByAge(
        [...mm.loadScope("user"), ...mm.loadScope("dream")],
        opts.maxAgeDays,
        opts.now,
      ).sort(pinnedFirst);

    const globalEntries = collect(global);
    const profileEntries = profile ? collect(profile) : [];
    const projectEntries = project ? collect(project) : [];

    if (globalEntries.length === 0 && profileEntries.length === 0 && projectEntries.length === 0) {
      return "";
    }

    const fmt = (e: MemoryEntry): string =>
      `- ${e.pinned ? "[pinned] " : ""}[${e.type}] ${e.name}: ${e.description}`;
    const readableLocations = profile ? "global, profile, or project" : "global or project";

    const lines: string[] = [];
    if (globalEntries.length > 0) {
      lines.push("## Global memories (apply across all projects)");
      for (const e of globalEntries) lines.push(fmt(e));
    }
    if (profileEntries.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("## Digital-human memories (travel with the active profile)");
      for (const e of profileEntries) lines.push(fmt(e));
    }
    if (projectEntries.length > 0) {
      if (lines.length > 0) lines.push("");
      lines.push("## Project memories (this repo)");
      for (const e of projectEntries) lines.push(fmt(e));
    }

    return (
      `# Persistent Memory (index)\n\n` +
      `These are summaries of memories from previous sessions. Only the summary is shown here.\n` +
      `When a memory looks relevant to the current task, read its full content with the ` +
      `MemoryRead tool (scope = user or dream; location = ${readableLocations}) before relying on it.\n\n` +
      lines.join("\n")
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
    const files = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    const entries: MemoryEntry[] = [];
    for (const file of files) {
      const e = this.loadFileFromDir(dir, file, scope);
      if (e) entries.push(e);
    }
    return entries;
  }

  private loadFileFromDir(dir: string, fileName: string, scope: MemoryScope): MemoryEntry | null {
    return this.parseMemoryFile(join(dir, fileName), fileName, scope);
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
    const content = lines.length > 0 ? lines.join("\n") + "\n" : "(no memories stored)\n";
    writeFileSync(this.indexPath, content, "utf-8");
  }

  private generateId(): string {
    return `mem_${randomUUID().replace(/-/g, "")}`;
  }

  private availableFileNameForId(id: string): string {
    let attempt = 0;
    while (attempt < 100) {
      const fileName = this.fileNameForId(id, attempt);
      const existing = this.loadFile(fileName);
      if (!existing || existing.id === id) return fileName;
      attempt++;
    }
    throw new Error(`Unable to allocate a memory filename for id "${id}"`);
  }

  private fileNameForId(id: string, collisionAttempt = 0): string {
    if (collisionAttempt === 0 && /^[a-z0-9][a-z0-9_.-]*$/.test(id) && !id.includes("..")) {
      return `${id}.md`;
    }
    const safeStem =
      id
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^[._-]+|[._-]+$/g, "")
        .slice(0, 80) || "memory";
    const hashInput = collisionAttempt === 0 ? id : `${id}:${collisionAttempt}`;
    const hash = createHash("sha256").update(hashInput).digest("hex").slice(0, 12);
    return `${safeStem}-${hash}.md`;
  }

  private parseSyntheticLegacyId(id: string): { scope: MemoryScope; fileName: string } | null {
    const match = id.match(/^legacy:(user|dream|pending):(.+)$/);
    if (!match) return null;
    return { scope: match[1] as MemoryScope, fileName: match[2] };
  }
}
