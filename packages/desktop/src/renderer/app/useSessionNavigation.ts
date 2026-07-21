import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import { importAutomationRuns } from "../automation/importRuns";
import { foldTranscript } from "../automation/foldTranscript";
import { isCaseInsensitivePlatform } from "../automation/pathMatch";
import { planDiskRebuild, type DiskSessionMeta } from "../automation/rebuildFromDisk";
import { emptyPanelBucketState, type PanelBucketState } from "./appUtils";
import {
  archiveAllSessions,
  archiveSession,
  bucketKey,
  clearBucketOverride,
  clearPanelState,
  deleteSessionLocal,
  loadSessionIndex,
  projectBucketSegment,
  renameSessionLocal,
  saveTranscript,
  setActiveSession,
  setSessionPinnedLocal,
  upsertImportedSession,
  type SessionIndex,
  type SessionSummary,
} from "../transcripts";
import {
  loadProjects,
  makeCreateProjectForCwd,
  makeProjectId,
  markProjectPathRemoved,
  projectLabel,
  unmarkProjectPathRemoved,
  type TrackedProject,
} from "../projects";
import { planSessionDeletion } from "../sessionDeletionPlan";
import {
  releaseWorkspaceForArchive,
  releaseWorkspacesForArchiveMany,
} from "../workspaceArchiveRelease";
import type { PermissionMode } from "../chat/PermissionPill";
import type { MessagesReducerState } from "../types";
import type { RunSummary } from "../../preload/types";
import type { ViewState } from "../view";
import { revealSidebarProject } from "../sidebarSessionVisibility";

interface Params {
  projects: TrackedProject[];
  setProjects: Dispatch<SetStateAction<TrackedProject[]>>;
  activeProjectId: string | null;
  setActiveProjectId: Dispatch<SetStateAction<string | null>>;
  sessionIndices: Record<string, SessionIndex>;
  setSessionIndices: Dispatch<SetStateAction<Record<string, SessionIndex>>>;
  setCollapsedProjects: Dispatch<SetStateAction<Set<string>>>;
  setUnreadBuckets: Dispatch<SetStateAction<Set<string>>>;
  setPermissionOverrides: Dispatch<SetStateAction<Record<string, PermissionMode>>>;
  setModelOverrides: Dispatch<SetStateAction<Record<string, string>>>;
  setGoalOverrides: Dispatch<SetStateAction<Record<string, boolean>>>;
  panelByBucket: Record<string, PanelBucketState>;
  setPanelByBucket: Dispatch<SetStateAction<Record<string, PanelBucketState>>>;
  activeBucketRef: MutableRefObject<string>;
  setView: Dispatch<SetStateAction<ViewState>>;
  setRunsInitialRunId: Dispatch<SetStateAction<string | null>>;
}

export function useSessionNavigation({
  projects,
  setProjects,
  activeProjectId,
  setActiveProjectId,
  sessionIndices,
  setSessionIndices,
  setCollapsedProjects,
  setUnreadBuckets,
  setPermissionOverrides,
  setModelOverrides,
  setGoalOverrides,
  setPanelByBucket,
  activeBucketRef,
  setView,
  setRunsInitialRunId,
}: Params) {
  const selectSession = (projectId: string | null, sessionId: string): void => {
    const selectedBucket = bucketKey(projectId, sessionId);
    setUnreadBuckets((prev) => {
      if (!prev.has(selectedBucket)) return prev;
      const next = new Set(prev);
      next.delete(selectedBucket);
      return next;
    });
    setActiveProjectId(projectId);
    setCollapsedProjects((current) => revealSidebarProject(current, projectId));
    const nextIndex = setActiveSession(projectId, sessionId);
    const nextBucket = nextIndex.activeSessionId ? selectedBucket : bucketKey(projectId, null);
    activeBucketRef.current = nextBucket;
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegment(projectId)]: nextIndex,
    }));
    window.codeshell.log("session.select", {
      repoId: projectId,
      requestedSessionId: sessionId,
      activeSessionId: nextIndex.activeSessionId,
      bucket: nextBucket,
    });
    setView((view) => ({ ...view, viewMode: "chat" }));
  };

  const findSessionByEngineId = (
    engineSessionId: string,
  ): { projectId: string | null; session: SessionSummary } | null => {
    const projectsNow = loadProjects();
    for (const projectId of [null, ...projectsNow.map((project) => project.id)]) {
      const session = loadSessionIndex(projectId).sessions.find(
        (candidate) =>
          candidate.engineSessionId === engineSessionId || candidate.id === engineSessionId,
      );
      if (session) return { projectId, session };
    }
    return null;
  };

  const addProject = async (): Promise<void> => {
    window.codeshell.log("sidebar.add_clicked", {});
    const picked = await window.codeshell.pickDir();
    if (!picked) return;
    const duplicate = projects.find((project) => project.path === picked.path);
    if (duplicate) {
      unmarkProjectPathRemoved(picked.path);
      setActiveProjectId(duplicate.id);
      return;
    }
    const next: TrackedProject = {
      id: makeProjectId(),
      name: picked.name,
      path: picked.path,
      addedAt: Date.now(),
    };
    unmarkProjectPathRemoved(next.path);
    setProjects((prev) => [...prev, next]);
    setActiveProjectId(next.id);
    setSessionIndices((prev) => ({ ...prev, [next.id]: loadSessionIndex(next.id) }));
    void window.codeshell.projects.add({ path: next.path, name: next.name });
    window.codeshell.log("repo.added", { id: next.id, path: next.path });
  };

  const removeProject = async (id: string): Promise<void> => {
    const project = projects.find((candidate) => candidate.id === id);
    if (project) {
      markProjectPathRemoved(project.path);
      void window.codeshell.projects.remove(project.path);
    }
    const index = sessionIndices[projectBucketSegment(id)] ?? loadSessionIndex(id);
    if (project) await releaseWorkspacesForArchiveMany(index.sessions, window.codeshell);
    const archived = project ? archiveAllSessions(id, projectLabel(project)) : undefined;
    setProjects((prev) => prev.filter((candidate) => candidate.id !== id));
    if (activeProjectId === id) setActiveProjectId(null);
    setSessionIndices((prev) => {
      if (archived) return { ...prev, [id]: archived };
      const { [id]: _drop, ...rest } = prev;
      return rest;
    });
    window.codeshell.log("repo.removed", { id });
  };

  const toggleProject = (id: string): void => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const pinProject = (id: string, pinned: boolean): void => {
    const project = projects.find((candidate) => candidate.id === id);
    setProjects((prev) =>
      prev.map((candidate) => (candidate.id === id ? { ...candidate, pinned } : candidate)),
    );
    if (project) void window.codeshell.projects.setPinned(project.path, pinned);
  };

  const renameProject = (id: string, name: string): void => {
    setProjects((prev) =>
      prev.map((project) => (project.id === id ? { ...project, displayName: name } : project)),
    );
  };

  const archiveAllProjectSessions = async (id: string): Promise<void> => {
    const index = sessionIndices[id];
    if (!index) return;
    await releaseWorkspacesForArchiveMany(index.sessions, window.codeshell);
    setSessionIndices((prev) => {
      const current = prev[id];
      if (!current) return prev;
      let working = current;
      for (const session of current.sessions) {
        if (!session.archived) working = archiveSession(id, session.id, true);
      }
      return { ...prev, [id]: working };
    });
  };

  const resetDraft = (projectId: string | null, clearOverrides: boolean): void => {
    if (activeProjectId !== projectId) setActiveProjectId(projectId);
    const draftBucket = bucketKey(projectId, null);
    const previousBucket = activeBucketRef.current;
    activeBucketRef.current = draftBucket;
    const nextIndex = setActiveSession(projectId, null);
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegment(projectId)]: nextIndex,
    }));
    window.codeshell.log("session.new_draft", {
      repoId: projectId,
      previousBucket,
      bucket: draftBucket,
      source: clearOverrides ? "repo" : "global",
    });
    if (clearOverrides) {
      setPermissionOverrides((prev) => clearBucketOverride(prev, draftBucket));
      setGoalOverrides((prev) => clearBucketOverride(prev, draftBucket));
      setModelOverrides((prev) => clearBucketOverride(prev, draftBucket));
    }
    clearPanelState(draftBucket);
    setPanelByBucket((prev) => ({ ...prev, [draftBucket]: emptyPanelBucketState() }));
    setView((view) => ({ ...view, viewMode: "chat" }));
  };

  const renameSession = (projectId: string | null, sessionId: string, title: string): void => {
    const next = renameSessionLocal(projectId, sessionId, title, true);
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegment(projectId)]: next,
    }));
  };

  const pinSession = (projectId: string | null, sessionId: string, pinned: boolean): void => {
    const next = setSessionPinnedLocal(projectId, sessionId, pinned);
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegment(projectId)]: next,
    }));
  };

  const setSessionArchived = async (
    projectId: string | null,
    sessionId: string,
    archived: boolean,
  ): Promise<void> => {
    const summary = sessionIndices[projectBucketSegment(projectId)]?.sessions.find(
      (session) => session.id === sessionId,
    );
    await releaseWorkspaceForArchive(summary, archived, window.codeshell);
    const next = archiveSession(projectId, sessionId, archived);
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegment(projectId)]: next,
    }));
  };

  const deleteSession = (projectId: string | null, sessionId: string): void => {
    const summary = sessionIndices[projectBucketSegment(projectId)]?.sessions.find(
      (session) => session.id === sessionId,
    );
    const next = deleteSessionLocal(projectId, sessionId);
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegment(projectId)]: next,
    }));
    const deletedBucket = bucketKey(projectId, sessionId);
    clearPanelState(deletedBucket);
    setPanelByBucket((prev) => {
      if (!(deletedBucket in prev)) return prev;
      const rest = { ...prev };
      delete rest[deletedBucket];
      return rest;
    });

    const plan = planSessionDeletion(
      summary ?? { id: sessionId, title: "", createdAt: 0, updatedAt: 0 },
    );
    void (async () => {
      if (plan.cancelCronJobId) {
        await window.codeshell.cancelAutomationRun(plan.cancelCronJobId).catch((error) =>
          window.codeshell.log("session.delete.cancel.failed", {
            cronJobId: plan.cancelCronJobId,
            error: String(error),
          }),
        );
      }
      await window.codeshell.deleteSession(plan.deleteEngineId).catch((error) =>
        window.codeshell.log("session.delete.session.failed", {
          engineId: plan.deleteEngineId,
          error: String(error),
        }),
      );
      if (plan.deleteRunId) {
        await window.codeshell.deleteRun(plan.deleteRunId).catch((error) =>
          window.codeshell.log("session.delete.run.failed", {
            runId: plan.deleteRunId,
            error: String(error),
          }),
        );
      }
    })();
  };

  const openAutomationRunSession = async (run: RunSummary): Promise<void> => {
    if (!run.sessionId) {
      setRunsInitialRunId(run.runId);
      setView((view) => ({ ...view, viewMode: "runs" }));
      return;
    }
    const existing = findSessionByEngineId(run.sessionId);
    if (existing) {
      selectSession(existing.projectId, existing.session.id);
      return;
    }
    const projectsNow = loadProjects();
    const touchedProjectIds = new Set<string | null>();
    const projectFactory = makeCreateProjectForCwd(projectsNow);
    const cwd = await resolveProjectCwd(run.cwd);
    await importAutomationRuns(
      [{ ...run, sessionId: run.sessionId, cwd, source: "automation" }],
      projectsNow,
      {
        caseInsensitive: isCaseInsensitivePlatform(),
        existingEngineSessionIds: new Set(),
        cap: 1,
        fetchTranscript: (sessionId) => window.codeshell.getSessionTranscript(sessionId),
        createProjectForCwd: projectFactory.createProjectForCwd,
        writeImported: (projectId, summary, state) => {
          saveTranscript(projectId, summary.id, state);
          upsertImportedSession(projectId, summary);
          touchedProjectIds.add(projectId);
        },
      },
    );
    if (projectFactory.changed()) setProjects(projectsNow.slice());
    if (touchedProjectIds.size > 0) {
      setSessionIndices((prev) => {
        const next = { ...prev };
        for (const projectId of touchedProjectIds) {
          next[projectBucketSegment(projectId)] = loadSessionIndex(projectId);
        }
        return next;
      });
    }
    const imported = findSessionByEngineId(run.sessionId);
    if (imported) selectSession(imported.projectId, imported.session.id);
    else {
      setRunsInitialRunId(run.runId);
      setView((view) => ({ ...view, viewMode: "runs" }));
    }
  };

  const openAutomationDiskSession = async (session: DiskSessionMeta): Promise<void> => {
    const existing = findSessionByEngineId(session.engineSessionId);
    if (existing) {
      selectSession(existing.projectId, existing.session.id);
      return;
    }
    const projectsNow = loadProjects();
    const projectFactory = makeCreateProjectForCwd(projectsNow);
    const [placement] = planDiskRebuild(
      [{ ...session, cwd: await resolveProjectCwd(session.cwd) }],
      projectsNow,
      {
        caseInsensitive: isCaseInsensitivePlatform(),
        createProjectForCwd: projectFactory.createProjectForCwd,
      },
    );
    if (!placement) return;
    let state: MessagesReducerState;
    try {
      state = foldTranscript(await window.codeshell.getSessionTranscript(session.engineSessionId));
    } catch {
      state = foldTranscript([]);
    }
    saveTranscript(placement.projectId, placement.summary.id, state);
    const nextIndex = upsertImportedSession(placement.projectId, placement.summary);
    if (projectFactory.changed()) setProjects(projectsNow.slice());
    setSessionIndices((prev) => ({
      ...prev,
      [projectBucketSegment(placement.projectId)]: nextIndex,
    }));
    selectSession(placement.projectId, placement.summary.id);
  };

  return {
    handleAddProject: addProject,
    handleRemoveProject: removeProject,
    handleToggleProject: toggleProject,
    handlePinProject: pinProject,
    handleRenameProject: renameProject,
    handleArchiveAllSessions: archiveAllProjectSessions,
    handleNewConversationForProject: (projectId: string | null) => resetDraft(projectId, true),
    handleNewConversation: () => resetDraft(activeProjectId, false),
    handleSelectSession: selectSession,
    handleRenameSession: renameSession,
    handlePinSession: pinSession,
    handleArchiveSession: setSessionArchived,
    handleDeleteSession: deleteSession,
    handleOpenAutomationRunSession: openAutomationRunSession,
    handleOpenAutomationDiskSession: openAutomationDiskSession,
  };
}

async function resolveProjectCwd(cwd: string): Promise<string> {
  if (!cwd) return cwd;
  try {
    return (await window.codeshell.projects.resolveRoot(cwd)).path;
  } catch {
    return cwd;
  }
}
