import {
  createTaskInboxActions,
  type TaskInboxActionAdapter,
  type TaskExecutorContext,
} from "./task-inbox-actions.js";
import type { TaskInboxSourceReader } from "./task-inbox-projector.js";
import { listTaskInboxSnapshot } from "./task-inbox-store.js";
import { hotTask } from "./task-projection-rows.js";
import type { ProjectionBatch, TaskChangeIntent } from "./task-projection.js";
import {
  parseTaskInboxIntent,
  type TaskInboxActionRequest,
  type TaskInboxIntent,
  type TaskInboxIntentResult,
  type TaskInboxListQuery,
  type TaskInboxRecordV1,
  type TaskInboxSnapshot,
  type TaskInboxVisibility,
  type TaskSource,
} from "./task-inbox-types.js";

export type TaskInboxStorageCommand = <T>(command: string, payload?: unknown) => Promise<T | null>;
export interface HostedTaskInboxOptions {
  command: TaskInboxStorageCommand;
  readers: TaskInboxSourceReader[];
  adapters: TaskInboxActionAdapter[];
  enabled?: () => boolean;
  onError?: (error: unknown) => void;
}
interface Change {
  version: number;
  changed: boolean;
  count?: number;
}

/** Main supplies live executor observations. The writer owns records, intents,
 * versioning and mirrors; this cache serves the existing synchronous listeners. */
export function createHostedTaskInboxService(options: HostedTaskInboxOptions) {
  let current: TaskInboxSnapshot = { version: 0, errors: [], records: [] };
  const readers = new Map(options.readers.map((r) => [r.source, r]));
  const listeners = new Set<(snapshot: TaskInboxSnapshot) => void>();
  const dirty = new Map<TaskSource, Set<string> | null>();
  let ready = false,
    closed = false;
  let tail: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hotTimer: ReturnType<typeof setInterval> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const enabled = () => !closed && (options.enabled?.() ?? true);
  function snapshot(visibility: TaskInboxVisibility = "visible") {
    const records = current.records.filter(
      (r) => visibility === "all" || Boolean(r.hidden) === (visibility === "hidden"),
    );
    return structuredClone({ ...current, records });
  }
  function queue<T>(fn: () => Promise<T>): Promise<T> {
    const work = tail.then(fn);
    tail = work.catch(() => {});
    return work;
  }
  async function issue<T>(name: string, payload?: unknown): Promise<T> {
    const reply = await options.command<T>(name, payload);
    if (reply === null) {
      ready = false;
      throw new Error("Task Host is reconnecting");
    }
    return reply;
  }
  async function publish(version?: number) {
    if (ready && current.version === version) return;
    current = await issue<TaskInboxSnapshot>("tasks/snapshot", { visibility: "all" });
    ready = true;
    for (const listener of listeners) {
      try {
        listener(snapshot());
      } catch {
        /* A closed window cannot block another subscriber. */
      }
    }
  }
  async function ingest(batches: ProjectionBatch[]) {
    const change = await issue<Change>("tasks/reconcile", { sources: batches });
    await publish(change.version);
  }
  async function refresh() {
    if (!enabled()) return;
    const pending = ready ? new Map(dirty) : new Map([...readers.keys()].map((s) => [s, null]));
    dirty.clear();
    if (!pending.size) return;
    const knownKeys = new Map<TaskSource, Map<string, string[]>>();
    for (const record of current.records) {
      const ids = pending.get(record.source);
      if (!ids?.has(record.sourceId)) continue;
      let group = knownKeys.get(record.source);
      if (!group) knownKeys.set(record.source, (group = new Map()));
      let keys = group.get(record.sourceId);
      if (!keys) group.set(record.sourceId, (keys = []));
      keys.push(record.taskKey);
    }
    try {
      const perSource = await Promise.all(
        [...pending].map(async ([source, ids]) => {
          const reader = readers.get(source);
          if (!reader) return [];
          if (!ids || !reader.readOne) {
            try {
              return [{ source, records: await reader.read(), complete: true }];
            } catch (error) {
              return [{ source, error: sourceError(error), complete: true }];
            }
          }
          const changes: ProjectionBatch[] = [];
          const keys = [...ids];
          for (let from = 0; from < keys.length; from += 32) {
            const chunk = await Promise.all(
              keys.slice(from, from + 32).map(async (id) => {
                const old = knownKeys.get(source)?.get(id) ?? [];
                try {
                  const records = await reader.readOne!(id);
                  if (records.some((r) => r.source !== source || r.sourceId !== id))
                    throw new Error("Unexpected task key");
                  return { source, records, removedKeys: old };
                } catch (error) {
                  return { source, error: sourceError(error), removedKeys: old };
                }
              }),
            );
            changes.push(...chunk);
          }
          return changes;
        }),
      );
      await ingest(perSource.flat());
    } catch (error) {
      // Replay observations on the next connection; control commands are never replayed.
      for (const [source, ids] of pending) {
        if (!ids) dirty.set(source, null);
        else for (const id of ids) remember(source, id);
      }
      throw error;
    }
  }
  function remember(source: TaskSource, id: string) {
    if (!readers.has(source) || dirty.get(source) === null) return;
    let ids = dirty.get(source);
    if (!ids) dirty.set(source, (ids = new Set()));
    ids.add(id);
  }
  const quiet = (job: Promise<unknown>) => {
    void job.catch((e) => options.onError?.(e));
  };
  const schedule = () => {
    if (!enabled() || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      quiet(queue(refresh));
    }, 1_000);
    timer.unref?.();
  };
  function markDirty(source: TaskSource, id: string) {
    if (enabled()) {
      remember(source, id);
      schedule();
    }
  }
  function markHot() {
    for (const r of current.records) if (hotTask(r)) remember(r.source, r.sourceId);
    schedule();
  }
  const actions = createTaskInboxActions({
    adapters: options.adapters,
    onProjectionError: options.onError,
    projector: {
      get: async (key) =>
        (await options.command<TaskInboxRecordV1>("tasks/get", { taskKey: key })) ?? undefined,
      ingest: (r) => queue(() => ingest([{ source: r.source, records: [r] }])),
    },
  });
  async function updateIntent(intent: TaskChangeIntent, assertCurrent?: () => void) {
    if (!enabled()) throw new Error("Task inbox is unavailable");
    assertCurrent?.();
    const result = await issue<Change>("tasks/intent", intent);
    await publish(result.version);
    return result;
  }
  return {
    list: (query: TaskInboxListQuery = {}) => listTaskInboxSnapshot(current, query),
    get: (key: string) => {
      const r = current.records.find((r) => r.taskKey === key);
      return r && structuredClone(r);
    },
    snapshot,
    subscribe(listener: (snapshot: TaskInboxSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reconcile: (visibility: TaskInboxVisibility = "visible") =>
      queue(async () => {
        await refresh();
        return snapshot(visibility);
      }),
    markDirty,
    hostRestarted() {
      ready = false;
      schedule();
    },
    scheduleRefresh(source?: TaskSource) {
      if (!enabled()) return;
      if (source) {
        dirty.set(source, null);
        schedule();
      } else markHot();
    },
    applyIntent: (
      input: TaskInboxIntent,
      assertCurrent?: () => void,
    ): Promise<TaskInboxIntentResult> =>
      queue(async () => {
        if (!enabled()) return { status: "unavailable" };
        try {
          const result = await updateIntent(parseTaskInboxIntent(input), assertCurrent);
          return { status: "ok", count: result.count };
        } catch (error) {
          if (error instanceof Error && error.message === "Task changed; refresh before acting")
            return { status: "stale", message: error.message };
          if (
            error instanceof Error &&
            error.message === "Task must be ended or interrupted before deletion"
          )
            return { status: "rejected", message: error.message };
          throw error;
        }
      }),
    sessionIntent: (intent: Extract<TaskChangeIntent, { sessionId: string }>) =>
      queue(() => updateIntent(intent)),
    act: (request: TaskInboxActionRequest, ctx: TaskExecutorContext) =>
      enabled() ? actions.act(request, ctx) : Promise.resolve({ status: "unavailable" as const }),
    start() {
      if (hotTimer || closed) return;
      quiet(queue(refresh));
      hotTimer = setInterval(markHot, 60_000);
      hotTimer.unref?.();
      sweepTimer = setInterval(() => {
        for (const source of readers.keys()) dirty.set(source, null);
        schedule();
      }, 600_000);
      sweepTimer.unref?.();
    },
    dispose() {
      closed = true;
      if (timer) clearTimeout(timer);
      if (hotTimer) clearInterval(hotTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      listeners.clear();
      dirty.clear();
    },
  };
}
function sourceError(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 2048) || "Source unavailable"
    : "Source unavailable";
}
