import { useCallback, useEffect, useRef, useState } from "react";
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
import { loadProjects, makeCreateProjectForCwd, type TrackedProject } from "../projects";
export interface AutomationSessionImportParams {
  sessionIndicesRef: MutableRefObject<Record<string, SessionIndex>>;
  setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
  setProjects: Dispatch<SetStateAction<TrackedProject[]>>;
}

export interface DiskSessionCatalogState {
  initialized: boolean;
  loading: boolean;
  nextCursor: string | null;
}

export interface AutomationSessionImportResult {
  diskSessionCatalog: DiskSessionCatalogState;
  loadDiskSessionCatalogPage: (cursor?: string) => Promise<void>;
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
  sessionIndicesRef,
  setSessionIndices,
  setProjects,
}: AutomationSessionImportParams): AutomationSessionImportResult {
  const [diskSessionCatalog, setDiskSessionCatalog] = useState<DiskSessionCatalogState>({
    initialized: false,
    loading: false,
    nextCursor: null,
  });
  const diskSessionCatalogLoadingRef = useRef(false);

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
        session.source !== "automation" || !session.runStatus || terminalRun.has(session.runStatus);
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

  const loadDiskSessionCatalogPage = useCallback(
    async (cursor?: string): Promise<void> => {
      if (diskSessionCatalogLoadingRef.current) return;
      diskSessionCatalogLoadingRef.current = true;
      setDiskSessionCatalog((current) => ({ ...current, loading: true }));
      try {
        const page = await window.codeshell.listDiskSessions({
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        const knownIds = new Set<string>();
        for (const index of Object.values(sessionIndicesRef.current)) {
          for (const session of index.sessions) {
            knownIds.add(session.id);
            if (session.engineSessionId) knownIds.add(session.engineSessionId);
          }
        }
        const missing = page.sessions.filter(
          (session) =>
            !knownIds.has(session.id) && !knownIds.has(session.engineSessionId || session.id),
        );
        const resolvedCwds = new Map<string, Promise<string>>();
        const resolveOnce = (cwd: string): Promise<string> => {
          const existing = resolvedCwds.get(cwd);
          if (existing) return existing;
          const resolving = resolveProjectCwd(cwd);
          resolvedCwds.set(cwd, resolving);
          return resolving;
        };
        const resolvedSessions = await Promise.all(
          missing.map(async (session) => ({ ...session, cwd: await resolveOnce(session.cwd) })),
        );
        const projectsNow = loadProjects();
        const projectFactory = makeCreateProjectForCwd(projectsNow);
        const placements = planDiskRebuild(resolvedSessions, projectsNow, {
          caseInsensitive: isCaseInsensitivePlatform(),
          createProjectForCwd: projectFactory.createProjectForCwd,
        });
        const touched = new Set<string>();
        for (const { projectId, summary } of placements) {
          // Automation hydration may finish while this page is resolving roots.
          // Re-check the durable index so richer metadata and archived rows win.
          const current = loadSessionIndex(projectId);
          const alreadyKnown = current.sessions.some(
            (session) =>
              session.id === summary.id ||
              (summary.engineSessionId && session.engineSessionId === summary.engineSessionId),
          );
          if (alreadyKnown) continue;
          upsertImportedSession(projectId, summary);
          touched.add(projectBucketSegment(projectId));
        }
        if (projectFactory.changed()) setProjects(projectsNow.slice());
        if (touched.size > 0) {
          setSessionIndices((previous) => {
            const next = { ...previous };
            for (const key of touched) {
              next[key] = loadSessionIndex(key === NO_REPO_KEY ? null : key);
            }
            return next;
          });
        }
        setDiskSessionCatalog({
          initialized: true,
          loading: false,
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        // Preserve the failed cursor so the sidebar action becomes a retry.
        setDiskSessionCatalog({
          initialized: true,
          loading: false,
          nextCursor: cursor ?? "",
        });
        window.codeshell.log("sidebar.disk_catalog_page_failed", { error: String(error) });
      } finally {
        diskSessionCatalogLoadingRef.current = false;
      }
    },
    [sessionIndicesRef, setProjects, setSessionIndices],
  );

  useEffect(() => {
    void loadDiskSessionCatalogPage();
  }, [loadDiskSessionCatalogPage]);

  return { diskSessionCatalog, loadDiskSessionCatalogPage };
}

export { resolveProjectCwd };
