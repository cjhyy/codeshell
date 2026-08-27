import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Loader2, MoreHorizontal, Plus } from "lucide-react";
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
  const diffRequestId = useRef(0);
  const gitProbeRequestId = useRef(0);
  const requestTargetKey = `${sessionId ?? ""}\0${projectPath ?? ""}`;
  const requestTargetKeyRef = useRef(requestTargetKey);
  const activeAuthorityTargetKeyRef = useRef<string | null>(null);
  const activeAuthorityRef = useRef<SessionWorkspaceAuthority | null>(null);
  const activeAuthorityStatusRef = useRef<AuthoritySnapshot["status"] | null>(null);
  const openRef = useRef(open);
  openRef.current = open;
  if (requestTargetKeyRef.current !== requestTargetKey) {
    requestTargetKeyRef.current = requestTargetKey;
    activeAuthorityTargetKeyRef.current = null;
    activeAuthorityRef.current = null;
    activeAuthorityStatusRef.current = null;
    authorityRequestId.current += 1;
    currentRequestId.current += 1;
    listRequestId.current += 1;
    diffRequestId.current += 1;
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
        diffRequestId.current += 1;
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
        diffRequestId.current += 1;
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

  const hydrateDiffs = useCallback(
    (next: SessionWorkspaceList, targetKey: string, requestSessionId: string) => {
      const getDiff = window.codeshell.getSessionWorktreeDiff;
      if (typeof getDiff !== "function") return;
      const requestId = ++diffRequestId.current;
      for (const row of next.worktrees) {
        void getDiff(requestSessionId, row.path)
          .then((diff) => {
            if (diffRequestId.current !== requestId) return;
            if (activeAuthorityTargetKeyRef.current !== targetKey) return;
            setListState((current) => {
              if (
                !current ||
                current.targetKey !== targetKey ||
                current.value.mainRoot !== next.mainRoot
              ) {
                return current;
              }
              let changed = false;
              const worktrees = current.value.worktrees.map((existing) => {
                if (existing.path !== row.path) return existing;
                changed = true;
                return { ...existing, diff };
              });
              return changed ? { ...current, value: { ...current.value, worktrees } } : current;
            });
          })
          .catch(() => {
            // Per-row diff is best-effort. Stale/cancelled requests are ignored
            // by the requestId guard; real failures leave the row in checking.
          });
      }
    },
    [],
  );

  const applyWorkspaceList = useCallback(
    (
      next: SessionWorkspaceList,
      targetKey: string,
      requestSessionId: string,
      updateCurrent: boolean,
    ) => {
      if (activeAuthorityTargetKeyRef.current !== targetKey) return;
      const requestAuthority = activeAuthorityRef.current;
      if (requestAuthority && !samePath(next.mainRoot, requestAuthority.mainRoot)) return;
      setListState({ targetKey, value: next });
      if (updateCurrent) setWorkspaceState({ targetKey, value: next.current });
      hydrateDiffs(next, targetKey, requestSessionId);
    },
    [hydrateDiffs],
  );

  const refreshList = useCallback(async () => {
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
      applyWorkspaceList(
        next,
        targetKey,
        sessionId,
        currentRequestId.current === currentRequestAtStart,
      );
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
  }, [applyWorkspaceList, projectPath, reportError, sessionId]);

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
      diffRequestId.current += 1;
      gitProbeRequestId.current += 1;
    };
  }, []);

  useEffect(() => {
    listRequestId.current += 1;
    diffRequestId.current += 1;
    setListLoadingTarget(null);
    setBusyAction(null);
    setConfirm(null);
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
    const onBranchesChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ cwd?: string }>).detail;
      if (!detail?.cwd || samePath(detail.cwd, authority?.mainRoot ?? projectPath))
        void refreshGitProbe();
    };
    const onFilesChanged = () => {
      void refreshGitProbe();
    };
    window.addEventListener("codeshell:git-branches-changed", onBranchesChanged);
    window.addEventListener("codeshell:files-changed", onFilesChanged);
    return () => {
      window.removeEventListener("codeshell:git-branches-changed", onBranchesChanged);
      window.removeEventListener("codeshell:files-changed", onFilesChanged);
    };
  }, [authority?.mainRoot, refreshGitProbe, projectPath]);

  useEffect(() => {
    const subscribe = window.codeshell.onWorkspaceChanged;
    if (typeof subscribe !== "function" || !sessionId) return;
    return subscribe((event) => {
      if (event.sessionId !== sessionId) return;
      void refreshCurrent().then((ready) => {
        if (!ready) return;
        void refreshGitProbeRef.current();
        if (openRef.current) void refreshListRef.current();
      });
    });
  }, [refreshCurrent, sessionId]);

  const onOpenChange = (next: boolean) => {
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
      applyWorkspaceList(next, targetKey, sessionId, true);
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
      applyWorkspaceList(next, targetKey, sessionId, true);
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
  const mainRows = rows.filter((row) => row.isMain);
  const externalRows = rows.filter((row) => !row.isMain && workspaceIsExternal(row));
  const managedRows = rows.filter((row) => !row.isMain && !workspaceIsExternal(row));
  const profileBadge = activeProfileLabel ? (
    <span
      data-active-profile="true"
      title={t("topbar.workspace.activeProfileTitle", { name: activeProfileLabel })}
      className="no-drag ml-1 inline-flex h-7 max-w-28 items-center truncate rounded-sm bg-secondary px-1.5 text-xs text-secondary-foreground"
    >
      {activeProfileLabel}
    </span>
  ) : null;

  if (!canLoad) return null;
  const unavailable = visibleAuthorityState?.status === "unavailable";
  const failedRootStatus =
    unavailable || (authority?.rootStatus !== undefined && authority.rootStatus !== "ok")
      ? unavailable
        ? "unavailable"
        : authority!.rootStatus
      : null;
  if (failedRootStatus) {
    return (
      <>
        <span
          data-session-root-status={failedRootStatus}
          title={unavailable ? visibleAuthorityState?.error : authority?.rootStatusMessage}
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
        <PopoverContent align="start" className="w-[520px] max-w-[calc(100vw-2rem)] p-0">
          <div className="flex max-h-[min(70vh,32rem)] flex-col">
            <div className="border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
              {t("topbar.workspace.switcherTitle")}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {listLoading && !list ? (
                <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t("topbar.workspace.loading")}
                </div>
              ) : (
                <>
                  {mainRows.length > 0 && (
                    <WorkspaceGroup title={t("topbar.workspace.groupMain")}>
                      {mainRows.map((row) => (
                        <WorkspaceRow
                          key={row.path}
                          row={row}
                          current={workspace}
                          busy={busyAction}
                          sessionBusy={sessionBusy}
                          sessionId={sessionId}
                          mainBranch={mainBranch}
                          onSwitch={switchTo}
                          onCleanup={(action) => setConfirm({ row, action })}
                        />
                      ))}
                    </WorkspaceGroup>
                  )}
                  {managedRows.length > 0 && (
                    <WorkspaceGroup title={t("topbar.workspace.groupWorktrees")}>
                      {managedRows.map((row) => (
                        <WorkspaceRow
                          key={row.path}
                          row={row}
                          current={workspace}
                          busy={busyAction}
                          sessionBusy={sessionBusy}
                          sessionId={sessionId}
                          mainBranch={mainBranch}
                          onSwitch={switchTo}
                          onCleanup={(action) => setConfirm({ row, action })}
                        />
                      ))}
                    </WorkspaceGroup>
                  )}
                  {externalRows.length > 0 && (
                    <WorkspaceGroup title={t("topbar.workspace.groupExternal")}>
                      {externalRows.map((row) => (
                        <WorkspaceRow
                          key={row.path}
                          row={row}
                          current={workspace}
                          busy={busyAction}
                          sessionBusy={sessionBusy}
                          sessionId={sessionId}
                          mainBranch={mainBranch}
                          onSwitch={switchTo}
                          onCleanup={(action) => setConfirm({ row, action })}
                        />
                      ))}
                    </WorkspaceGroup>
                  )}
                </>
              )}
            </div>
            <div className="border-t border-border p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
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
}) {
  const { t } = useT();
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
  const changedFiles = row.diff?.changedFiles ?? 0;
  const aheadCommits = row.diff?.aheadCommits ?? 0;
  const external = workspaceIsExternal(row);
  const rowLabel = row.isMain
    ? mainBranch
      ? `⑃ ${mainBranch}`
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
        className="my-2 inline-flex h-8 w-8 items-center justify-center rounded-sm text-muted-foreground opacity-80 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
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
        "grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-sm px-2 py-2 text-left transition-colors",
        active && "bg-accent text-accent-foreground ring-1 ring-border",
        !active && !disabledReason && "hover:bg-accent",
        visuallyMuted
          ? "cursor-default opacity-55"
          : "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "truncate text-sm font-medium",
              active ? "text-accent-foreground" : "text-foreground",
            )}
          >
            {rowLabel}
          </span>
          {active && (
            <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {t("topbar.workspace.currentBadge")}
            </span>
          )}
          {ownedByCurrentSession && !active && (
            <span className="shrink-0 rounded-sm bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
              {t("topbar.workspace.thisSession")}
            </span>
          )}
          {row.occupiedByOtherSession && (
            <span className="shrink-0 rounded-sm bg-status-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-status-warn">
              {t("topbar.workspace.occupied")}
            </span>
          )}
          {external && (
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {t("topbar.workspace.external")}
            </span>
          )}
          {dirty && (
            <span className="shrink-0 rounded-sm bg-status-running/10 px-1.5 py-0.5 text-[10px] font-medium text-status-running">
              {t("topbar.workspace.dirty")}
            </span>
          )}
          {row.diff && changedFiles > 0 && (
            <span className="shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
              {t("topbar.workspace.changedFilesBadge", { files: changedFiles })}
            </span>
          )}
          {row.diff && aheadCommits > 0 && (
            <span className="shrink-0 rounded-sm bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-foreground">
              {t("topbar.workspace.aheadBadge", { commits: aheadCommits })}
            </span>
          )}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-xs",
            active ? "text-accent-foreground/80" : "text-muted-foreground",
          )}
          title={row.path}
        >
          {path}
        </span>
      </span>
      <span
        className={cn(
          "self-center whitespace-nowrap text-xs",
          active ? "text-accent-foreground/80" : "text-muted-foreground",
        )}
      >
        {switching ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          formatWorkspaceDiffSummary(row.diff, t)
        )}
      </span>
    </button>
  );

  return (
    <div className="group grid grid-cols-[minmax(0,1fr)_2rem] items-stretch gap-1 rounded-sm">
      {disabledReason ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{disabledReason}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {row.isMain ? (
        <span />
      ) : (
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

function WorkspaceGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="py-1">
      <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-normal text-muted-foreground">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
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
