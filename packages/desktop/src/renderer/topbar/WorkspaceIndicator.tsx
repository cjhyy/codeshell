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
  SessionWorkspaceList,
  SessionWorkspaceWorktreeInfo,
} from "../../preload/types";

type CleanupAction = "detach" | "discard";

interface Props {
  sessionId: string | null;
  repoPath: string | null;
  repoName: string | null;
  sessionBusy?: boolean;
  includeRepoNameInLabel?: boolean;
}

interface CleanupConfirm {
  row: SessionWorkspaceWorktreeInfo;
  action: CleanupAction;
}

export function workspaceIndicatorText(
  workspace: SessionWorkspace | null,
  repoName: string | null,
  opts: { includeRepoName?: boolean } = {},
): string {
  if (workspace?.kind === "worktree" && workspace.worktree?.branch) {
    return `⑃ ${workspace.worktree.branch}`;
  }
  if (opts.includeRepoName === false) return "main";
  return repoName ? `main (${repoName})` : "main";
}

export function formatWorkspaceDiffSummary(
  diff: SessionWorkspaceWorktreeInfo["diff"] | undefined,
  t: TFunction,
): string {
  if (!diff) return t("topbar.workspace.diffUnknown");
  return t("topbar.workspace.diffSummary", {
    files: diff.changedFiles,
    commits: diff.aheadCommits,
  });
}

export function workspaceRowDisabledReason(
  row: SessionWorkspaceWorktreeInfo,
  current: SessionWorkspace | null,
  t: TFunction,
): string | null {
  if (current && samePath(row.path, current.root)) return t("topbar.workspace.current");
  if (!row.isMain && !row.branch) return t("topbar.workspace.detachedDisabled");
  return null;
}

export function workspaceCleanupDisabledReason(row: SessionWorkspaceWorktreeInfo): string | null {
  if (row.occupiedByOtherSession) {
    return "This worktree is owned by another session. Cleanup is disabled.";
  }
  return null;
}

export function workspaceCleanupActionState(row: SessionWorkspaceWorktreeInfo): {
  reason: string | null;
  detachDisabled: boolean;
  discardDisabled: boolean;
} {
  const reason = workspaceCleanupDisabledReason(row);
  return {
    reason,
    detachDisabled: row.diff?.hasUncommittedChanges === true || reason !== null,
    discardDisabled: reason !== null,
  };
}

export function WorkspaceIndicator({
  sessionId,
  repoPath,
  repoName,
  sessionBusy = false,
  includeRepoNameInLabel = true,
}: Props) {
  const { t } = useT();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [workspace, setWorkspace] = useState<SessionWorkspace | null>(null);
  const [list, setList] = useState<SessionWorkspaceList | null>(null);
  const [currentLoading, setCurrentLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [slug, setSlug] = useState("");
  const [confirm, setConfirm] = useState<CleanupConfirm | null>(null);
  const currentRequestId = useRef(0);
  const listRequestId = useRef(0);

  const canLoad = Boolean(sessionId && repoPath);
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

  const refreshCurrent = useCallback(async () => {
    const requestId = ++currentRequestId.current;
    if (!sessionId || !repoPath) {
      setCurrentLoading(false);
      setWorkspace(null);
      setList(null);
      return;
    }
    setCurrentLoading(true);
    try {
      const next = await window.codeshell.getSessionWorkspace(sessionId, repoPath);
      if (currentRequestId.current !== requestId) return;
      setWorkspace(next);
    } catch {
      if (currentRequestId.current !== requestId) return;
      setWorkspace({ root: repoPath, kind: "main" });
    } finally {
      if (currentRequestId.current === requestId) setCurrentLoading(false);
    }
  }, [repoPath, sessionId]);

  const refreshList = useCallback(async () => {
    const requestId = ++listRequestId.current;
    if (!sessionId || !repoPath) {
      setList(null);
      setListLoading(false);
      return;
    }
    setListLoading(true);
    try {
      const next = await window.codeshell.listSessionWorktrees(sessionId, repoPath);
      if (listRequestId.current !== requestId) return;
      setList(next);
      setWorkspace(next.current);
    } catch (error) {
      if (listRequestId.current !== requestId) return;
      reportError(error);
    } finally {
      if (listRequestId.current === requestId) setListLoading(false);
    }
  }, [repoPath, reportError, sessionId]);

  useEffect(() => {
    return () => {
      currentRequestId.current += 1;
      listRequestId.current += 1;
    };
  }, []);

  useEffect(() => {
    void refreshCurrent();
  }, [refreshCurrent, sessionBusy]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void refreshList();
  };

  const switchTo = async (target: string): Promise<boolean> => {
    if (!sessionId || !repoPath) return false;
    setBusyAction(target);
    try {
      const next = await window.codeshell.switchSessionWorkspace(sessionId, repoPath, target);
      setList(next);
      setWorkspace(next.current);
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
    const nextSlug = slug.trim();
    if (!nextSlug) return;
    if (await switchTo(nextSlug)) {
      setSlug("");
      setNewOpen(false);
    }
  };

  const cleanup = async () => {
    if (!confirm || !sessionId || !repoPath) return;
    const { row, action } = confirm;
    setBusyAction(`${action}:${row.path}`);
    try {
      const next = await window.codeshell.cleanupSessionWorktree(
        sessionId,
        repoPath,
        row.path,
        action,
      );
      setList(next);
      setWorkspace(next.current);
      setConfirm(null);
    } catch (error) {
      reportError(error);
    } finally {
      setBusyAction(null);
    }
  };

  const label = useMemo(
    () => workspaceIndicatorText(workspace, repoName, { includeRepoName: includeRepoNameInLabel }),
    [includeRepoNameInLabel, repoName, workspace],
  );

  if (!canLoad) return null;

  return (
    <TooltipProvider delayDuration={250}>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="no-drag inline-flex h-7 max-w-[220px] items-center gap-1.5 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            title={t("topbar.workspace.openSwitcher")}
            aria-busy={isLoading}
          >
            <GitBranch className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 truncate">{label}</span>
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
                (list?.worktrees ?? []).map((row) => (
                  <WorkspaceRow
                    key={row.path}
                    row={row}
                    current={workspace}
                    busy={busyAction}
                    onSwitch={switchTo}
                    onCleanup={(action) => setConfirm({ row, action })}
                  />
                ))
              )}
            </div>
            <div className="border-t border-border p-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => setNewOpen(true)}
              >
                <Plus className="h-4 w-4" />
                {t("topbar.workspace.newWorktree")}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>

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
              disabled={!slug.trim() || !!busyAction}
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
              disabled={!!busyAction}
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
  onSwitch,
  onCleanup,
  cleanupMenuOpen,
}: {
  row: SessionWorkspaceWorktreeInfo;
  current: SessionWorkspace | null;
  busy: string | null;
  onSwitch: (target: string) => void;
  onCleanup: (action: CleanupAction) => void;
  cleanupMenuOpen?: boolean;
}) {
  const { t } = useT();
  const disabledReason = workspaceRowDisabledReason(row, current, t);
  const cleanupState = workspaceCleanupActionState(row);
  const cleanupDisabledReason = cleanupState.reason;
  const dirty = row.diff?.hasUncommittedChanges === true;
  const rowLabel = row.isMain
    ? t("topbar.workspace.main")
    : row.branch || t("topbar.workspace.detached");
  const path = compactPath(row.path);
  const target = row.isMain ? "main" : row.path;
  const switching = busy === target;
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
      aria-disabled={disabledReason !== null || switching}
      onClick={() => {
        if (disabledReason || switching) return;
        onSwitch(target);
      }}
      className={cn(
        "grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-sm px-2 py-2 text-left transition-colors",
        disabledReason
          ? "cursor-default opacity-55"
          : "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
      )}
    >
      <span className="min-w-0">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{rowLabel}</span>
          {row.occupiedByOtherSession && (
            <span className="shrink-0 rounded-sm bg-status-warn/10 px-1.5 py-0.5 text-[10px] font-medium text-status-warn">
              {t("topbar.workspace.occupied")}
            </span>
          )}
          {dirty && (
            <span className="shrink-0 rounded-sm bg-status-running/10 px-1.5 py-0.5 text-[10px] font-medium text-status-running">
              {t("topbar.workspace.dirty")}
            </span>
          )}
        </span>
        <span className="mt-0.5 block truncate text-xs text-muted-foreground" title={row.path}>
          {path}
        </span>
      </span>
      <span className="self-center whitespace-nowrap text-xs text-muted-foreground">
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
