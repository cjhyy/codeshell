import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, GitBranch, Loader2, MoreHorizontal, Plus, Search } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../components/ui/tooltip";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../ui/ToastProvider";
import { cn } from "@/lib/utils";
import { WorkspaceDiffLoader, type WorkspaceDiffState } from "./workspace-diff-loader";
import type {
  SessionWorkspace,
  SessionWorkspaceAuthority,
  SessionWorkspaceList,
  SessionWorkspaceWorktreeInfo,
} from "../../preload/types";

type CleanupAction = "detach" | "discard";

interface Props {
  sessionId: string | null;
  projectPath: string | null;
  projectName: string | null;
  sessionBusy?: boolean;
  includeProjectNameInLabel?: boolean;
  /** Keep branch/worktree details out of the title bar; expose them on hover. */
  iconOnly?: boolean;
}

interface CleanupConfirm {
  row: SessionWorkspaceWorktreeInfo;
  action: CleanupAction;
}

interface AuthoritySnapshot {
  requestTargetKey: string;
  targetKey: string;
  status: "ready" | "unavailable";
  authority: SessionWorkspaceAuthority | null;
  error?: string;
}

interface TargetedValue<T> {
  targetKey: string;
  value: T;
}

function authorityTargetKey(
  requestTargetKey: string,
  authority: SessionWorkspaceAuthority | null,
  legacyRoot: string,
): string {
  if (!authority) return `${requestTargetKey}\0legacy:${legacyRoot}`;
  return [
    requestTargetKey,
    authority.mainRootId ?? "legacy",
    authority.mainRoot,
    authority.projectId ?? "no-project",
    authority.rootStatus,
  ].join("\0");
}

export function workspaceIndicatorText(
  workspace: SessionWorkspace | null,
  projectName: string | null,
  opts: { includeProjectName?: boolean; mainBranch?: string | null } = {},
): string {
  const branch =
    workspace?.kind === "worktree" && workspace.worktree?.branch
      ? workspace.worktree.branch
      : opts.mainBranch;
  const base = branch ? `⑃ ${branch}` : "main";
  if (opts.includeProjectName === false) return base;
  return projectName ? `${base} (${projectName})` : base;
}

export function normalizeCurrentBranch(current: string | null): string | null {
  if (!current || current === "HEAD") return null;
  return current;
}

export function formatWorkspaceDiffSummary(
  diff: SessionWorkspaceWorktreeInfo["diff"] | undefined,
  t: TFunction,
): string {
  if (!diff) return t("topbar.workspace.diffChecking");
  return t("topbar.workspace.diffSummary", {
    files: diff.changedFiles,
    commits: diff.aheadCommits,
  });
}

export function workspaceIsExternal(row: SessionWorkspaceWorktreeInfo): boolean {
  return !row.isMain && (row.isManaged === false || !row.branch);
}

export function workspaceRowDisabledReason(
  row: SessionWorkspaceWorktreeInfo,
  current: SessionWorkspace | null,
  t: TFunction,
  sessionBusy = false,
): string | null {
  if (current && samePath(row.path, current.root)) return t("topbar.workspace.current");
  if (sessionBusy) return t("topbar.workspace.sessionBusyDisabled");
  if (!row.isMain && !row.branch) return t("topbar.workspace.detachedDisabled");
  return null;
}

export function workspaceCleanupDisabledReason(
  row: SessionWorkspaceWorktreeInfo,
  t?: TFunction,
): string | null {
  if (workspaceIsExternal(row)) {
    return (
      t?.("topbar.workspace.externalCleanupDisabled") ??
      "This worktree is not managed by CodeShell. Clean it up manually."
    );
  }
  if (row.occupiedByOtherSession) {
    return (
      t?.("topbar.workspace.occupiedCleanupDisabled") ??
      "This worktree is owned by another session. Cleanup is disabled."
    );
  }
  return null;
}

export function workspaceCleanupActionState(
  row: SessionWorkspaceWorktreeInfo,
  t?: TFunction,
): {
  reason: string | null;
  detachDisabled: boolean;
  discardDisabled: boolean;
} {
  const reason = workspaceCleanupDisabledReason(row, t);
  return {
    reason,
    detachDisabled: row.diff?.hasUncommittedChanges === true || reason !== null,
    discardDisabled: reason !== null,
  };
}

export function WorkspaceIndicator({
  sessionId,
  projectPath,
  projectName,
  sessionBusy = false,
  includeProjectNameInLabel = true,
  iconOnly = false,
}: Props) {
  const { t } = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [search, setSearch] = useState("");
  const [externalExpanded, setExternalExpanded] = useState(false);
  const [authorityState, setAuthorityState] = useState<AuthoritySnapshot | null>(null);
  const [workspaceState, setWorkspaceState] =
    useState<TargetedValue<SessionWorkspace | null> | null>(null);
  const [listState, setListState] = useState<TargetedValue<SessionWorkspaceList> | null>(null);
  const [currentLoadingTarget, setCurrentLoadingTarget] = useState<string | null>(null);
  const [listLoadingTarget, setListLoadingTarget] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [confirm, setConfirm] = useState<CleanupConfirm | null>(null);
  // Whether projectPath is an actual git repo. null = not yet probed. The
  // indicator is a git-worktree switcher, so on a non-git folder it must not
  // render at all (worktrees don't exist there). Probed through the
  // Session-scoped Git API so the renderer never substitutes projectPath.
  const [gitState, setGitState] = useState<TargetedValue<{
    isGitRepo: boolean;
    mainBranch: string | null;
  }> | null>(null);
  const [profileState, setProfileState] = useState<TargetedValue<string | null> | null>(null);
  const authorityRequestId = useRef(0);
  const currentRequestId = useRef(0);
  const listRequestId = useRef(0);
  const gitProbeRequestId = useRef(0);
  const requestTargetKey = `${sessionId ?? ""}\0${projectPath ?? ""}`;
  const requestTargetKeyRef = useRef(requestTargetKey);
  const activeAuthorityTargetKeyRef = useRef<string | null>(null);
  const activeAuthorityRef = useRef<SessionWorkspaceAuthority | null>(null);
  const activeAuthorityStatusRef = useRef<AuthoritySnapshot["status"] | null>(null);
  const openRef = useRef(open);
  const showStatsRef = useRef(showStats);
  openRef.current = open;
  showStatsRef.current = showStats;
  if (requestTargetKeyRef.current !== requestTargetKey) {
    requestTargetKeyRef.current = requestTargetKey;
    activeAuthorityTargetKeyRef.current = null;
    activeAuthorityRef.current = null;
    activeAuthorityStatusRef.current = null;
    authorityRequestId.current += 1;
    currentRequestId.current += 1;
    listRequestId.current += 1;
    gitProbeRequestId.current += 1;
  }

  const canLoad = Boolean(sessionId && projectPath);
  const visibleAuthorityState =
    authorityState?.requestTargetKey === requestTargetKey ? authorityState : null;
  const activeTargetKey = visibleAuthorityState?.targetKey ?? null;
  const authority =
    visibleAuthorityState?.status === "ready" ? visibleAuthorityState.authority : null;
  const workspace =
    workspaceState && workspaceState.targetKey === activeTargetKey ? workspaceState.value : null;
  const list = listState && listState.targetKey === activeTargetKey ? listState.value : null;
  const visibleGitState = gitState?.targetKey === activeTargetKey ? gitState.value : null;
  const isGitRepo = visibleGitState?.isGitRepo ?? null;
  const mainBranch = visibleGitState?.mainBranch ?? null;
  const activeProfileLabel =
    profileState?.targetKey === requestTargetKey ? profileState.value : null;
  const currentLoading = currentLoadingTarget === requestTargetKey;
  const listLoading = Boolean(activeTargetKey && listLoadingTarget === activeTargetKey);
  const isLoading = currentLoading || listLoading;
  const [, setDiffVersion] = useState(0);
  const activeDiffLoaderRef = useRef<WorkspaceDiffLoader | null>(null);
  const pendingDiffInvalidationRef = useRef<WorkspaceDiffLoader | null>(null);
  // Cache and pending requests belong to this exact Session/root authority.
  const diffLoader: WorkspaceDiffLoader = useMemo(
    () =>
      new WorkspaceDiffLoader(
        async (path) => {
          if (!sessionId || typeof window.codeshell.getSessionWorktreeDiff !== "function") {
            throw new Error("Worktree diff is unavailable");
          }
          return window.codeshell.getSessionWorktreeDiff(sessionId, path);
        },
        () => {
          if (activeDiffLoaderRef.current === diffLoader) setDiffVersion((version) => version + 1);
        },
      ),
    [activeTargetKey, sessionId],
  );
  useEffect(() => {
    activeDiffLoaderRef.current = diffLoader;
    return () => {
      activeDiffLoaderRef.current = null;
      diffLoader.setOpen(false);
    };
  }, [diffLoader]);
  useEffect(() => {
    diffLoader.setRows(list?.worktrees ?? []);
    diffLoader.setOpen(open && showStats);
  }, [diffLoader, list, open, showStats]);
  const onRowVisibilityChange = useCallback(
    (path: string, visible: boolean) => diffLoader.setVisible(path, visible),
    [diffLoader],
  );

  const reportError = useCallback(
    (error: unknown) => {
      toast({
        message: t("topbar.workspace.actionFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
        variant: "error",
      });
    },
    [t, toast],
  );

  const refreshCurrent = useCallback(async (): Promise<boolean> => {
    const requestAuthorityId = ++authorityRequestId.current;
    const requestCurrentId = ++currentRequestId.current;
    const requestKey = requestTargetKeyRef.current;
    if (!sessionId || !projectPath) {
      setCurrentLoadingTarget(null);
      return false;
    }
    setCurrentLoadingTarget(requestKey);
    try {
      const authorityApi = window.codeshell.getSessionWorkspaceAuthority;
      const nextAuthority =
        typeof authorityApi === "function" ? await authorityApi(sessionId) : null;
      if (
        authorityRequestId.current !== requestAuthorityId ||
        currentRequestId.current !== requestCurrentId ||
        requestTargetKeyRef.current !== requestKey
      ) {
        return false;
      }

      if (!nextAuthority && typeof authorityApi === "function") {
        throw new Error("Session workspace authority is unavailable");
      }

      let next: SessionWorkspace | null = nextAuthority?.workspace ?? null;
      if (!nextAuthority) {
        next = await window.codeshell.getSessionWorkspace(sessionId, projectPath);
        if (
          currentRequestId.current !== requestCurrentId ||
          requestTargetKeyRef.current !== requestKey
        ) {
          return false;
        }
      }

      const nextTargetKey = authorityTargetKey(requestKey, nextAuthority, projectPath);
      if (activeAuthorityTargetKeyRef.current !== nextTargetKey) {
        activeAuthorityTargetKeyRef.current = nextTargetKey;
        listRequestId.current += 1;
        gitProbeRequestId.current += 1;
      }
      activeAuthorityRef.current = nextAuthority;
      activeAuthorityStatusRef.current = "ready";
      setAuthorityState({
        requestTargetKey: requestKey,
        targetKey: nextTargetKey,
        status: "ready",
        authority: nextAuthority,
      });
      if (nextAuthority && nextAuthority.rootStatus !== "ok") {
        setWorkspaceState({ targetKey: nextTargetKey, value: null });
        return false;
      }
      setWorkspaceState({ targetKey: nextTargetKey, value: next });
      return true;
    } catch (error) {
      if (
        authorityRequestId.current !== requestAuthorityId ||
        currentRequestId.current !== requestCurrentId ||
        requestTargetKeyRef.current !== requestKey
      ) {
        return false;
      }
      const unavailableTargetKey = `${requestKey}\0authority-unavailable`;
      if (activeAuthorityTargetKeyRef.current !== unavailableTargetKey) {
        activeAuthorityTargetKeyRef.current = unavailableTargetKey;
        listRequestId.current += 1;
        gitProbeRequestId.current += 1;
      }
      activeAuthorityRef.current = null;
      activeAuthorityStatusRef.current = "unavailable";
      setAuthorityState({
        requestTargetKey: requestKey,
        targetKey: unavailableTargetKey,
        status: "unavailable",
        authority: null,
        error: error instanceof Error ? error.message : String(error),
      });
      setWorkspaceState({ targetKey: unavailableTargetKey, value: null });
      return false;
    } finally {
      if (
        currentRequestId.current === requestCurrentId &&
        requestTargetKeyRef.current === requestKey
      ) {
        setCurrentLoadingTarget(null);
      }
    }
  }, [projectPath, sessionId]);

  const applyWorkspaceList = useCallback(
    (next: SessionWorkspaceList, targetKey: string, updateCurrent: boolean) => {
      if (activeAuthorityTargetKeyRef.current !== targetKey) return;
      const requestAuthority = activeAuthorityRef.current;
      if (requestAuthority && !samePath(next.mainRoot, requestAuthority.mainRoot)) return;
      setListState({ targetKey, value: next });
      if (updateCurrent) setWorkspaceState({ targetKey, value: next.current });
    },
    [],
  );

  const refreshList = useCallback(
    async (invalidateDiffs = false) => {
      const requestId = ++listRequestId.current;
      const targetKey = activeAuthorityTargetKeyRef.current;
      const requestKey = requestTargetKeyRef.current;
      const requestAuthority = activeAuthorityRef.current;
      const currentRequestAtStart = currentRequestId.current;
      if (
        !sessionId ||
        !projectPath ||
        !targetKey ||
        activeAuthorityStatusRef.current !== "ready" ||
        (requestAuthority && requestAuthority.rootStatus !== "ok")
      ) {
        setListLoadingTarget(null);
        return;
      }
      // Keep invalidation across superseded/failed list requests. Reopening the
      // menu must not swallow a file-change refresh while HEAD remains unchanged.
      if (invalidateDiffs) pendingDiffInvalidationRef.current = diffLoader;
      setListLoadingTarget(targetKey);
      try {
        const next = await window.codeshell.listSessionWorktrees(
          sessionId,
          requestAuthority?.mainRoot ?? projectPath,
        );
        if (listRequestId.current !== requestId) return;
        if (
          requestTargetKeyRef.current !== requestKey ||
          activeAuthorityTargetKeyRef.current !== targetKey
        ) {
          return;
        }
        if (pendingDiffInvalidationRef.current === diffLoader) {
          pendingDiffInvalidationRef.current = null;
          // Apply metadata and invalidation together before scheduling fresh work.
          diffLoader.setOpen(false);
          diffLoader.setRows(next.worktrees);
          diffLoader.invalidate();
          diffLoader.setOpen(openRef.current && showStatsRef.current);
        }
        applyWorkspaceList(next, targetKey, currentRequestId.current === currentRequestAtStart);
      } catch (error) {
        if (listRequestId.current !== requestId) return;
        if (
          requestTargetKeyRef.current !== requestKey ||
          activeAuthorityTargetKeyRef.current !== targetKey
        ) {
          return;
        }
        reportError(error);
      } finally {
        if (
          listRequestId.current === requestId &&
          requestTargetKeyRef.current === requestKey &&
          activeAuthorityTargetKeyRef.current === targetKey
        ) {
          setListLoadingTarget(null);
        }
      }
    },
    [applyWorkspaceList, diffLoader, projectPath, reportError, sessionId],
  );

  const refreshGitProbe = useCallback(async () => {
    const requestId = ++gitProbeRequestId.current;
    const targetKey = activeAuthorityTargetKeyRef.current;
    const requestKey = requestTargetKeyRef.current;
    if (
      !projectPath ||
      !sessionId ||
      !targetKey ||
      activeAuthorityStatusRef.current !== "ready" ||
      (activeAuthorityRef.current && activeAuthorityRef.current.rootStatus !== "ok")
    ) {
      return;
    }
    try {
      const res = await window.codeshell.getSessionGitBranches(sessionId);
      if (
        gitProbeRequestId.current !== requestId ||
        requestTargetKeyRef.current !== requestKey ||
        activeAuthorityTargetKeyRef.current !== targetKey
      ) {
        return;
      }
      setGitState({
        targetKey,
        value: {
          isGitRepo: res.isRepo === true,
          mainBranch: res.isRepo === true ? normalizeCurrentBranch(res.current) : null,
        },
      });
    } catch {
      if (
        gitProbeRequestId.current !== requestId ||
        requestTargetKeyRef.current !== requestKey ||
        activeAuthorityTargetKeyRef.current !== targetKey
      ) {
        return;
      }
      setGitState({ targetKey, value: { isGitRepo: false, mainBranch: null } });
    }
  }, [projectPath, sessionId]);
  const refreshListRef = useRef(refreshList);
  refreshListRef.current = refreshList;
  const refreshGitProbeRef = useRef(refreshGitProbe);
  refreshGitProbeRef.current = refreshGitProbe;
  const currentEffectTargetRef = useRef(requestTargetKey);

  useEffect(() => {
    return () => {
      authorityRequestId.current += 1;
      currentRequestId.current += 1;
      listRequestId.current += 1;
      gitProbeRequestId.current += 1;
    };
  }, []);

  useEffect(() => {
    listRequestId.current += 1;
    setListLoadingTarget(null);
    setBusyAction(null);
    setConfirm(null);
    setSearch("");
    setExternalExpanded(false);
    showStatsRef.current = false;
    setShowStats(false);
  }, [requestTargetKey]);

  useEffect(() => {
    const targetChanged = currentEffectTargetRef.current !== requestTargetKey;
    currentEffectTargetRef.current = requestTargetKey;
    void refreshCurrent().then((ready) => {
      if (!ready) return;
      void refreshGitProbeRef.current();
      if (targetChanged && openRef.current) void refreshListRef.current();
    });
  }, [refreshCurrent, requestTargetKey, sessionBusy]);

  useEffect(() => {
    let cancelled = false;
    const profileTargetKey = requestTargetKey;
    if (!projectPath || !sessionId || typeof window.codeshell.listProfiles !== "function") {
      setProfileState({ targetKey: profileTargetKey, value: null });
      return;
    }
    setProfileState({ targetKey: profileTargetKey, value: null });
    const profiles =
      typeof window.codeshell.listSessionProfiles === "function"
        ? window.codeshell.listSessionProfiles(sessionId)
        : window.codeshell.listProfiles({ sessionId });
    void profiles
      .then((profiles) => {
        if (!cancelled && requestTargetKeyRef.current === profileTargetKey) {
          setProfileState({
            targetKey: profileTargetKey,
            value: profiles.find((profile) => profile.active)?.label ?? null,
          });
        }
      })
      .catch(() => {
        if (!cancelled && requestTargetKeyRef.current === profileTargetKey) {
          setProfileState({ targetKey: profileTargetKey, value: null });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath, requestTargetKey, sessionId]);

  useEffect(() => {
    if (!projectPath) return;
    let filesChangedTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshVisibleList = () => {
      if (openRef.current) void refreshListRef.current(true);
      else diffLoader.invalidate();
    };
    const onBranchesChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || samePath(detail.cwd, authority?.mainRoot ?? projectPath)) {
        void refreshGitProbe();
        refreshVisibleList();
      }
    };
    const onFilesChanged = () => {
      clearTimeout(filesChangedTimer);
      filesChangedTimer = setTimeout(() => {
        void refreshGitProbe();
        refreshVisibleList();
      }, 1000);
    };
    window.addEventListener("codeshell:git-branches-changed", onBranchesChanged);
    window.addEventListener("codeshell:files-changed", onFilesChanged);
    return () => {
      clearTimeout(filesChangedTimer);
      window.removeEventListener("codeshell:git-branches-changed", onBranchesChanged);
      window.removeEventListener("codeshell:files-changed", onFilesChanged);
    };
  }, [authority?.mainRoot, diffLoader, refreshGitProbe, projectPath]);

  useEffect(() => {
    if (!sessionId) return;
    const refresh = () => {
      if (requestTargetKeyRef.current !== requestTargetKey) return;
      void refreshCurrent().then((ready) => {
        if (!ready) return;
        void refreshGitProbeRef.current();
        if (openRef.current) void refreshListRef.current(true);
      });
    };
    const offWorkspace = window.codeshell.onWorkspaceChanged?.((event) => {
      if (event.sessionId === sessionId) refresh();
    });
    // The first lookup can precede Session persistence. Busy already became
    // true before that lookup, so refresh when the worker confirms startup
    // instead of waiting for the first turn to finish.
    const offStream = window.codeshell.onStreamEvent?.(({ sessionId: ownerId, event }) => {
      if (
        ownerId === sessionId &&
        event.type === "session_started" &&
        event.sessionId === sessionId
      ) {
        refresh();
      }
    });
    return () => {
      offWorkspace?.();
      offStream?.();
    };
  }, [refreshCurrent, requestTargetKey, sessionId]);

  const onOpenChange = (next: boolean) => {
    openRef.current = next;
    if (!next) diffLoader.setOpen(false);
    setOpen(next);
    if (next) {
      void refreshGitProbe();
      void refreshList();
    }
  };

  const switchTo = async (target: string): Promise<boolean> => {
    if (!sessionId || !projectPath || sessionBusy) return false;
    const requestKey = requestTargetKeyRef.current;
    const targetKey = activeAuthorityTargetKeyRef.current;
    if (!targetKey || activeAuthorityStatusRef.current !== "ready") return false;
    setBusyAction(target);
    try {
      const next = await window.codeshell.switchSessionWorkspace(sessionId, projectPath, target);
      if (
        requestTargetKeyRef.current !== requestKey ||
        activeAuthorityTargetKeyRef.current !== targetKey
      ) {
        return false;
      }
      diffLoader.setOpen(false);
      diffLoader.invalidate();
      applyWorkspaceList(next, targetKey, true);
      openRef.current = false;
      setOpen(false);
      return true;
    } catch (error) {
      reportError(error);
      return false;
    } finally {
      setBusyAction(null);
    }
  };

  const createNew = async () => {
    if (sessionBusy) return;
    const nextSlug = slug.trim();
    if (!nextSlug) return;
    if (await switchTo(nextSlug)) {
      setSlug("");
      setNewOpen(false);
    }
  };

  const cleanup = async () => {
    if (!confirm || !sessionId || !projectPath || sessionBusy) return;
    const requestKey = requestTargetKeyRef.current;
    const targetKey = activeAuthorityTargetKeyRef.current;
    if (!targetKey || activeAuthorityStatusRef.current !== "ready") return;
    const { row, action } = confirm;
    setBusyAction(`${action}:${row.path}`);
    try {
      const next = await window.codeshell.cleanupSessionWorktree(
        sessionId,
        projectPath,
        row.path,
        action,
      );
      if (
        requestTargetKeyRef.current !== requestKey ||
        activeAuthorityTargetKeyRef.current !== targetKey
      ) {
        return;
      }
      diffLoader.setOpen(false);
      diffLoader.setRows(next.worktrees);
      diffLoader.invalidate();
      diffLoader.setOpen(openRef.current && showStatsRef.current);
      applyWorkspaceList(next, targetKey, true);
      setConfirm(null);
    } catch (error) {
      reportError(error);
    } finally {
      setBusyAction(null);
    }
  };

  const label = useMemo(
    () =>
      workspaceIndicatorText(workspace, authority?.mainRootName ?? projectName, {
        includeProjectName: includeProjectNameInLabel,
        mainBranch,
      }),
    [authority?.mainRootName, includeProjectNameInLabel, mainBranch, projectName, workspace],
  );
  const rows = list?.worktrees ?? [];
  const query = search.trim().toLocaleLowerCase();
  const matchingRows = query
    ? rows.filter((row) => `${row.branch}\n${row.path}`.toLocaleLowerCase().includes(query))
    : rows;
  const currentRows = matchingRows.filter((row) => workspace && samePath(row.path, workspace.root));
  const otherRows = matchingRows.filter((row) => !currentRows.includes(row));
  const mainRows = otherRows.filter((row) => row.isMain);
  const externalRows = otherRows.filter((row) => !row.isMain && workspaceIsExternal(row));
  const managedRows = otherRows.filter((row) => !row.isMain && !workspaceIsExternal(row));
  const profileBadge = activeProfileLabel ? (
    <span
      data-active-profile="true"
      title={t("topbar.workspace.activeProfileTitle", { name: activeProfileLabel })}
      className="no-drag ml-1 inline-flex h-7 max-w-28 items-center truncate rounded-sm bg-secondary px-1.5 text-xs text-secondary-foreground"
    >
      {activeProfileLabel}
    </span>
  ) : null;

  const renderRow = (row: SessionWorkspaceWorktreeInfo) => {
    const diffState = diffLoader.getState(row);
    const hydratedRow = { ...row, diff: diffState.diff };
    return (
      <WorkspaceRow
        key={row.path}
        row={hydratedRow}
        showDiff={showStats}
        showExternalBadge={currentRows.includes(row)}
        diffStatus={diffState.status}
        onVisibilityChange={showStats ? onRowVisibilityChange : undefined}
        current={workspace}
        busy={busyAction}
        sessionBusy={sessionBusy}
        sessionId={sessionId}
        mainBranch={mainBranch}
        onSwitch={switchTo}
        onCleanup={(action) => setConfirm({ row: hydratedRow, action })}
      />
    );
  };

  if (!canLoad) return null;
  const unavailable = visibleAuthorityState?.status === "unavailable";
  // A freshly-created UI conversation can exist briefly before Main has
  // materialized its Session state. Authority lookup is then unavailable,
  // which is not evidence that a directory was removed. Keep the control
  // fail-closed without presenting a destructive, false diagnosis; a real
  // root_removed/dir_missing status still renders the repair badge below.
  if (unavailable) return profileBadge;
  const failedRootStatus =
    authority?.rootStatus !== undefined && authority.rootStatus !== "ok"
      ? authority.rootStatus
      : null;
  if (failedRootStatus) {
    return (
      <>
        <span
          data-session-root-status={failedRootStatus}
          title={authority?.rootStatusMessage}
          className="no-drag ml-1 inline-flex h-7 items-center rounded-sm bg-destructive/10 px-2 text-xs font-medium text-destructive"
        >
          {t(
            failedRootStatus === "dir_missing"
              ? "sidebar.sessionRootDirMissing"
              : "sidebar.sessionRootRemoved",
          )}
        </span>
        {profileBadge}
      </>
    );
  }
  // A new target has no authority/current snapshot yet. Same-target refreshes
  // retain the tagged snapshot above, so their trigger remains stable.
  if (!visibleAuthorityState || workspace === null) return profileBadge;
  // The worktree switcher is meaningless outside a git repo, but the active
  // digital human belongs to the project and remains useful there.
  if (isGitRepo !== true) return profileBadge;

  return (
    <TooltipProvider delayDuration={250}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "no-drag inline-flex h-7 items-center rounded-sm text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
              iconOnly ? "w-7 justify-center" : "max-w-[320px] gap-1.5 px-2",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={iconOnly ? label : t("topbar.workspace.openSwitcher")}
            aria-label={iconOnly ? `${t("topbar.workspace.openSwitcher")}: ${label}` : undefined}
            aria-busy={isLoading}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            {!iconOnly && <span className="min-w-0 truncate">{label}</span>}
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={8}
          className="w-[420px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl p-1.5 shadow-xl"
        >
          <div className="flex max-h-[min(70vh,32rem)] flex-col">
            <div className="flex items-center justify-between px-2.5 pb-2 pt-1.5">
              <span className="text-[13px] font-medium text-foreground">
                {t("topbar.workspace.switcherTitle")}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={showStats}
                onClick={() => {
                  const next = !showStatsRef.current;
                  showStatsRef.current = next;
                  if (!next) diffLoader.setOpen(false);
                  setShowStats(next);
                }}
                className="h-7 gap-2 rounded-md px-1.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
              >
                {t("topbar.workspace.changeStats")}
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-3.5 w-6 items-center rounded-full px-0.5",
                    showStats ? "bg-primary" : "bg-muted-foreground/25",
                  )}
                >
                  <span
                    className={cn(
                      "h-2.5 w-2.5 rounded-full shadow-sm",
                      showStats ? "translate-x-2.5 bg-primary-foreground" : "bg-popover",
                    )}
                  />
                </span>
              </Button>
            </div>
            {(rows.length > 6 || Boolean(search)) && (
              <div className="relative mx-1 mb-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/70" />
                <Input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t("topbar.workspace.search")}
                  aria-label={t("topbar.workspace.search")}
                  className="h-8 rounded-md border-transparent bg-muted/60 pl-8 text-xs shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-1"
                />
              </div>
            )}
            <div data-workspace-scroll className="min-h-0 flex-1 overflow-y-auto px-0.5">
              {listLoading && !list ? (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("topbar.workspace.loading")}
                </div>
              ) : (
                <>
                  {currentRows.length > 0 && (
                    <WorkspaceGroup title={t("topbar.workspace.groupCurrent")}>
                      {currentRows.map(renderRow)}
                    </WorkspaceGroup>
                  )}
                  {mainRows.length > 0 && (
                    <WorkspaceGroup title={t("topbar.workspace.groupMain")}>
                      {mainRows.map(renderRow)}
                    </WorkspaceGroup>
                  )}
                  {managedRows.length > 0 && (
                    <WorkspaceGroup title={t("topbar.workspace.groupWorktrees")}>
                      {managedRows.map(renderRow)}
                    </WorkspaceGroup>
                  )}
                  {externalRows.length > 0 && (
                    <WorkspaceGroup
                      title={t("topbar.workspace.groupExternal")}
                      count={externalRows.length}
                      expanded={externalExpanded || Boolean(query)}
                      onToggle={() => setExternalExpanded(!externalExpanded)}
                    >
                      {externalRows.map(renderRow)}
                    </WorkspaceGroup>
                  )}
                  {query && matchingRows.length === 0 && (
                    <div className="px-3 py-4 text-center text-xs text-muted-foreground">
                      {t("topbar.workspace.noMatches")}
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="mt-1 border-t border-border/60 pt-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-full justify-start rounded-md px-2.5 text-xs font-normal"
                onClick={() => setNewOpen(true)}
                disabled={sessionBusy}
              >
                <Plus className="h-4 w-4" />
                {t("topbar.workspace.newWorktree")}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {profileBadge}

      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("topbar.workspace.newTitle")}</DialogTitle>
            <DialogDescription>{t("topbar.workspace.newDescription")}</DialogDescription>
          </DialogHeader>
          <Input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void createNew();
            }}
            placeholder={t("topbar.workspace.slugPlaceholder")}
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setNewOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => void createNew()}
              disabled={sessionBusy || !slug.trim() || !!busyAction}
            >
              {t("topbar.workspace.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(next) => !next && setConfirm(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirm?.action === "discard"
                ? t("topbar.workspace.discardTitle")
                : t("topbar.workspace.detachTitle")}
            </DialogTitle>
            <DialogDescription>{confirm ? cleanupDescription(confirm, t) : ""}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setConfirm(null)}>
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              variant={confirm?.action === "discard" ? "destructive" : "default"}
              onClick={() => void cleanup()}
              disabled={sessionBusy || !!busyAction}
            >
              {confirm?.action === "discard"
                ? t("topbar.workspace.discard")
                : t("topbar.workspace.detach")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

export function WorkspaceRow({
  row,
  current,
  busy,
  sessionBusy = false,
  sessionId,
  mainBranch,
  onSwitch,
  onCleanup,
  cleanupMenuOpen,
  showDiff = true,
  showExternalBadge = true,
  diffStatus,
  onVisibilityChange,
}: {
  row: SessionWorkspaceWorktreeInfo;
  current: SessionWorkspace | null;
  busy: string | null;
  sessionBusy?: boolean;
  sessionId?: string | null;
  mainBranch?: string | null;
  onSwitch: (target: string) => void;
  onCleanup: (action: CleanupAction) => void;
  cleanupMenuOpen?: boolean;
  showDiff?: boolean;
  showExternalBadge?: boolean;
  diffStatus?: WorkspaceDiffState["status"];
  onVisibilityChange?: (path: string, visible: boolean) => void;
}) {
  const { t } = useT();
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = rowRef.current;
    if (!node || !onVisibilityChange) return;
    // Electron supports IntersectionObserver. The fallback also keeps this
    // component usable in hosts without visibility observation.
    if (typeof IntersectionObserver === "undefined") {
      onVisibilityChange(row.path, true);
      return () => onVisibilityChange(row.path, false);
    }
    const observer = new IntersectionObserver(
      ([entry]) => onVisibilityChange(row.path, entry.isIntersecting),
      { root: node.closest("[data-workspace-scroll]") },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      onVisibilityChange(row.path, false);
    };
  }, [onVisibilityChange, row.path]);
  const disabledReason = workspaceRowDisabledReason(row, current, t, sessionBusy);
  const cleanupState = sessionBusy
    ? {
        reason: t("topbar.workspace.sessionBusyDisabled"),
        detachDisabled: true,
        discardDisabled: true,
      }
    : workspaceCleanupActionState(row, t);
  const cleanupDisabledReason = cleanupState.reason;
  const active = current ? samePath(row.path, current.root) : false;
  const ownedByCurrentSession =
    !!sessionId && row.occupiedBySessionIds?.includes(sessionId) === true;
  const dirty = row.diff?.hasUncommittedChanges === true;
  const external = workspaceIsExternal(row);
  const rowLabel = row.isMain
    ? mainBranch
      ? mainBranch
      : t("topbar.workspace.main")
    : row.branch || t("topbar.workspace.detached");
  const path = compactPath(row.path);
  const target = row.isMain ? "main" : row.path;
  const switching = busy === target;
  const switchDisabled = disabledReason !== null || switching;
  const visuallyMuted = switchDisabled && !active;
  const detachDisabled = cleanupState.detachDisabled;
  const discardDisabled = cleanupState.discardDisabled;

  const cleanupTrigger = (
    <DropdownMenuTrigger asChild>
      <button
        type="button"
        className="my-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/60 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
        title={cleanupDisabledReason ?? t("topbar.workspace.cleanup")}
        aria-label={
          cleanupDisabledReason
            ? `${t("topbar.workspace.cleanup")}: ${cleanupDisabledReason}`
            : t("topbar.workspace.cleanup")
        }
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
    </DropdownMenuTrigger>
  );

  const button = (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      aria-disabled={switchDisabled}
      onClick={() => {
        if (disabledReason || switching) return;
        onSwitch(target);
      }}
      className={cn(
        "grid min-h-12 w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        active && "bg-accent/70 text-accent-foreground",
        !active && !disabledReason && "hover:bg-accent",
        visuallyMuted
          ? "cursor-default opacity-55"
          : "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
          <span
            className={cn(
              "truncate text-[13px] font-medium",
              active ? "text-accent-foreground" : "text-foreground",
            )}
            title={rowLabel}
          >
            {rowLabel}
          </span>
          {ownedByCurrentSession && !active && (
            <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {t("topbar.workspace.thisSession")}
            </span>
          )}
          {row.occupiedByOtherSession && !row.isMain && (
            <span className="shrink-0 rounded-sm bg-status-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-status-warn">
              {t("topbar.workspace.occupied")}
            </span>
          )}
          {external && showExternalBadge && (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("topbar.workspace.external")}
            </span>
          )}
          {dirty && showDiff && (
            <span className="shrink-0 rounded-sm bg-status-running/10 px-1.5 py-0.5 text-[10px] font-medium text-status-running">
              {t("topbar.workspace.dirty")}
            </span>
          )}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate pl-5 text-[11px] leading-4",
            active ? "text-accent-foreground/60" : "text-muted-foreground/70",
          )}
          title={row.path}
        >
          {path}
        </span>
      </span>
      <span
        className={cn(
          "flex items-center gap-2 self-center whitespace-nowrap text-[11px] tabular-nums",
          active ? "text-accent-foreground/70" : "text-muted-foreground",
        )}
      >
        {switching ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : showDiff ? (
          <span title={diffStatus === "error" ? t("topbar.workspace.diffFailed") : undefined}>
            {row.diff
              ? formatWorkspaceDiffSummary(row.diff, t)
              : diffStatus === "error"
                ? t("topbar.workspace.diffFailed")
                : diffStatus === "idle"
                  ? t("topbar.workspace.diffUnknown")
                  : formatWorkspaceDiffSummary(undefined, t)}
          </span>
        ) : null}
        {active && !switching && (
          <Check
            className="h-3.5 w-3.5 shrink-0 text-primary"
            aria-label={t("topbar.workspace.currentBadge")}
          />
        )}
      </span>
    </button>
  );

  return (
    <div
      ref={rowRef}
      className={cn(
        "group grid items-stretch gap-0.5 rounded-md",
        row.isMain ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_1.75rem]",
      )}
    >
      {disabledReason ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {!row.isMain && (
        <DropdownMenu {...(cleanupMenuOpen === undefined ? {} : { open: cleanupMenuOpen })}>
          {cleanupDisabledReason ? (
            <Tooltip>
              <TooltipTrigger asChild>{cleanupTrigger}</TooltipTrigger>
              <TooltipContent>{cleanupDisabledReason}</TooltipContent>
            </Tooltip>
          ) : (
            cleanupTrigger
          )}
          <DropdownMenuContent
            align="end"
            forceMount={cleanupMenuOpen ? true : undefined}
            title={cleanupDisabledReason ?? undefined}
          >
            <DropdownMenuItem
              disabled={detachDisabled}
              title={cleanupDisabledReason ?? undefined}
              onSelect={(event) => {
                if (detachDisabled) {
                  event.preventDefault();
                  return;
                }
                onCleanup("detach");
              }}
            >
              {t("topbar.workspace.detach")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={discardDisabled}
              className="text-status-err focus:text-status-err"
              title={cleanupDisabledReason ?? undefined}
              onSelect={(event) => {
                if (discardDisabled) {
                  event.preventDefault();
                  return;
                }
                onCleanup("discard");
              }}
            >
              {t("topbar.workspace.discard")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function WorkspaceGroup({
  title,
  children,
  expanded = true,
  onToggle,
  count,
}: {
  title: string;
  children: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  count?: number;
}) {
  return (
    <section className="py-1">
      {onToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={count === undefined ? title : `${title} (${count})`}
          onClick={onToggle}
          className="flex h-8 w-full items-center gap-1.5 rounded-md px-2 text-left text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className={cn("h-3 w-3 shrink-0", !expanded && "-rotate-90")} />
          <span className="flex-1">{title}</span>
          {count !== undefined && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground/80">
              {count}
            </span>
          )}
        </button>
      ) : (
        <div className="px-2 pb-1.5 pt-1 text-[11px] font-medium text-muted-foreground/70">
          {title}
        </div>
      )}
      {expanded && <div className="space-y-0.5">{children}</div>}
    </section>
  );
}

function cleanupDescription(confirm: CleanupConfirm, t: TFunction): string {
  const branch = confirm.row.branch || confirm.row.path;
  if (confirm.action === "discard") {
    return confirm.row.diff?.hasUncommittedChanges
      ? t("topbar.workspace.discardDirtyDescription", { branch })
      : t("topbar.workspace.discardDescription", { branch });
  }
  return t("topbar.workspace.detachDescription", { branch });
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `.../${parts.slice(-3).join("/")}`;
}

function samePath(a: string, b: string): boolean {
  return a === b;
}
