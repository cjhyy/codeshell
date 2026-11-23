import { app, ipcMain, type BrowserWindow } from "electron";
import { resolve } from "node:path";
import {
  observeBackgroundWorkChange,
  type BackgroundWorkChange,
} from "@cjhyy/code-shell-core/internal";
import type { AgentBridge } from "../agent-bridge.js";
import type { AppRendererNavigation } from "../app-renderer-navigation.js";
import type { createDesktopHost } from "../desktop-host/main.js";
import type { hostCatalogClient } from "../desktop-host/catalog-client.js";
import type { createExternalRuntimeModule } from "../external-runtime-module.js";
import type { TaskInboxSourcesDeps } from "../task-inbox/task-inbox-sources.js";
import { readExternalRuntimeBinding } from "../external-runtime-state.js";
import { taskInboxEnabled } from "../task-inbox/task-host-reads.js";
import { dlog } from "../desktop-logger.js";
import {
  backgroundTaskSourceId,
  createTaskInboxSources,
} from "../task-inbox/task-inbox-sources.js";
import { createTaskInboxService } from "../task-inbox/task-inbox-service.js";
import { createTaskInboxBackgroundHost } from "../task-inbox/task-inbox-background-host.js";
import { registerTaskInboxIpc } from "../task-inbox/task-inbox-ipc.js";

/** Connect live native executors and the document-scoped UI to the durable Host projection. */
export function createDesktopTaskInbox({
  desktopHost,
  mainWindows,
  externalRuntime,
  worker,
  sessionProjection,
  sessionCatalogStore,
  taskInboxAutomationSessions,
  taskInboxDisposers,
  appRendererNavigation,
}: {
  desktopHost: Pick<
    ReturnType<typeof createDesktopHost>,
    | "callBusiness"
    | "taskCommand"
    | "mimiTasks"
    | "listDiskSessions"
    | "automation"
    | "withDocumentCaller"
  >;
  mainWindows: Set<BrowserWindow>;
  externalRuntime: ReturnType<typeof createExternalRuntimeModule>;
  worker(): AgentBridge | null;
  sessionProjection: NonNullable<TaskInboxSourcesDeps["sessionProjection"]>;
  sessionCatalogStore: Pick<ReturnType<typeof hostCatalogClient>, "load" | "onChanged">;
  taskInboxAutomationSessions: Map<string, string>;
  taskInboxDisposers: Array<() => void>;
  appRendererNavigation: Pick<AppRendererNavigation, "assertSender">;
}) {
  const { listDiskSessions, automation: cron } = desktopHost;
  async function listAllDiskSessions(
    opts: { includeSubagents?: boolean } = {},
  ): Promise<Awaited<ReturnType<typeof listDiskSessions>>["sessions"]> {
    const pageSize = 500;
    const maxPages = 200;
    const all: Awaited<ReturnType<typeof listDiskSessions>>["sessions"] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const result = await listDiskSessions({
        limit: pageSize,
        includeArchived: true,
        ...(opts.includeSubagents ? { includeSubagents: true } : {}),
        ...(cursor ? { cursor } : {}),
      });
      all.push(...result.sessions);
      if (!result.nextCursor) return all;
      cursor = result.nextCursor;
    }
    dlog("main", "listAllDiskSessions.page_limit", { maxPages, scanned: all.length });
    return all;
  }

  function markSessionTaskDirty(id: string) {
    taskInboxService.markDirty("session", id);
    taskInboxService.markDirty("external-runtime", id);
    taskInboxService.markDirty("subagent", id);
  }
  function userContinuedTask(id: string) {
    void taskInboxService
      .sessionIntent({ type: "userContinued", sessionId: id })
      .then(() => markSessionTaskDirty(id))
      .catch((error) => dlog("main", "task-inbox.user-continue", { error: String(error) }));
  }
  async function archiveDiskSession(id: string, archivedAt: number | undefined) {
    await desktopHost.callBusiness("sessions/archive", { sessionId: id, archivedAt });
    await taskInboxService.sessionIntent({
      type: archivedAt === undefined ? "sessionUnarchived" : "sessionArchived",
      sessionId: id,
    });
    markSessionTaskDirty(id);
  }

  const taskInboxSources = createTaskInboxSources({
    diskSessions: () => listAllDiskSessions({ includeSubagents: true }),
    diskSession: async (id) =>
      (
        await listDiskSessions({
          limit: 1,
          sessionId: id,
          includeArchived: true,
          includeSubagents: true,
        })
      ).sessions[0],
    sessionCatalog: () => sessionCatalogStore.load(),
    sessionProjection: sessionProjection,
    native: {
      hasLiveWorker: () => !!worker()?.hasLiveWorker() || taskInboxAutomationSessions.size > 0,
      isSessionRunning: (id) =>
        taskInboxAutomationSessions.has(id) || !!worker()?.isSessionRunning(id),
      cancel: async (id) => {
        const jobId = taskInboxAutomationSessions.get(id);
        if (jobId) return cron.call("cancel", jobId);
        const bridge = worker();
        if (!bridge?.hasLiveWorker() || !bridge.isSessionRunning(id)) return false;
        const result = await bridge.requestWorker("agent/cancel", { sessionId: id }, 15_000, {
          failFast: true,
          settleOnExit: true,
          meta: { origin: "host", producer: "task-inbox" },
        });
        if (!result.ok) throw new Error(result.message);
        return true;
      },
    },
    runs: { list: () => desktopHost.callBusiness("activity/runs", { includeSessions: false }) },
    automations: {
      list: () => cron.call("list", undefined),
      get: (id) => cron.call("get", id),
      pause: (id) => cron.call("pause", id),
      resume: (id) => cron.call("resume", id),
      runNow: (id) => cron.call("runNow", id),
    },
    mimi: {
      snapshot: () => desktopHost.mimiTasks.getSnapshot(),
      get: (id) => desktopHost.mimiTasks.get(id),
      control: (request) => desktopHost.mimiTasks.control(request),
    },
    external: {
      hasSession: (id) => !!externalRuntime.service?.hasSession(id),
      isSessionRunning: (id) => !!externalRuntime.service?.isSessionRunning(id),
      hasPending: (id) => !!externalRuntime.approvals?.hasPendingSession(id),
      kind: (id) => readExternalRuntimeBinding(id)?.kind,
      interrupt: async (id) => {
        if (!externalRuntime.service?.hasSession(id))
          throw new Error("External runtime is unavailable");
        await externalRuntime.service.interrupt(id);
      },
    },
    background: createTaskInboxBackgroundHost({ worker }),
  });
  const taskInboxService = createTaskInboxService({
    filePath: resolve(app.getPath("userData"), "task-inbox", "v1.json"),
    ...taskInboxSources,
    command: desktopHost.taskCommand,
    enabled: taskInboxEnabled,
    onError: (error) => dlog("main", "task-inbox.projection.failed", { error: String(error) }),
  });
  taskInboxDisposers.push(
    registerTaskInboxIpc(
      ipcMain,
      () => [...mainWindows],
      taskInboxService,
      taskInboxEnabled,
      (event) => appRendererNavigation.assertSender(event),
      desktopHost.withDocumentCaller,
    ),
    sessionCatalogStore.onChanged(() => taskInboxService.scheduleRefresh("session")),
  );

  function observeWorkerTasks(bridge: AgentBridge) {
    const markBackgroundChanged = (origin: "main" | "worker", e: BackgroundWorkChange) => {
      taskInboxService.markDirty(
        e.kind === "shell" ? "background-shell" : "background-job",
        backgroundTaskSourceId(origin, e.sessionId, e.startedAt, e.workId),
      );
    };
    bridge.onWorkerBackgroundWorkChanged = (change) => markBackgroundChanged("worker", change);
    taskInboxDisposers.push(
      observeBackgroundWorkChange((change) => markBackgroundChanged("main", change)),
    );
    taskInboxDisposers.push(
      bridge.subscribeOutbound((_line, entry) => {
        const event = entry?.event as { type?: string } | undefined;
        if (
          event?.type &&
          [
            "session_started",
            "run_result",
            "approval_request",
            "approval_resolved",
            "ask_user",
            "agent_started",
            "agent_completed",
            "background_task_started",
            "background_task_completed",
          ].includes(event.type)
        ) {
          if (entry) markSessionTaskDirty(entry.sessionId);
          if (event.type.startsWith("background_task_")) {
            taskInboxService.scheduleRefresh("background-shell");
            taskInboxService.scheduleRefresh("background-job");
          }
        }
      }),
    );
  }
  return {
    taskInboxService,
    listAllDiskSessions,
    archiveDiskSession,
    markSessionTaskDirty,
    userContinuedTask,
    observeWorkerTasks,
  };
}
