import type { InstalledPanelApp } from "@cjhyy/code-shell-core";
import type {
  PanelToolJobService,
  ToolJob,
  ToolJobEvent,
  ToolJobRequest,
  ToolJobScope,
  ToolQueueState,
  ToolQueueUpdate,
  ToolQueueWriteResult,
} from "./tool-jobs.js";

/** Host composition only: no paths, scopes, or execution revisions come from HTTP callers. */
export interface SharedPanelToolBinding {
  readonly scope: Readonly<ToolJobScope>;
  start(request: ToolJobRequest, signal?: AbortSignal): Promise<ToolJob>;
  list(): Promise<Array<ToolJob & { readOnly: boolean }>>;
  has(id: string): Promise<boolean>;
  get(id: string): Promise<ToolJob & { readOnly: boolean }>;
  cancel(id: string): Promise<ToolJob>;
  retry(id: string): Promise<ToolJob>;
  getQueue(): Promise<ToolQueueState>;
  setQueue(update: ToolQueueUpdate): Promise<ToolQueueWriteResult>;
  subscribe(listener: (job: ToolJobEvent) => void): () => void;
}
export interface SharedPanelToolHost {
  /** Freeze the installed execution revision once; do not silently follow package updates. */
  bind(app: InstalledPanelApp, projectPath: string): Promise<SharedPanelToolBinding>;
  activeCount(projectPath: string): number;
  invalidate(projectPath: string, appId?: string): Promise<void>;
}

/** Adapts the single owning coordinator without giving a transport shutdown authority. */
export function createSharedPanelToolHost(options: {
  service(): PanelToolJobService;
  resolveScope(app: InstalledPanelApp, projectPath: string): Promise<ToolJobScope>;
}): SharedPanelToolHost {
  return {
    async bind(app, projectPath) {
      const scope = Object.freeze({ ...(await options.resolveScope(app, projectPath)) });
      const service = options.service();
      return Object.freeze({
        scope,
        start: (request: ToolJobRequest, signal?: AbortSignal) =>
          service.start(scope, request, signal),
        list: () => service.list(scope),
        has: (id: string) => service.has(scope, id),
        get: (id: string) => service.get(scope, id),
        cancel: (id: string) => service.cancel(scope, id),
        retry: (id: string) => service.retry(scope, id),
        getQueue: () => service.getQueue(scope),
        setQueue: (update: ToolQueueUpdate) => service.setQueue(scope, update),
        subscribe: (listener: (job: ToolJobEvent) => void) => service.subscribe(scope, listener),
      });
    },
    activeCount: (projectPath) => options.service().activeCount(projectPath),
    invalidate: (projectPath, appId) => options.service().cancelProject(projectPath, appId),
  };
}
