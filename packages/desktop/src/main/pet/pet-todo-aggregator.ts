/**
 * Cross-session open-todo view for the Mimi workbench. Structured sources
 * only (TodoWrite snapshots) — pending decisions stay in the work tree and
 * free-text mining is deliberately out of scope. Pull-based with an
 * mtime-keyed cache; no new push channel.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { readSessionTodos, type SessionTodoItem } from "@cjhyy/code-shell-pet/disclosure";

export interface PetSessionTodos {
  sessionId: string;
  title: string;
  workspace?: string;
  updatedAt: number;
  todos: SessionTodoItem[]; // only pending / in_progress
}

export interface PetTodoCandidate {
  agentSessionId: string;
  title?: string;
  workspaceDisplayName?: string;
  lastActivityAt: number;
}

export function createPetTodoAggregator(
  sessionsRootDir: string,
  listCandidates: () => PetTodoCandidate[],
  options?: {
    maxSessions?: number;
    maxEntries?: number;
    read?: (sessionDir: string) => Promise<SessionTodoItem[] | null>;
  },
): { collect(): Promise<PetSessionTodos[]> } {
  const read = options?.read ?? readSessionTodos;
  const maxSessions = options?.maxSessions ?? 50;
  const maxEntries = options?.maxEntries ?? 200;
  const cache = new Map<string, { mtimeMs: number; todos: SessionTodoItem[] | null }>();
  return {
    async collect() {
      const candidates = [...listCandidates()]
        .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
        .slice(0, maxSessions);
      const results: PetSessionTodos[] = [];
      for (const candidate of candidates) {
        const dir = join(sessionsRootDir, candidate.agentSessionId);
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(join(dir, "transcript.jsonl"))).mtimeMs;
        } catch {
          continue;
        }
        const cached = cache.get(candidate.agentSessionId);
        let todos: SessionTodoItem[] | null;
        if (cached && cached.mtimeMs === mtimeMs) {
          todos = cached.todos;
          cache.delete(candidate.agentSessionId);
          cache.set(candidate.agentSessionId, cached);
        } else {
          try {
            todos = await read(dir);
          } catch {
            continue; // transient failure: skip, do not cache
          }
          cache.delete(candidate.agentSessionId);
          cache.set(candidate.agentSessionId, { mtimeMs, todos });
          if (cache.size > maxEntries) {
            const oldest = cache.keys().next().value;
            if (oldest !== undefined) cache.delete(oldest);
          }
        }
        const open = (todos ?? []).filter((todo) => todo.status !== "completed");
        if (open.length === 0) continue;
        results.push({
          sessionId: candidate.agentSessionId,
          title: candidate.title ?? candidate.agentSessionId.slice(-8),
          ...(candidate.workspaceDisplayName ? { workspace: candidate.workspaceDisplayName } : {}),
          updatedAt: candidate.lastActivityAt,
          todos: open,
        });
      }
      return results;
    },
  };
}
