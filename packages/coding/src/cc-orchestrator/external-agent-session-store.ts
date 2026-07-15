import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  constructor(private readonly file = defaultExternalAgentSessionStorePath()) {}

  get(cli: ExternalAgentCli, sessionId: string): ExternalAgentSessionBinding | undefined {
    if (!sessionId) return undefined;
    return this.load().find((s) => s.cli === cli && s.sessionId === sessionId);
  }

  record(binding: ExternalAgentSessionRecord): void {
    if (!binding.sessionId || !binding.cwd) return;
    this.withLock(() => {
      const loaded = this.load();
      const existing = loaded.find(
        (s) => s.cli === binding.cli && s.sessionId === binding.sessionId,
      );
      const now = binding.lastUsedAt ?? binding.updatedAt ?? Date.now();
      const next: ExternalAgentSessionBinding = {
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
      const sessions = loaded.filter(
        (s) => !(s.cli === binding.cli && s.sessionId === binding.sessionId),
      );
      sessions.push(next);
      this.save(sessions);
    });
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

  private save(sessions: ExternalAgentSessionBinding[]): void {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const snapshot: ExternalAgentSessionSnapshot = { version: 2, sessions };
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");
      renameSync(tmp, this.file);
    } catch (err) {
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  private withLock<T>(fn: () => T): T {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // TODO: move this sync polling lock to an async write queue; callers can
    // otherwise block the event loop for up to LOCK_WAIT_MS under contention.
    const lockDir = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    while (true) {
      try {
        mkdirSync(lockDir);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw err;
        if (removeStaleLock(lockDir)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for external agent session store lock: ${lockDir}`, {
            cause: err,
          });
        }
        sleepSync(LOCK_POLL_MS);
      }
    }

    try {
      return fn();
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
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

function removeStaleLock(lockDir: string): boolean {
  try {
    if (Date.now() - statSync(lockDir).mtimeMs <= LOCK_STALE_MS) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }
}

function sleepSync(ms: number): void {
  try {
    const view = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(view, 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      // fallback for runtimes where Atomics.wait is unavailable
    }
  }
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
