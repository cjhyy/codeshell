import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Search,
  Blocks,
  Workflow,
  KeyRound,
  Folder,
  FolderOpen,
  Plus,
  MoreHorizontal,
  PenSquare,
  Archive,
  Clock,
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
import { projectLabel, sortProjects, type TrackedProject } from "./projects";
import { NO_REPO_KEY, bucketKey, type SessionIndex, type SessionSummary } from "./transcripts";
import type { SessionStatus } from "./sessionStatus";
import { useT } from "./i18n";
import { PetSidebarEntry } from "./pet/PetSidebarEntry";
import { compactSidebarSessions } from "./sidebarSessionVisibility";

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
  onOpenAutomations: () => void;
  onOpenCustomize: () => void;
  onOpenCredentials: () => void;
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
  onOpenAutomations,
  onOpenCustomize,
  onOpenCredentials,
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
  const closeMenu = (): void => setMenu(null);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const toast = useToast();

  // Pin sort (sortProjects: pinned first, then by addedAt asc).
  const orderedProjects = useMemo(() => sortProjects(projects), [projects]);

  // No-repo conversations live under the bottom 对话 section.
  const noRepoIndex = sessions[NO_REPO_KEY];
  const noRepoSessions = noRepoIndex?.sessions.filter((s) => !s.archived) ?? [];

  const projectMenu = (project: TrackedProject): ContextMenuItem[] => [
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
        <SidebarItem
          label={t("sidebar.extensions")}
          Icon={Blocks}
          onClick={onOpenCustomize}
          active={viewMode === "customize"}
        />
        {/* NOTE: this row used to carry the GLOBAL pending-approvals badge (a
            Phase-9 IA leftover) — approvals have nothing to do with 自动化 and
            the misplaced dot confused users. The per-session asking dot + the
            dock icon badge (setBadgeCount) already cover location + count. */}
        <SidebarItem
          label={t("sidebar.automation")}
          Icon={Workflow}
          onClick={onOpenAutomations}
          active={viewMode === "runs"}
        />
        <SidebarItem
          label={t("sidebar.credentials")}
          Icon={KeyRound}
          onClick={onOpenCredentials}
          active={viewMode === "credentials"}
        />
      </nav>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("sidebar.projects")}
          </span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={onAddProject}
            aria-label={t("sidebar.addProject")}
            title={t("sidebar.addProject")}
          >
            <Plus size={16} strokeWidth={2.25} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {orderedProjects.length === 0 && noRepoSessions.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">{t("sidebar.emptyHint")}</div>
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
            <button
              type="button"
              className="my-2 flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground disabled:cursor-wait disabled:opacity-60"
              onClick={onLoadMoreSessionHistory}
              disabled={sessionHistoryLoading}
            >
              {sessionHistoryLoading && <Loader2 size={12} className="animate-spin" />}
              {t(
                sessionHistoryLoading
                  ? "sidebar.loadingSessionHistory"
                  : "sidebar.loadSessionHistory",
              )}
            </button>
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
    <button
      className={
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors " +
        (active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
      }
      onClick={onClick}
    >
      <Icon size={14} />
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && <Badge count={badge} />}
    </button>
  );
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

  return (
    <div className="mb-1">
      <div
        className={
          "group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm " +
          (isActiveProject ? "bg-accent" : "hover:bg-accent/60")
        }
        onClick={() => {
          onSelectProject();
          onToggle();
        }}
        onContextMenu={onProjectContextMenu}
      >
        {collapsed ? (
          <Folder size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate font-medium">{projectLabel(project)}</span>
        {project.pinned && (
          <span className="text-primary" title={t("sidebar.pinned")}>
            ·
          </span>
        )}
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={t("common.more")}
            title={t("common.more")}
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onMenuClick(r.left, r.bottom + 2);
            }}
          >
            <MoreHorizontal size={13} />
          </button>
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
            aria-label={t("sidebar.newChatIn", { name: projectLabel(project) })}
            title={t("sidebar.newChatIn", { name: projectLabel(project) })}
            onClick={(e) => {
              e.stopPropagation();
              onNewChat();
            }}
          >
            <PenSquare size={13} />
          </button>
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
                  showKbd={isActiveProject && i < 5}
                  kbdIndex={i + 1}
                  onClick={() => onSelectSession(s.id)}
                  onContextMenu={(e) => onSessionContextMenu(e, s)}
                  onArchive={() => onArchiveSession(s.id)}
                />
              ))}
              {hiddenLiveCount > 0 && !showMore && (
                <li
                  className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-accent/60"
                  onClick={() => setShowMore(true)}
                >
                  <span>{t("common.expand")}</span>
                  <span className="text-muted-foreground">{hiddenLiveCount}</span>
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
  showKbd,
  kbdIndex,
  onClick,
  onContextMenu,
  onArchive,
}: {
  s: SessionSummary;
  isActive: boolean;
  status?: SessionStatus;
  showKbd: boolean;
  kbdIndex: number;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onArchive?: () => void;
}) {
  const { t } = useT();
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
      className={
        "group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-sm " +
        (isActive ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60") +
        (s.archived ? " opacity-60" : "")
      }
      onClick={onClick}
      onContextMenu={onContextMenu}
      onMouseLeave={() => {
        if (confirming) {
          if (timerRef.current) clearTimeout(timerRef.current);
          setConfirming(false);
        }
      }}
      title={s.title}
    >
      {s.source === "automation" && (
        <Clock
          className="h-3 w-3 shrink-0 text-muted-foreground"
          aria-label={t("sidebar.automationLabel")}
        />
      )}
      <span className="flex-1 truncate">{s.title}</span>
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
      <span className="relative flex shrink-0 items-center">
        {confirming ? (
          <button
            className="rounded px-1.5 text-xs text-status-err hover:bg-background"
            onClick={fireArchive}
            aria-label={t("sidebar.confirmArchive")}
            title={t("sidebar.confirmArchive")}
          >
            {t("common.confirm")}
          </button>
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
                {formatRelative(s.updatedAt)}
              </span>
            )}
            {/* Archive action overlays the badge on hover (absolute, right-
                anchored) so it covers the shortcut instead of pushing it. */}
            {onArchive && (
              <button
                className="absolute right-0 rounded bg-accent p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                onClick={armConfirm}
                aria-label={t("common.archive")}
                title={t("common.archive")}
              >
                <Archive size={12} />
              </button>
            )}
          </>
        )}
      </span>
    </li>
  );
}

function formatRelative(ts: number): string {
  const delta = Date.now() - ts;
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return `${sec}秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}小时`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}天`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month}月`;
  const year = Math.floor(day / 365);
  return `${year}年`;
}
