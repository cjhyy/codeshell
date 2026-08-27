import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import { join } from "node:path";
import { sessionsRoot as defaultSessionsRoot } from "@cjhyy/code-shell-core";
import { canonicalKey } from "@cjhyy/code-shell-core/internal";

const MAX_SESSION_DIRS_TO_SCAN = 20_000;
const DEFAULT_TENTATIVE_TTL_MS = 60_000;

export interface SessionCwdIndexState {
  sessionId?: unknown;
  cwd?: unknown;
  workspace?: { root?: unknown; kind?: unknown };
  project?: { projectId?: unknown; mainRootId?: unknown };
}

export interface SessionCwdIndexEntry {
  sessionId: string;
  cwd: string;
  workspaceRoot?: string;
  projectId?: string;
  mainRootId?: string;
  status: "confirmed" | "tentative";
}

export interface SessionCwdIndexFs {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<Array<{ name: string; isDirectory(): boolean }>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<{ isFile(): boolean }>;
}

export interface SessionCwdIndexSyncFs {
  readFileSync(path: string, encoding: "utf8"): string;
  statSync(path: string): { isFile(): boolean };
}

interface TentativeEntry extends SessionCwdIndexEntry {
  status: "tentative";
  expiresAt: number;
}

interface SessionCwdIndexOptions {
  sessionsRoot: string;
  fs?: SessionCwdIndexFs;
  syncFs?: SessionCwdIndexSyncFs;
  now?: () => number;
  tentativeTtlMs?: number;
}

export class SessionCwdIndex {
  private readonly fs: SessionCwdIndexFs;
  private readonly now: () => number;
  private readonly syncFs: SessionCwdIndexSyncFs;
  private readonly tentativeTtlMs: number;
  private readonly entries = new Map<string, SessionCwdIndexEntry | TentativeEntry>();
  private readonly confirmedByCwd = new Map<string, Set<string>>();
  private loadPromise?: Promise<void>;
  private loaded = false;

  constructor(private readonly options: SessionCwdIndexOptions) {
    this.fs = options.fs ?? fs;
    this.syncFs = options.syncFs ?? fsSync;
    this.now = options.now ?? Date.now;
    this.tentativeTtlMs = options.tentativeTtlMs ?? DEFAULT_TENTATIVE_TTL_MS;
  }

  ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.scanOnce().finally(() => {
        this.loaded = true;
      });
    }
    return this.loadPromise;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  lookupCached(sessionId: string): SessionCwdIndexEntry | undefined {
    const entry = this.entries.get(sessionId);
    if (!entry) return undefined;
    if (entry.status === "tentative" && "expiresAt" in entry && entry.expiresAt <= this.now()) {
      this.entries.delete(sessionId);
      return undefined;
    }
    return publicEntry(entry);
  }

  async lookup(sessionId: string): Promise<SessionCwdIndexEntry | undefined> {
    await this.ensureLoaded();
    const cached = this.lookupCached(sessionId);
    if (cached) return cached;
    return this.readOne(sessionId, false);
  }

  async refresh(sessionId: string): Promise<SessionCwdIndexEntry | undefined> {
    await this.ensureLoaded();
    return this.readOne(sessionId, true);
  }

  /** Main's synchronous frame-rewrite seam: read only one known Session state file. */
  refreshSync(sessionId: string): SessionCwdIndexEntry | undefined {
    if (!this.loaded || !validSessionId(sessionId)) return undefined;
    const file = join(this.options.sessionsRoot, sessionId, "state.json");
    try {
      if (!this.syncFs.statSync(file).isFile()) return undefined;
      const state = JSON.parse(this.syncFs.readFileSync(file, "utf8")) as SessionCwdIndexState;
      const entry = parseState(sessionId, state);
      if (entry) this.replace(entry);
      else this.forget(sessionId);
      return entry ? publicEntry(entry) : undefined;
    } catch {
      this.forget(sessionId);
      return undefined;
    }
  }

  resolveConfirmedCwds(cwds: readonly string[]): boolean[] {
    this.pruneExpired();
    return cwds.map((cwd) => (this.confirmedByCwd.get(canonicalKey(cwd))?.size ?? 0) > 0);
  }

  confirmedEntriesForCwd(cwd: string): SessionCwdIndexEntry[] {
    this.pruneExpired();
    const ids = this.confirmedByCwd.get(canonicalKey(cwd));
    if (!ids) return [];
    return [...ids]
      .map((id) => this.entries.get(id))
      .filter((entry): entry is SessionCwdIndexEntry => entry?.status === "confirmed")
      .map(publicEntry);
  }

  confirmedEntries(): SessionCwdIndexEntry[] {
    this.pruneExpired();
    return [...this.entries.values()]
      .filter((entry): entry is SessionCwdIndexEntry => entry.status === "confirmed")
      .map(publicEntry);
  }

  upsert(
    sessionId: string,
    value: Omit<SessionCwdIndexEntry, "sessionId" | "status">,
  ): SessionCwdIndexEntry {
    const entry: SessionCwdIndexEntry = { sessionId, ...value, status: "confirmed" };
    this.replace(entry);
    return publicEntry(entry);
  }

  setTentative(
    sessionId: string,
    value: Omit<SessionCwdIndexEntry, "sessionId" | "status">,
  ): SessionCwdIndexEntry {
    const entry: TentativeEntry = {
      sessionId,
      ...value,
      status: "tentative",
      expiresAt: this.now() + this.tentativeTtlMs,
    };
    this.replace(entry);
    return publicEntry(entry);
  }

  extendTentative(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.status !== "tentative") return false;
    if (!("expiresAt" in entry)) return false;
    entry.expiresAt = this.now() + this.tentativeTtlMs;
    return true;
  }

  confirm(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.status !== "tentative") return false;
    this.replace({ ...publicEntry(entry), status: "confirmed" });
    return true;
  }

  evictTentative(sessionId: string): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.status !== "tentative") return false;
    this.entries.delete(sessionId);
    return true;
  }

  setWorkspaceRoot(sessionId: string, workspaceRoot: string | undefined): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry) return false;
    if (workspaceRoot) entry.workspaceRoot = workspaceRoot;
    else delete entry.workspaceRoot;
    return true;
  }

  forget(sessionId: string): void {
    const prior = this.entries.get(sessionId);
    if (prior?.status === "confirmed") this.removeConfirmedCwd(prior.cwd, sessionId);
    this.entries.delete(sessionId);
  }

  private async scanOnce(): Promise<void> {
    let dirs: Array<{ name: string; isDirectory(): boolean }>;
    try {
      dirs = await this.fs.readdir(this.options.sessionsRoot, { withFileTypes: true });
    } catch {
      return;
    }

    const sessionIds = dirs
      .slice(0, MAX_SESSION_DIRS_TO_SCAN)
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
    for (let offset = 0; offset < sessionIds.length; offset += 64) {
      await Promise.all(
        sessionIds.slice(offset, offset + 64).map(async (sessionId) => {
          const entry = await this.readStateFile(sessionId, false);
          if (entry) this.replace(entry);
        }),
      );
    }
  }

  private async readOne(
    sessionId: string,
    replaceMissing: boolean,
  ): Promise<SessionCwdIndexEntry | undefined> {
    const entry = await this.readStateFile(sessionId, true);
    if (entry) {
      this.replace(entry);
      return publicEntry(entry);
    }
    if (replaceMissing) this.forget(sessionId);
    return undefined;
  }

  private async readStateFile(
    sessionId: string,
    checkFile: boolean,
  ): Promise<SessionCwdIndexEntry | undefined> {
    if (!validSessionId(sessionId)) return undefined;
    const file = join(this.options.sessionsRoot, sessionId, "state.json");
    try {
      if (checkFile && !(await this.fs.stat(file)).isFile()) return undefined;
      const state = JSON.parse(await this.fs.readFile(file, "utf8")) as SessionCwdIndexState;
      return parseState(sessionId, state);
    } catch {
      return undefined;
    }
  }

  private replace(entry: SessionCwdIndexEntry | TentativeEntry): void {
    const prior = this.entries.get(entry.sessionId);
    if (prior?.status === "confirmed") this.removeConfirmedCwd(prior.cwd, entry.sessionId);
    this.entries.set(entry.sessionId, entry);
    if (entry.status === "confirmed") {
      const key = canonicalKey(entry.cwd);
      let ids = this.confirmedByCwd.get(key);
      if (!ids) {
        ids = new Set();
        this.confirmedByCwd.set(key, ids);
      }
      ids.add(entry.sessionId);
    }
  }

  private removeConfirmedCwd(cwd: string, sessionId: string): void {
    const key = canonicalKey(cwd);
    const ids = this.confirmedByCwd.get(key);
    ids?.delete(sessionId);
    if (ids?.size === 0) this.confirmedByCwd.delete(key);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const [sessionId, entry] of this.entries) {
      if (entry.status === "tentative" && "expiresAt" in entry && entry.expiresAt <= now) {
        this.entries.delete(sessionId);
      }
    }
  }
}

function parseState(
  sessionId: string,
  state: SessionCwdIndexState,
): SessionCwdIndexEntry | undefined {
  if (typeof state.cwd !== "string" || state.cwd.length === 0) return undefined;
  const persistedSessionId =
    typeof state.sessionId === "string" && state.sessionId.length > 0 ? state.sessionId : sessionId;
  if (persistedSessionId !== sessionId) return undefined;
  const workspaceRoot =
    typeof state.workspace?.root === "string" && state.workspace.root.length > 0
      ? state.workspace.root
      : undefined;
  const projectId =
    typeof state.project?.projectId === "string" && state.project.projectId.length > 0
      ? state.project.projectId
      : undefined;
  const mainRootId =
    typeof state.project?.mainRootId === "string" && state.project.mainRootId.length > 0
      ? state.project.mainRootId
      : undefined;
  return {
    sessionId,
    cwd: state.cwd,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(projectId ? { projectId } : {}),
    ...(mainRootId ? { mainRootId } : {}),
    status: "confirmed",
  };
}

function publicEntry(entry: SessionCwdIndexEntry | TentativeEntry): SessionCwdIndexEntry {
  const { sessionId, cwd, workspaceRoot, projectId, mainRootId, status } = entry;
  return {
    sessionId,
    cwd,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    ...(projectId ? { projectId } : {}),
    ...(mainRootId ? { mainRootId } : {}),
    status,
  };
}

function validSessionId(sessionId: string): boolean {
  return Boolean(sessionId) && sessionId.length <= 512 && !/[\\/\0]/u.test(sessionId);
}

const indexes = new Map<string, SessionCwdIndex>();

export function getSessionCwdIndex(root = defaultSessionsRoot()): SessionCwdIndex {
  let index = indexes.get(root);
  if (!index) {
    index = new SessionCwdIndex({ sessionsRoot: root });
    indexes.set(root, index);
  }
  return index;
}

export function __resetSessionCwdIndexesForTest(): void {
  indexes.clear();
}
