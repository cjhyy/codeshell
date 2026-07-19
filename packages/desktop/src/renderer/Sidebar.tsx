import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  MessageSquare,
  Search,
  Folder,
  FolderOpen,
  Plus,
  MoreHorizontal,
  PenSquare,
  Archive,
  Clock,
  GitBranch,
  Loader2,
} from "lucide-react";
import { Badge } from "./ui/Badge";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu";
import { truncateTitle } from "./ui/ConfirmDialog";
import { useConfirm, usePrompt } from "./ui/DialogProvider";
import { useToast } from "./ui/ToastProvider";
import { copyText } from "./lib/clipboard";
import { SettingsMenu } from "./settings/SettingsMenu";
import { SidebarUpdaterButton } from "./updater/UpdaterBanner";
import type { ViewMode } from "./view";
import { PAGE_REGISTRY, pageEntryTitle } from "./pages/PageRegistry";
import { projectLabel, sortProjects, type TrackedProject } from "./projects";
import { NO_REPO_KEY, bucketKey, type SessionIndex, type SessionSummary } from "./transcripts";
import type { SessionStatus } from "./sessionStatus";
import { useT } from "./i18n";
import { PetSidebarEntry } from "./pet/PetSidebarEntry";
import { compactSidebarSessions } from "./sidebarSessionVisibility";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { SessionWorkspace } from "../preload/types";

interface SidebarProps {
  projects: TrackedProject[];
  sessions: Record<string, SessionIndex>;
  activeProjectId: string | null;
  activeSessionId: string | null;
  collapsedProjects: Set<string>;
  /** Per-bucket status mark, keyed by the shared bucketKey(projectId, sessionId). */
  sessionStatuses?: Record<string, SessionStatus>;
  sidebarCollapsed?: boolean;
  petPendingCount: number;
  petRunningCount: number;
  petWidgetVisible: boolean;
  sessionHistoryLoading: boolean;
  hasMoreSessionHistory: boolean;

  onSelectProject: (id: string | null) => void;
  onSelectSession: (projectId: string | null, sessionId: string) => void;
  onToggleProject: (id: string) => void;
  onAddProject: () => void;
  onRemoveProject: (id: string) => void;
  onPinProject: (id: string, pinned: boolean) => void;
  onRenameProject: (id: string, name: string) => void;
  onArchiveAllSessions: (id: string) => void;
  onNewConversationForProject: (id: string | null) => void;

  onNewConversation: () => void;
  onOpenSearch: () => void;
  /** Navigate to a registry page's target view (sidebar first-level nav). */
  onNavigate: (mode: ViewMode) => void;
  onOpenProjectConfig: (id: string) => void;
  onOpenSettingsPage: () => void;
  onOpenPetPage: () => void;
  onTogglePetWidget: () => void;
  onLoadMoreSessionHistory: () => void;

  onRenameSession: (projectId: string | null, sessionId: string, title: string) => void;
  onArchiveSession: (projectId: string | null, sessionId: string, archived: boolean) => void;
  onDeleteSession: (projectId: string | null, sessionId: string) => void;

  activeProjectPath: string | null;
  viewMode: ViewMode;
}

const COMPACT_SESSION_LIMIT = 5;

type MenuTarget =
  | { kind: "project"; x: number; y: number; project: TrackedProject }
  | { kind: "session"; x: number; y: number; projectId: string | null; session: SessionSummary };

type WorkspaceChangeEvent = {
  sessionId: string;
  workspace?: SessionWorkspace;
  mainRoot?: string;
};

export function Sidebar({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  collapsedProjects,
  sessionStatuses,
  sidebarCollapsed,
  petPendingCount,
  petRunningCount,
  petWidgetVisible,
  sessionHistoryLoading,
  hasMoreSessionHistory,
  onSelectProject,
  onSelectSession,
  onToggleProject,
  onAddProject,
  onRemoveProject,
  onPinProject,
  onRenameProject,
  onArchiveAllSessions,
  onNewConversationForProject,
  onNewConversation,
  onOpenSearch,
  onNavigate,
  onOpenProjectConfig,
  onOpenSettingsPage,
  onOpenPetPage,
  onTogglePetWidget,
  onLoadMoreSessionHistory,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  viewMode,
}: SidebarProps) {
  const { t } = useT();
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [workspaceChange, setWorkspaceChange] = useState<WorkspaceChangeEvent | null>(null);
  const closeMenu = (): void => setMenu(null);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();

  // Re-render when pages register/unregister (same idiom as panels/PanelArea.tsx:158).
  useSyncExternalStore(PAGE_REGISTRY.subscribe, PAGE_REGISTRY.snapshot, PAGE_REGISTRY.snapshot);
  const navPages = PAGE_REGISTRY.navEntries();

  // Pin sort (sortProjects: pinned first, then by addedAt asc).
  const orderedProjects = useMemo(() => sortProjects(projects), [projects]);

  // Keep one workspace listener for the whole sidebar. Project groups use the
  // event to refresh only the visible session row that changed.
  useEffect(() => {
    const subscribe = window.codeshell.onWorkspaceChanged;
    if (typeof subscribe !== "function") return;
    return subscribe((event) => setWorkspaceChange(event));
  }, []);

  // No-repo conversations live under the bottom 对话 section.
  const noRepoIndex = sessions[NO_REPO_KEY];
  const noRepoSessions = noRepoIndex?.sessions.filter((s) => !s.archived) ?? [];

  const projectMenu = (project: TrackedProject): ContextMenuItem[] => [
    {
      label: t("projectConfig.open"),
      onClick: () => onOpenProjectConfig(project.id),
    },
    {
      label: project.pinned ? t("sidebar.unpinProject") : t("sidebar.pinProject"),
      onClick: () => onPinProject(project.id, !project.pinned),
    },
    {
      label: t("sidebar.revealInFinder"),
      onClick: () => {
        void window.codeshell.revealInFinder(project.path);
      },
    },
    {
      label: t("sidebar.renameProject"),
      onClick: () => {
        void prompt({
          title: t("sidebar.renameProjectTitle"),
          message: t("sidebar.renameProjectMessage"),
          defaultValue: projectLabel(project),
        }).then((next) => {
          if (next !== null && next.trim()) onRenameProject(project.id, next.trim());
        });
      },
    },
    {
      label: t("sidebar.archiveConversations"),
      onClick: () => {
        const live = sessions[project.id]?.sessions.filter((s) => !s.archived).length ?? 0;
        if (live === 0) return;
        void confirm({
          title: t("sidebar.archiveConversationsTitle"),
          message: t("sidebar.archiveConversationsMessage", {
            name: truncateTitle(projectLabel(project), 24),
            count: live,
          }),
          confirmLabel: t("common.archive"),
        }).then((ok) => {
          if (ok) onArchiveAllSessions(project.id);
        });
      },
    },
    {
      label: t("sidebar.removeProject"),
      danger: true,
      onClick: () => {
        void confirm({
          title: t("sidebar.removeProjectTitle"),
          message: t("sidebar.removeProjectMessage", {
            name: truncateTitle(projectLabel(project), 24),
          }),
          detail: t("sidebar.removeProjectDetail"),
          confirmLabel: t("common.remove"),
          destructive: true,
        }).then((ok) => {
          if (ok) onRemoveProject(project.id);
        });
      },
    },
  ];

  const sessionMenu = (projectId: string | null, s: SessionSummary): ContextMenuItem[] => [
    {
      label: t("sidebar.renameSession"),
      onClick: () => {
        void prompt({
          title: t("sidebar.renameSessionTitle"),
          message: t("sidebar.renameSessionMessage"),
          defaultValue: s.title,
        }).then((next) => {
          if (next !== null && next.trim()) onRenameSession(projectId, s.id, next.trim());
        });
      },
    },
    {
      label: t("sidebar.copySessionId"),
      onClick: () => {
        void copyText(s.id).then((ok) =>
          toast({
            message: ok ? t("sidebar.sessionIdCopied") : t("sidebar.copyFailed"),
            variant: ok ? "success" : "error",
          }),
        );
      },
    },
    s.archived
      ? { label: t("common.restore"), onClick: () => onArchiveSession(projectId, s.id, false) }
      : { label: t("common.archive"), onClick: () => onArchiveSession(projectId, s.id, true) },
    {
      label: t("sidebar.deleteSession"),
      danger: true,
      onClick: () => {
        void confirm({
          title: t("sidebar.deleteSessionTitle"),
          message: t("sidebar.deleteSessionMessage", { name: truncateTitle(s.title, 28) }),
          confirmLabel: t("common.delete"),
          destructive: true,
        }).then((ok) => {
          if (ok) onDeleteSession(projectId, s.id);
        });
      },
    },
  ];

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card/40">
      <nav className="flex flex-col gap-0.5 p-2">
        <PetSidebarEntry
          active={viewMode === "pet"}
          pendingCount={petPendingCount}
          runningCount={petRunningCount}
          onOpen={onOpenPetPage}
        />
        <div className="my-1 border-t border-border/70" aria-hidden="true" />
        <SidebarItem
          label={t("sidebar.newConversation")}
          Icon={MessageSquare}
          onClick={onNewConversation}
          active={false}
        />
        <SidebarItem
          label={t("sidebar.search")}
          Icon={Search}
          onClick={onOpenSearch}
          active={false}
        />
        {/* NOTE: this list used to be hardcoded; the GLOBAL pending-approvals
            badge history note from the automation item still applies — the
            per-session asking dot + dock badge (setBadgeCount) cover it. */}
        {navPages.map((entry) => (
          <SidebarItem
            key={entry.key}
            label={pageEntryTitle(entry, (key) => t(key as never))}
            Icon={entry.icon}
            onClick={() => onNavigate(entry.nav!.target)}
            active={entry.nav!.isActive(viewMode)}
          />
        ))}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("sidebar.projects")}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 text-muted-foreground"
            onClick={onAddProject}
            aria-label={t("sidebar.addProject")}
            title={t("sidebar.addProject")}
          >
            <Plus size={16} strokeWidth={2.25} />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {orderedProjects.length === 0 && noRepoSessions.length === 0 && (
            <div className="mx-1 rounded-lg border border-dashed border-border px-3 py-4 text-center">
              <FolderOpen className="mx-auto size-5 text-muted-foreground" aria-hidden />
              <p className="mt-2 text-xs font-medium text-foreground">{t("sidebar.emptyTitle")}</p>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {t("sidebar.emptyHint")}
              </p>
              <div className="mt-3 flex flex-col gap-1.5">
                <Button type="button" size="sm" variant="outline" onClick={onAddProject}>
                  <Plus className="size-3.5" aria-hidden />
                  {t("sidebar.addProject")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={onNewConversation}>
                  <MessageSquare className="size-3.5" aria-hidden />
                  {t("sidebar.emptyNewChat")}
                </Button>
              </div>
            </div>
          )}
          {orderedProjects.map((project) => (
            <ProjectGroup
              key={project.id}
              project={project}
              index={sessions[project.id]}
              collapsed={collapsedProjects.has(project.id)}
              isActiveProject={activeProjectId === project.id}
              activeSessionId={activeSessionId}
              statusFor={(sid) => sessionStatuses?.[bucketKey(project.id, sid)]}
              onToggle={() => onToggleProject(project.id)}
              onSelectProject={() => onSelectProject(project.id)}
              onSelectSession={(sid) => onSelectSession(project.id, sid)}
              onMenuClick={(x, y) => setMenu({ kind: "project", x, y, project })}
              onNewChat={() => onNewConversationForProject(project.id)}
              onProjectContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: "project", x: e.clientX, y: e.clientY, project });
              }}
              onSessionContextMenu={(e, s) => {
                e.preventDefault();
                setMenu({
                  kind: "session",
                  x: e.clientX,
                  y: e.clientY,
                  projectId: project.id,
                  session: s,
                });
              }}
              onArchiveSession={(sid) => onArchiveSession(project.id, sid, true)}
              workspaceChange={workspaceChange}
            />
          ))}

          {noRepoSessions.length > 0 && (
            <NoRepoSection
              sessions={noRepoSessions}
              activeSessionId={activeProjectId === null ? activeSessionId : null}
              statusFor={(sid) => sessionStatuses?.[bucketKey(null, sid)]}
              onSelectSession={(sid) => onSelectSession(null, sid)}
              onSessionContextMenu={(e, s) => {
                e.preventDefault();
                setMenu({
                  kind: "session",
                  x: e.clientX,
                  y: e.clientY,
                  projectId: null,
                  session: s,
                });
              }}
              onArchiveSession={(sid) => onArchiveSession(null, sid, true)}
            />
          )}

          {(sessionHistoryLoading || hasMoreSessionHistory) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="my-2 w-full gap-1.5 text-muted-foreground disabled:cursor-wait"
              onClick={onLoadMoreSessionHistory}
              disabled={sessionHistoryLoading}
            >
              {sessionHistoryLoading && <Loader2 size={12} className="animate-spin" />}
              {t(
                sessionHistoryLoading
                  ? "sidebar.loadingSessionHistory"
                  : "sidebar.loadSessionHistory",
              )}
            </Button>
          )}
        </div>
      </div>

      <div className="border-t border-border p-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <SettingsMenu
              onOpenSettingsPage={onOpenSettingsPage}
              sidebarCollapsed={sidebarCollapsed}
              petWidgetVisible={petWidgetVisible}
              onTogglePetWidget={onTogglePetWidget}
            />
          </div>
          <SidebarUpdaterButton />
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={
            menu.kind === "project"
              ? projectMenu(menu.project)
              : sessionMenu(menu.projectId, menu.session)
          }
        />
      )}
    </aside>
  );
}

function SidebarItem({
  label,
  Icon,
  onClick,
  active,
  badge,
}: {
  label: string;
  Icon: React.ComponentType<{ size?: number }>;
  onClick: () => void;
  active: boolean;
  badge?: number;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className={cn(
        "h-8 w-full justify-start gap-2 px-2 text-sm font-normal",
        active ? "bg-accent font-medium text-foreground" : "text-muted-foreground",
      )}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <Icon size={14} />
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && <Badge count={badge} />}
    </Button>
  );
}

export function worktreeBranchOf(workspace: SessionWorkspace | undefined): string | undefined {
  return workspace?.kind === "worktree" ? workspace.worktree?.branch : undefined;
}

export function sessionRowHoverTitle(
  title: string,
  worktreeBranch: string | undefined,
  branchDescription: string | undefined,
): string {
  return worktreeBranch && branchDescription ? `${title}\n${branchDescription}` : title;
}

function useVisibleWorktreeBranches(
  projectPath: string,
  sessions: SessionSummary[],
  workspaceChange: WorkspaceChangeEvent | null,
): Record<string, string> {
  const requestVersions = useRef(new Map<string, number>());
  const [branches, setBranches] = useState<Record<string, string>>({});
  const engineSessionIds = useMemo(
    () => sessions.flatMap((session) => (session.engineSessionId ? [session.engineSessionId] : [])),
    [sessions],
  );

  const commitWorkspace = useCallback((sessionId: string, workspace: SessionWorkspace) => {
    const branch = worktreeBranchOf(workspace);
    setBranches((current) => {
      if (branch && current[sessionId] === branch) return current;
      if (!branch && current[sessionId] === undefined) return current;
      const next = { ...current };
      if (branch) next[sessionId] = branch;
      else delete next[sessionId];
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const visible = new Set(engineSessionIds);
    setBranches((current) =>
      Object.fromEntries(Object.entries(current).filter(([sessionId]) => visible.has(sessionId))),
    );

    for (const sessionId of engineSessionIds) {
      const version = (requestVersions.current.get(sessionId) ?? 0) + 1;
      requestVersions.current.set(sessionId, version);
      void window.codeshell
        .getSessionWorkspace(sessionId, projectPath)
        .then((workspace) => {
          if (cancelled || requestVersions.current.get(sessionId) !== version) return;
          commitWorkspace(sessionId, workspace);
        })
        .catch(() => {
          // Legacy/missing engine sessions simply have no worktree marker.
        });
    }

    return () => {
      cancelled = true;
    };
  }, [commitWorkspace, engineSessionIds, projectPath]);

  useEffect(() => {
    if (!workspaceChange || !engineSessionIds.includes(workspaceChange.sessionId)) return;
    const { sessionId, workspace } = workspaceChange;
    const version = (requestVersions.current.get(sessionId) ?? 0) + 1;
    requestVersions.current.set(sessionId, version);
    if (workspace) {
      commitWorkspace(sessionId, workspace);
      return;
    }
    void window.codeshell
      .getSessionWorkspace(sessionId, projectPath)
      .then((next) => {
        if (requestVersions.current.get(sessionId) !== version) return;
        commitWorkspace(sessionId, next);
      })
      .catch(() => {});
  }, [commitWorkspace, engineSessionIds, projectPath, workspaceChange]);

  return branches;
}

function ProjectGroup({
  project,
  index,
  collapsed,
  isActiveProject,
  activeSessionId,
  statusFor,
  onToggle,
  onSelectProject,
  onSelectSession,
  onMenuClick,
  onNewChat,
  onProjectContextMenu,
  onSessionContextMenu,
  onArchiveSession,
  workspaceChange,
}: {
  project: TrackedProject;
  index: SessionIndex | undefined;
  collapsed: boolean;
  isActiveProject: boolean;
  activeSessionId: string | null;
  statusFor: (sid: string) => SessionStatus | undefined;
  onToggle: () => void;
  onSelectProject: () => void;
  onSelectSession: (sid: string) => void;
  onMenuClick: (x: number, y: number) => void;
  onNewChat: () => void;
  onProjectContextMenu: (e: React.MouseEvent) => void;
  onSessionContextMenu: (e: React.MouseEvent, s: SessionSummary) => void;
  onArchiveSession: (sid: string) => void;
  workspaceChange: WorkspaceChangeEvent | null;
}) {
  const { t } = useT();
  const [showMore, setShowMore] = useState(false);

  const all = index?.sessions ?? [];
  const live = useMemo(() => all.filter((s) => !s.archived), [all]);

  const visibleLive = useMemo(
    () =>
      compactSidebarSessions(
        live,
        isActiveProject ? activeSessionId : null,
        showMore,
        COMPACT_SESSION_LIMIT,
      ),
    [activeSessionId, isActiveProject, live, showMore],
  );
  const hiddenLiveCount = Math.max(0, live.length - visibleLive.length);
  const workspaceSessions = useMemo(() => (collapsed ? [] : visibleLive), [collapsed, visibleLive]);
  const worktreeBranches = useVisibleWorktreeBranches(
    project.path,
    workspaceSessions,
    workspaceChange,
  );

  return (
    <div className="mb-1">
      <div
        className={cn(
          "group flex items-center gap-1 rounded-md px-1 text-sm",
          isActiveProject ? "bg-accent" : "hover:bg-accent/60",
        )}
        onContextMenu={onProjectContextMenu}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 min-w-0 flex-1 justify-start gap-1.5 px-1 hover:bg-transparent"
          aria-expanded={!collapsed}
          onClick={() => {
            onSelectProject();
            onToggle();
          }}
        >
          {collapsed ? (
            <Folder size={13} className="shrink-0 text-muted-foreground" />
          ) : (
            <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
          )}
          <span className="flex-1 truncate text-left font-medium">{projectLabel(project)}</span>
          {project.pinned && (
            <span className="text-primary" title={t("sidebar.pinned")}>
              ·
            </span>
          )}
        </Button>
        <span className="flex items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:bg-background"
            aria-label={t("common.more")}
            title={t("common.more")}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onMenuClick(r.left, r.bottom + 2);
            }}
          >
            <MoreHorizontal size={13} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 text-muted-foreground hover:bg-background"
            aria-label={t("sidebar.newChatIn", { name: projectLabel(project) })}
            title={t("sidebar.newChatIn", { name: projectLabel(project) })}
            onClick={(e) => {
              e.stopPropagation();
              onNewChat();
            }}
          >
            <PenSquare size={13} />
          </Button>
        </span>
      </div>

      {!collapsed && (
        <>
          {live.length > 0 && (
            <ul className="ml-3 mt-0.5 space-y-0.5 pl-2">
              {visibleLive.map((s, i) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  isActive={isActiveProject && activeSessionId === s.id}
                  status={statusFor(s.id)}
                  worktreeBranch={
                    s.engineSessionId ? worktreeBranches[s.engineSessionId] : undefined
                  }
                  showKbd={isActiveProject && i < 5}
                  kbdIndex={i + 1}
                  onClick={() => onSelectSession(s.id)}
                  onContextMenu={(e) => onSessionContextMenu(e, s)}
                  onArchive={() => onArchiveSession(s.id)}
                />
              ))}
              {hiddenLiveCount > 0 && !showMore && (
                <li>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 w-full justify-between px-2 text-xs text-primary"
                    onClick={() => setShowMore(true)}
                  >
                    <span>{t("common.expand")}</span>
                    <span className="text-muted-foreground">{hiddenLiveCount}</span>
                  </Button>
                </li>
              )}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

/**
 * No-repo "对话" section pinned at the bottom of the projects list.
 * Sessions here ran without a cwd; we render them flat (no folder
 * chrome) so users distinguish them at a glance from project sessions.
 */
function NoRepoSection({
  sessions,
  activeSessionId,
  statusFor,
  onSelectSession,
  onSessionContextMenu,
  onArchiveSession,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  statusFor: (sid: string) => SessionStatus | undefined;
  onSelectSession: (sid: string) => void;
  onSessionContextMenu: (e: React.MouseEvent, s: SessionSummary) => void;
  onArchiveSession: (sid: string) => void;
}) {
  const { t } = useT();
  if (sessions.length === 0) return null;
  return (
    <div className="mt-2">
      <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {t("sidebar.conversations")}
      </div>
      <ul className="space-y-0.5">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            isActive={activeSessionId === s.id}
            status={statusFor(s.id)}
            showKbd={false}
            kbdIndex={0}
            onClick={() => onSelectSession(s.id)}
            onContextMenu={(e) => onSessionContextMenu(e, s)}
            onArchive={() => onArchiveSession(s.id)}
          />
        ))}
      </ul>
    </div>
  );
}

function SessionRow({
  s,
  isActive,
  status,
  worktreeBranch,
  showKbd,
  kbdIndex,
  onClick,
  onContextMenu,
  onArchive,
}: {
  s: SessionSummary;
  isActive: boolean;
  status?: SessionStatus;
  worktreeBranch?: string;
  showKbd: boolean;
  kbdIndex: number;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onArchive?: () => void;
}) {
  const { t, lang } = useT();
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const armConfirm = (e: React.MouseEvent): void => {
    e.stopPropagation();
    setConfirming(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    // Auto-revert if the user wanders off — same "tap twice or it cancels"
    // pattern as the screenshot reference.
    timerRef.current = setTimeout(() => setConfirming(false), 2500);
  };

  const fireArchive = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (timerRef.current) clearTimeout(timerRef.current);
    setConfirming(false);
    onArchive?.();
  };

  return (
    <li
      className={cn(
        "group flex items-center gap-1 rounded-md px-1 text-sm",
        isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
        s.archived && "opacity-60",
      )}
      onContextMenu={onContextMenu}
      onMouseLeave={() => {
        if (confirming) {
          if (timerRef.current) clearTimeout(timerRef.current);
          setConfirming(false);
        }
      }}
      title={sessionRowHoverTitle(
        s.title,
        worktreeBranch,
        worktreeBranch ? t("sidebar.worktreeBranch", { branch: worktreeBranch }) : undefined,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 min-w-0 flex-1 justify-start gap-1.5 px-1 font-normal hover:bg-transparent"
        aria-current={isActive ? "page" : undefined}
        onClick={onClick}
      >
        {s.source === "automation" && (
          <Clock
            className="h-3 w-3 shrink-0 text-muted-foreground"
            aria-label={t("sidebar.automationLabel")}
          />
        )}
        {worktreeBranch && (
          <GitBranch
            className="h-3 w-3 shrink-0 text-primary"
            aria-label={t("sidebar.worktreeBranch", { branch: worktreeBranch })}
          />
        )}
        <span className="flex-1 truncate text-left">{s.title}</span>
        {status === "running" ? (
          <Loader2
            className="h-3 w-3 shrink-0 animate-spin text-status-running"
            aria-label={t("sidebar.sessionRunning")}
          />
        ) : status === "asking" ? (
          <span
            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary"
            aria-label={t("sidebar.sessionAsking")}
            role="img"
          />
        ) : status === "unread" ? (
          <span
            className="h-2 w-2 shrink-0 rounded-full bg-primary"
            aria-label={t("sidebar.sessionUnread")}
            role="img"
          />
        ) : null}
      </Button>
      <span className="relative flex shrink-0 items-center">
        {confirming ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5 text-xs text-status-err hover:bg-background"
            onClick={fireArchive}
            aria-label={t("sidebar.confirmArchive")}
            title={t("sidebar.confirmArchive")}
          >
            {t("common.confirm")}
          </Button>
        ) : (
          <>
            {/* Shortcut / relative-time badge sits in normal flow and defines
                the slot width. */}
            {showKbd ? (
              <kbd className="rounded bg-muted px-1 text-[10px] text-muted-foreground">
                ⌘{kbdIndex}
              </kbd>
            ) : (
              <span className="text-[10px] text-muted-foreground">
                {formatRelative(s.updatedAt, lang)}
              </span>
            )}
            {/* Archive action overlays the badge on hover (absolute, right-
                anchored) so it covers the shortcut instead of pushing it. */}
            {onArchive && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute right-0 size-6 bg-accent text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={armConfirm}
                aria-label={t("common.archive")}
                title={t("common.archive")}
              >
                <Archive size={12} />
              </Button>
            )}
          </>
        )}
      </span>
    </li>
  );
}

export function formatRelative(ts: number, lang: "zh" | "en", now = Date.now()): string {
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  const locale = lang === "zh" ? "zh-CN" : "en";
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
  if (sec < 60) return formatter.format(-sec, "second");
  const min = Math.floor(sec / 60);
  if (min < 60) return formatter.format(-min, "minute");
  const hr = Math.floor(min / 60);
  if (hr < 24) return formatter.format(-hr, "hour");
  const day = Math.floor(hr / 24);
  if (day < 30) return formatter.format(-day, "day");
  const month = Math.floor(day / 30);
  if (month < 12) return formatter.format(-month, "month");
  const year = Math.floor(day / 365);
  return formatter.format(-year, "year");
}
