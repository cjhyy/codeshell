import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { TaskInboxRecordV1 } from "../../preload/task-inbox-api";
import type { PetOpenSessionRequest } from "../../preload/types";
import type { SessionIndex } from "../../shared/session-catalog";
import type { DiskSessionMeta } from "../automation/rebuildFromDisk";
import { useT } from "../i18n/I18nProvider";
import type { ViewState } from "../view";
import { openTaskInboxRecord } from "./taskInboxNavigation";

interface Params {
  settingsRevision: number;
  setView: Dispatch<SetStateAction<ViewState>>;
  sessionIndices: Record<string, SessionIndex>;
  selectSession(projectId: string | null, sessionId: string): void;
  openDiskSession(session: DiskSessionMeta): Promise<void>;
  openPetTarget(request: PetOpenSessionRequest): Promise<boolean>;
  petSnapshot: { version: number; generation: number } | null;
  openPetPage(): void;
  setRunsInitialRunId: Dispatch<SetStateAction<string | null>>;
}

/** Owns Task Center visibility and the transient destination selected by its cards. */
export function useTaskInboxFeature({
  settingsRevision,
  setView,
  sessionIndices,
  selectSession,
  openDiskSession,
  openPetTarget,
  petSnapshot,
  openPetPage,
  setRunsInitialRunId,
}: Params) {
  const { t } = useT();
  const [taskInboxEnabled, setTaskInboxEnabled] = useState(true);
  const [automationInitialId, setAutomationInitialId] = useState<string | null>(null);
  const [petInitialTaskId, setPetInitialTaskId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void window.codeshell
      .getSettings("user")
      .then((settings) => {
        if (!cancelled) {
          const flags = settings?.featureFlags as Record<string, boolean> | undefined;
          setTaskInboxEnabled(flags?.taskInboxV1 !== false);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [settingsRevision]);
  useEffect(() => {
    if (!taskInboxEnabled)
      setView((current) =>
        current.viewMode === "task_inbox" ? { ...current, viewMode: "chat" } : current,
      );
  }, [setView, taskInboxEnabled]);

  const onOpenTaskInboxRecord = async (record: TaskInboxRecordV1): Promise<void> => {
    const opened = await openTaskInboxRecord(record, {
      sessionIndices,
      selectSession,
      listDiskSessions: (options) => window.codeshell.listDiskSessions(options),
      openDiskSession,
      openMimiSession: (sessionId) =>
        openPetTarget({
          agentSessionId: sessionId,
          snapshotVersion: petSnapshot?.version ?? 0,
          generation: petSnapshot?.generation ?? 0,
        }),
      openExternalSession: (external) =>
        openPetTarget({
          agentSessionId: external.sessionId,
          snapshotVersion: petSnapshot?.version ?? 0,
          generation: petSnapshot?.generation ?? 0,
          external,
        }),
      openMimi: (taskId) => {
        setPetInitialTaskId(taskId);
        openPetPage();
      },
      openAutomation: (automationId) => {
        setAutomationInitialId(automationId);
        setView((current) => ({ ...current, viewMode: "automation" }));
      },
      openRun: (runId) => {
        setRunsInitialRunId(runId);
        setView((current) => ({ ...current, viewMode: "runs" }));
      },
    });
    if (!opened) throw new Error(t("taskInbox.openUnavailable"));
  };

  return { taskInboxEnabled, automationInitialId, petInitialTaskId, onOpenTaskInboxRecord };
}
