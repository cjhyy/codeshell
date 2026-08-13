import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { codeShellHome, logger, normalizeCwdPath } from "@cjhyy/code-shell-core/extension";

export type ExternalAgentCli = "claude" | "codex";

export interface ExternalAgentSessionBinding {
  cli: ExternalAgentCli;
  sessionId: string;
  codeShellSessionId?: string;
  cwd: string;
  workspaceRoot?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseRef?: string;
  isolation?: "current" | "worktree" | "none";
  createdAt: number;
  lastUsedAt: number;
  /** @deprecated Use lastUsedAt. Kept while reading v1 snapshots. */
  updatedAt: number;
}

export type ExternalAgentSessionRecord = Omit<
  ExternalAgentSessionBinding,
  "createdAt" | "lastUsedAt" | "updatedAt"
> & {
  createdAt?: number;
  lastUsedAt?: number;
  updatedAt?: number;
};

interface ExternalAgentSessionSnapshot {
  version: 1 | 2;
  sessions: ExternalAgentSessionBinding[];
}

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_POLL_MS = 10;

export function defaultExternalAgentSessionStorePath(): string {
  return join(codeShellHome(), "external-agent-sessions.json");
}

export class ExternalAgentSessionStore {
  private readonly pendingBindings = new Map<string, ExternalAgentSessionBinding>();

  constructor(private readonly file = defaultExternalAgentSessionStorePath()) {}

  /** Snapshot all known bindings. Returned objects are detached from the
   *  persisted array so read-only consumers (for example room discovery) can
   *  correlate worktree sessions without gaining a mutation path. */
  list(): ExternalAgentSessionBinding[] {
    const merged = new Map(this.load().map((binding) => [bindingKey(binding), binding]));
    for (const [key, binding] of this.pendingBindings) merged.set(key, binding);
    return [...merged.values()].map((binding) => ({ ...binding }));
  }

  get(cli: ExternalAgentCli, sessionId: string): ExternalAgentSessionBinding | undefined {
    if (!sessionId) return undefined;
    const pending = this.pendingBindings.get(bindingKey({ cli, sessionId }));
    return pending ?? this.load().find((s) => s.cli === cli && s.sessionId === sessionId);
  }

  async record(binding: ExternalAgentSessionRecord): Promise<void> {
    if (!binding.sessionId || !binding.cwd) return;
    const key = bindingKey(binding);
    // Preserve the old immediate-read contract while disk persistence proceeds
    // without blocking the event loop. This instance overlays the pending value
    // on list/get until the atomic write finishes.
    const optimistic = mergeBinding(binding, this.get(binding.cli, binding.sessionId));
    this.pendingBindings.set(key, optimistic);
    try {
      await this.withLock(async () => {
        const loaded = await this.loadForWrite();
        const existing = loaded.find(
          (s) => s.cli === binding.cli && s.sessionId === binding.sessionId,
        );
        const next = mergeBinding(binding, existing);
        const sessions = loaded.filter(
          (s) => !(s.cli === binding.cli && s.sessionId === binding.sessionId),
        );
        sessions.push(next);
        await this.save(sessions);
      });
    } finally {
      if (this.pendingBindings.get(key) === optimistic) this.pendingBindings.delete(key);
    }
  }

  private load(): ExternalAgentSessionBinding[] {
    if (!existsSync(this.file)) return [];
    try {
      const raw = readFileSync(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ExternalAgentSessionSnapshot>;
      if (!parsed || !Array.isArray(parsed.sessions)) return [];
      return parsed.sessions.filter(isBinding).map(normalizeBinding);
    } catch (err) {
      logger.warn("external_agent_session_store.load_failed", {
        cat: "cc",
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async loadForWrite(): Promise<ExternalAgentSessionBinding[]> {
    try {
      const raw = await readFile(this.file, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ExternalAgentSessionSnapshot>;
      if (!parsed || !Array.isArray(parsed.sessions)) {
        throw new Error("external agent session store has an invalid root");
      }
      return parsed.sessions.filter(isBinding).map(normalizeBinding);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      logger.warn("external_agent_session_store.write_read_failed", {
        cat: "cc",
        file: this.file,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  private async save(sessions: ExternalAgentSessionBinding[]): Promise<void> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dir, 0o700);

    const snapshot: ExternalAgentSessionSnapshot = { version: 2, sessions };
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(snapshot, null, 2) + "\n", {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(tmp, this.file);
    } finally {
      await rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const dir = dirname(this.file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(dir, 0o700);

    const lockDir = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        await mkdir(lockDir);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        if (await removeStaleLock(lockDir)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for external agent session store lock: ${lockDir}`, {
            cause: err,
          });
        }
        await delay(LOCK_POLL_MS);
      }
    }

    try {
      return await fn();
    } finally {
      await rm(lockDir, { recursive: true, force: true });
    }
  }
}

function bindingKey(binding: Pick<ExternalAgentSessionRecord, "cli" | "sessionId">): string {
  return `${binding.cli}\0${binding.sessionId}`;
}

function mergeBinding(
  binding: ExternalAgentSessionRecord,
  existing?: ExternalAgentSessionBinding,
): ExternalAgentSessionBinding {
  const now = binding.lastUsedAt ?? binding.updatedAt ?? Date.now();
  return {
    cli: binding.cli,
    sessionId: binding.sessionId,
    ...((binding.codeShellSessionId ?? existing?.codeShellSessionId)
      ? { codeShellSessionId: binding.codeShellSessionId ?? existing?.codeShellSessionId }
      : {}),
    cwd: normalizeCwdPath(binding.cwd),
    ...((binding.workspaceRoot ?? existing?.workspaceRoot)
      ? { workspaceRoot: normalizeCwdPath(binding.workspaceRoot ?? existing!.workspaceRoot!) }
      : {}),
    ...((binding.worktreePath ?? existing?.worktreePath)
      ? { worktreePath: normalizeCwdPath(binding.worktreePath ?? existing!.worktreePath!) }
      : {}),
    ...((binding.worktreeBranch ?? existing?.worktreeBranch)
      ? { worktreeBranch: binding.worktreeBranch ?? existing?.worktreeBranch }
      : {}),
    ...((binding.worktreeBaseRef ?? existing?.worktreeBaseRef)
      ? { worktreeBaseRef: binding.worktreeBaseRef ?? existing?.worktreeBaseRef }
      : {}),
    ...((binding.isolation ?? existing?.isolation)
      ? { isolation: binding.isolation ?? existing?.isolation }
      : {}),
    createdAt: binding.createdAt ?? existing?.createdAt ?? now,
    lastUsedAt: now,
    updatedAt: now,
  };
}

function normalizeBinding(binding: ExternalAgentSessionBinding): ExternalAgentSessionBinding {
  const updatedAt = finiteTimestamp(binding.updatedAt) ?? Date.now();
  const lastUsedAt = finiteTimestamp(binding.lastUsedAt) ?? updatedAt;
  const createdAt = finiteTimestamp(binding.createdAt) ?? lastUsedAt;
  return {
    ...binding,
    cwd: normalizeCwdPath(binding.cwd),
    ...(binding.workspaceRoot ? { workspaceRoot: normalizeCwdPath(binding.workspaceRoot) } : {}),
    ...(binding.worktreePath ? { worktreePath: normalizeCwdPath(binding.worktreePath) } : {}),
    createdAt,
    lastUsedAt,
    updatedAt: lastUsedAt,
  };
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function removeStaleLock(lockDir: string): Promise<boolean> {
  try {
    if (Date.now() - (await stat(lockDir)).mtimeMs <= LOCK_STALE_MS) return false;
    await rm(lockDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isBinding(value: unknown): value is ExternalAgentSessionBinding {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<ExternalAgentSessionBinding>;
  return (
    (v.cli === "claude" || v.cli === "codex") &&
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.cwd === "string" &&
    v.cwd.length > 0
  );
}

export const externalAgentSessionStore = new ExternalAgentSessionStore();
