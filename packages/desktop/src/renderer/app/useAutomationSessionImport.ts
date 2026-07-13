import { useEffect } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { importAutomationRuns, type ImportableRun } from "../automation/importRuns";
import { isCaseInsensitivePlatform } from "../automation/pathMatch";
import { planDiskRebuild } from "../automation/rebuildFromDisk";
import {
  loadSessionIndex,
  NO_REPO_KEY,
  projectBucketSegment,
  saveTranscript,
  upsertImportedSession,
  type SessionIndex,
  type SessionSummary,
} from "../transcripts";
import {
  loadProjects,
  makeCreateProjectForCwd,
  type TrackedProject,
} from "../projects";
import { isQuickChatSessionId, type QuickChatSessionRef } from "../quickChatSession";

export interface AutomationSessionImportParams {
  activeProjectId: string | null;
  sessionIndices: Record<string, SessionIndex>;
  setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
  setProjects: Dispatch<SetStateAction<TrackedProject[]>>;
  diskProbedRef: MutableRefObject<Set<string>>;
  quickChatSessionsRef: MutableRefObject<Record<string, QuickChatSessionRef>>;
}

async function resolveProjectCwd(cwd: string): Promise<string> {
  if (!cwd) return cwd;
  try {
    return (await window.codeshell.projects.resolveRoot(cwd)).path;
  } catch {
    return cwd;
  }
}

/** Imports automation/disk sessions into the renderer's sidebar projection. */
export function useAutomationSessionImport({
  activeProjectId,
  sessionIndices,
  setSessionIndices,
  setProjects,
  diskProbedRef,
  quickChatSessionsRef,
}: AutomationSessionImportParams): void {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let runs: ImportableRun[];
      try {
        const raw = await window.codeshell.listRuns();
        runs = raw.map((run) => ({
          runId: run.runId,
          sessionId: run.sessionId,
          cwd: run.cwd,
          objective: run.objective,
          status: run.status,
          finishedAt: run.finishedAt,
          createdAt: run.createdAt,
          source: run.source,
          cronJobName: run.cronJobName,
        }));
      } catch {
        return;
      }
      if (cancelled || runs.length === 0) return;
      runs = await Promise.all(
        runs.map(async (run) => ({ ...run, cwd: await resolveProjectCwd(run.cwd) })),
      );
      if (cancelled) return;

      const terminalRun = new Set(["completed", "failed", "cancelled"]);
      const dedupable = (session: SessionSummary): boolean =>
        session.source !== "automation" ||
        !session.runStatus ||
        terminalRun.has(session.runStatus);
      const currentProjects = loadProjects();
      const known = new Set<string>();
      for (const project of currentProjects) {
        for (const session of loadSessionIndex(project.id).sessions) {
          if (session.engineSessionId && dedupable(session)) known.add(session.engineSessionId);
        }
      }
      for (const session of loadSessionIndex(null).sessions) {
        if (session.engineSessionId && dedupable(session)) known.add(session.engineSessionId);
      }

      const touchedProjectIds = new Set<string | null>();
      const projectFactory = makeCreateProjectForCwd(currentProjects);
      await importAutomationRuns(runs, currentProjects, {
        caseInsensitive: isCaseInsensitivePlatform(),
        existingEngineSessionIds: known,
        cap: 50,
        fetchTranscript: (sessionId) => window.codeshell.getSessionTranscript(sessionId),
        createProjectForCwd: projectFactory.createProjectForCwd,
        writeImported: (projectId, summary, state) => {
          saveTranscript(projectId, summary.id, state);
          upsertImportedSession(projectId, summary);
          touchedProjectIds.add(projectId);
        },
      });
      if (cancelled) return;

      if (projectFactory.changed()) setProjects(currentProjects.slice());
      if (touchedProjectIds.size > 0) {
        setSessionIndices((prev) => {
          const next = { ...prev };
          for (const projectId of touchedProjectIds) {
            next[projectBucketSegment(projectId)] = loadSessionIndex(projectId);
          }
          return next;
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setProjects, setSessionIndices]);

  useEffect(() => {
    const segment = projectBucketSegment(activeProjectId);
    const index = sessionIndices[segment];
    if (index && index.sessions.length > 0) return;
    if (diskProbedRef.current.has(segment)) return;
    diskProbedRef.current.add(segment);
    let cancelled = false;
    let probed = false;

    void (async () => {
      try {
        const page = await window.codeshell.listDiskSessions({ limit: 30 });
        probed = true;
        if (cancelled || page.sessions.length === 0) return;
        const resolvedSessions = await Promise.all(
          page.sessions.map(async (session) => ({
            ...session,
            cwd: await resolveProjectCwd(session.cwd),
          })),
        );
        for (const session of resolvedSessions) {
          const sessionId = session.engineSessionId || session.id;
          if (!isQuickChatSessionId(sessionId)) continue;
          const isLive = Object.values(quickChatSessionsRef.current).some(
            (quickSession) => quickSession.sessionId === sessionId,
          );
          if (!isLive) {
            void window.codeshell.cleanupQuickChatSession(sessionId, "stale-disk").catch((error) =>
              window.codeshell.log("quick_chat.cleanup_stale_session_failed", {
                sessionId,
                error: String(error),
              }),
            );
          }
        }
        const sessions = resolvedSessions.filter(
          (session) => !isQuickChatSessionId(session.engineSessionId || session.id),
        );
        if (cancelled) return;
        const projectsNow = loadProjects();
        const projectFactory = makeCreateProjectForCwd(projectsNow);
        const placements = planDiskRebuild(sessions, projectsNow, {
          caseInsensitive: isCaseInsensitivePlatform(),
          createProjectForCwd: projectFactory.createProjectForCwd,
        });
        if (cancelled) return;
        const touched = new Set<string>();
        for (const { projectId, summary } of placements) {
          upsertImportedSession(projectId, summary);
          touched.add(projectBucketSegment(projectId));
        }
        if (projectFactory.changed()) setProjects(projectsNow.slice());
        setSessionIndices((prev) => {
          const next = { ...prev };
          for (const key of touched) {
            next[key] = loadSessionIndex(key === NO_REPO_KEY ? null : key);
          }
          return next;
        });
      } catch {
        diskProbedRef.current.delete(segment);
      }
    })();
    return () => {
      cancelled = true;
      if (!probed) diskProbedRef.current.delete(segment);
    };
  }, [
    activeProjectId,
    sessionIndices,
    diskProbedRef,
    quickChatSessionsRef,
    setProjects,
    setSessionIndices,
  ]);
}

export { resolveProjectCwd };
