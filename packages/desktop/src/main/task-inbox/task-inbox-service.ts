import { createTaskInboxStore } from "./task-inbox-store.js";
import { createTaskInboxProjector, type TaskInboxSourceReader } from "./task-inbox-projector.js";
import { createTaskInboxActions, type TaskInboxActionAdapter } from "./task-inbox-actions.js";
import type { TaskInboxActionRequest, TaskInboxListQuery } from "./task-inbox-types.js";

/** The host owns scheduling and subscriptions; projection failures never stop real work. */
export function createTaskInboxService(options: {
  filePath: string;
  readers: TaskInboxSourceReader[];
  adapters: TaskInboxActionAdapter[];
  enabled?: () => boolean;
  onError?: (error: unknown) => void;
}) {
  const store = createTaskInboxStore({ filePath: options.filePath });
  const projector = createTaskInboxProjector({
    store,
    readers: options.readers,
    onError: (_source, error) => options.onError?.(error),
  });
  const actions = createTaskInboxActions({
    projector,
    adapters: options.adapters,
    onProjectionError: options.onError,
  });
  let closed = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  const enabled = () => !closed && (options.enabled?.() ?? true);
  const reconcile = () =>
    enabled() ? projector.reconcile() : Promise.resolve(projector.snapshot());
  const refresh = () => {
    void reconcile().catch((error) => options.onError?.(error));
  };
  return {
    list: (query?: TaskInboxListQuery) => projector.list(query),
    get: (taskKey: string) => projector.get(taskKey),
    snapshot: () => projector.snapshot(),
    subscribe: (listener: Parameters<typeof projector.subscribe>[0]) =>
      projector.subscribe(listener),
    reconcile,
    act: async (request: TaskInboxActionRequest, context: { webContentsId: number }) => {
      if (!enabled()) return { status: "unavailable" as const, message: "Task inbox is disabled" };
      return actions.act(request, context);
    },
    scheduleRefresh: () => {
      if (!enabled() || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        refresh();
      }, 250);
      refreshTimer.unref?.();
    },
    start: () => {
      if (sweepTimer || closed) return;
      refresh();
      sweepTimer = setInterval(refresh, 15_000);
      sweepTimer.unref?.();
    },
    dispose: () => {
      closed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      refreshTimer = undefined;
      sweepTimer = undefined;
      projector.dispose();
    },
  };
}
