import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Search,
  Blocks,
  Workflow,
  ChevronDown,
  ChevronRight,
  Folder,
  Plus,
  MoreHorizontal,
  PenSquare,
  Archive,
  Clock,
} from "lucide-react";
import { Badge } from "./ui/Badge";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu";
import { useConfirm, truncateTitle } from "./ui/ConfirmDialog";
import { SettingsMenu } from "./settings/SettingsMenu";
import type { ViewMode } from "./view";
import { repoLabel, sortRepos, type Repo } from "./repos";
import { NO_REPO_KEY, type SessionIndex, type SessionSummary } from "./transcripts";

interface SidebarProps {
  repos: Repo[];
  sessions: Record<string, SessionIndex>;
  activeRepoId: string | null;
  activeSessionId: string | null;
  collapsedRepos: Set<string>;
  approvalsBadge?: number;
  sidebarCollapsed?: boolean;

  onSelectRepo: (id: string | null) => void;
  onSelectSession: (repoId: string | null, sessionId: string) => void;
  onToggleRepo: (id: string) => void;
  onAddRepo: () => void;
  onRemoveRepo: (id: string) => void;
  onPinRepo: (id: string, pinned: boolean) => void;
  onRenameRepo: (id: string, name: string) => void;
  onArchiveAllSessions: (id: string) => void;
  onNewConversationForRepo: (id: string | null) => void;

  onNewConversation: () => void;
  onOpenSearch: () => void;
  onOpenAutomations: () => void;
  onOpenCustomize: () => void;
  onOpenSettingsPage: () => void;

  onRenameSession: (repoId: string | null, sessionId: string, title: string) => void;
  onArchiveSession: (repoId: string | null, sessionId: string, archived: boolean) => void;
  onDeleteSession: (repoId: string | null, sessionId: string) => void;

  activeRepoPath: string | null;
  viewMode: ViewMode;
}

const COMPACT_SESSION_LIMIT = 5;

type MenuTarget =
  | { kind: "repo"; x: number; y: number; repo: Repo }
  | { kind: "session"; x: number; y: number; repoId: string | null; session: SessionSummary };

export function Sidebar({
  repos,
  sessions,
  activeRepoId,
  activeSessionId,
  collapsedRepos,
  approvalsBadge,
  sidebarCollapsed,
  onSelectRepo,
  onSelectSession,
  onToggleRepo,
  onAddRepo,
  onRemoveRepo,
  onPinRepo,
  onRenameRepo,
  onArchiveAllSessions,
  onNewConversationForRepo,
  onNewConversation,
  onOpenSearch,
  onOpenAutomations,
  onOpenCustomize,
  onOpenSettingsPage,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  activeRepoPath,
  viewMode,
}: SidebarProps) {
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const closeMenu = (): void => setMenu(null);
  const confirm = useConfirm();

  // Pin sort (sortRepos: pinned first, then by addedAt asc).
  const orderedRepos = useMemo(() => sortRepos(repos), [repos]);

  // No-repo conversations live under the bottom 对话 section.
  const noRepoIndex = sessions[NO_REPO_KEY];
  const noRepoSessions = noRepoIndex?.sessions.filter((s) => !s.archived) ?? [];

  const repoMenu = (repo: Repo): ContextMenuItem[] => [
    {
      label: repo.pinned ? "取消置顶" : "置顶项目",
      onClick: () => onPinRepo(repo.id, !repo.pinned),
    },
    {
      label: "在「访达」中打开",
      onClick: () => { void window.codeshell.revealInFinder(repo.path); },
    },
    {
      label: "重命名项目…",
      onClick: () => {
        const t = prompt("项目显示名称", repoLabel(repo));
        if (t !== null && t.trim()) onRenameRepo(repo.id, t.trim());
      },
    },
    {
      label: "归档对话",
      onClick: () => {
        const live = sessions[repo.id]?.sessions.filter((s) => !s.archived).length ?? 0;
        if (live === 0) return;
        void confirm({
          title: "归档项目对话",
          message: `归档「${truncateTitle(repoLabel(repo), 24)}」下所有 ${live} 条未归档会话？`,
          confirmLabel: "归档",
        }).then((ok) => {
          if (ok) onArchiveAllSessions(repo.id);
        });
      },
    },
    {
      label: "移除",
      danger: true,
      onClick: () => {
        void confirm({
          title: "从侧栏移除项目",
          message: `确定从侧栏移除「${truncateTitle(repoLabel(repo), 24)}」吗？`,
          detail: "本地会话保留 — 重新添加同一目录可恢复。",
          confirmLabel: "移除",
          destructive: true,
        }).then((ok) => {
          if (ok) onRemoveRepo(repo.id);
        });
      },
    },
  ];

  const sessionMenu = (repoId: string | null, s: SessionSummary): ContextMenuItem[] => [
    {
      label: "重命名…",
      onClick: () => {
        const t = prompt("会话标题", s.title);
        if (t !== null && t.trim()) onRenameSession(repoId, s.id, t.trim());
      },
    },
    {
      label: "复制 session ID",
      onClick: () => {
        void navigator.clipboard.writeText(s.id);
      },
    },
    s.archived
      ? { label: "恢复", onClick: () => onArchiveSession(repoId, s.id, false) }
      : { label: "归档", onClick: () => onArchiveSession(repoId, s.id, true) },
    {
      label: "删除",
      danger: true,
      onClick: () => {
        void confirm({
          title: "删除会话",
          message: `确定删除会话「${truncateTitle(s.title, 28)}」吗？`,
          confirmLabel: "删除",
          destructive: true,
        }).then((ok) => {
          if (ok) onDeleteSession(repoId, s.id);
        });
      },
    },
  ];

  return (
    <aside className="sidebar sidebar-v2">
      <nav className="sidebar-top">
        <SidebarItem label="新对话" Icon={MessageSquare} onClick={onNewConversation} active={false} />
        <SidebarItem label="搜索" Icon={Search} onClick={onOpenSearch} active={false} />
        <SidebarItem
          label="扩展"
          Icon={Blocks}
          onClick={onOpenCustomize}
          active={viewMode === "customize"}
        />
        <SidebarItem
          label="自动化"
          Icon={Workflow}
          onClick={onOpenAutomations}
          active={viewMode === "runs"}
          badge={approvalsBadge}
        />
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-section-head">
          <span className="sidebar-section-label">项目</span>
          <button
            type="button"
            className="sidebar-section-add"
            onClick={onAddRepo}
            aria-label="添加项目"
            title="添加项目"
          >
            <Plus size={16} strokeWidth={2.25} />
          </button>
        </div>

        <div className="sidebar-projects">
          {orderedRepos.length === 0 && noRepoSessions.length === 0 && (
            <div className="repo-empty">点 + 添加你的第一个 repo</div>
          )}
          {orderedRepos.map((repo) => (
            <ProjectGroup
              key={repo.id}
              repo={repo}
              index={sessions[repo.id]}
              collapsed={collapsedRepos.has(repo.id)}
              isActiveRepo={activeRepoId === repo.id}
              activeSessionId={activeSessionId}
              onToggle={() => onToggleRepo(repo.id)}
              onSelectRepo={() => onSelectRepo(repo.id)}
              onSelectSession={(sid) => onSelectSession(repo.id, sid)}
              onMenuClick={(x, y) => setMenu({ kind: "repo", x, y, repo })}
              onNewChat={() => onNewConversationForRepo(repo.id)}
              onRepoContextMenu={(e) => {
                e.preventDefault();
                setMenu({ kind: "repo", x: e.clientX, y: e.clientY, repo });
              }}
              onSessionContextMenu={(e, s) => {
                e.preventDefault();
                setMenu({ kind: "session", x: e.clientX, y: e.clientY, repoId: repo.id, session: s });
              }}
              onArchiveSession={(sid) => onArchiveSession(repo.id, sid, true)}
            />
          ))}

          {noRepoSessions.length > 0 && (
            <NoRepoSection
              sessions={noRepoSessions}
              activeSessionId={activeRepoId === null ? activeSessionId : null}
              onSelectSession={(sid) => onSelectSession(null, sid)}
              onSessionContextMenu={(e, s) => {
                e.preventDefault();
                setMenu({ kind: "session", x: e.clientX, y: e.clientY, repoId: null, session: s });
              }}
              onArchiveSession={(sid) => onArchiveSession(null, sid, true)}
            />
          )}
        </div>
      </div>

      <div className="sidebar-bottom">
        <SettingsMenu onOpenSettingsPage={onOpenSettingsPage} sidebarCollapsed={sidebarCollapsed} />
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
          items={
            menu.kind === "repo"
              ? repoMenu(menu.repo)
              : sessionMenu(menu.repoId, menu.session)
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
      className={`sidebar-item${active ? " active" : ""}`}
      onClick={onClick}
    >
      <Icon size={14} />
      <span className="sidebar-item-label">{label}</span>
      {badge !== undefined && badge > 0 && <Badge count={badge} />}
    </button>
  );
}

function ProjectGroup({
  repo,
  index,
  collapsed,
  isActiveRepo,
  activeSessionId,
  onToggle,
  onSelectRepo,
  onSelectSession,
  onMenuClick,
  onNewChat,
  onRepoContextMenu,
  onSessionContextMenu,
  onArchiveSession,
}: {
  repo: Repo;
  index: SessionIndex | undefined;
  collapsed: boolean;
  isActiveRepo: boolean;
  activeSessionId: string | null;
  onToggle: () => void;
  onSelectRepo: () => void;
  onSelectSession: (sid: string) => void;
  onMenuClick: (x: number, y: number) => void;
  onNewChat: () => void;
  onRepoContextMenu: (e: React.MouseEvent) => void;
  onSessionContextMenu: (e: React.MouseEvent, s: SessionSummary) => void;
  onArchiveSession: (sid: string) => void;
}) {
  const [showMore, setShowMore] = useState(false);

  const all = index?.sessions ?? [];
  const live = useMemo(() => all.filter((s) => !s.archived), [all]);

  const visibleLive = useMemo(
    () => (showMore ? live : live.slice(0, COMPACT_SESSION_LIMIT)),
    [live, showMore],
  );
  const hiddenLiveCount = Math.max(0, live.length - COMPACT_SESSION_LIMIT);

  return (
    <div className="project-group">
      <div
        className={`project-row${isActiveRepo ? " selected" : ""}${repo.pinned ? " pinned" : ""}`}
        onClick={() => {
          onSelectRepo();
          if (collapsed) onToggle();
        }}
        onContextMenu={onRepoContextMenu}
      >
        <button
          className="project-chevron"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          aria-label={collapsed ? "展开" : "折叠"}
        >
          {collapsed ? <ChevronRight size={14} strokeWidth={2.25} /> : <ChevronDown size={14} strokeWidth={2.25} />}
        </button>
        <Folder size={13} className="project-icon" />
        <span className="project-name">{repoLabel(repo)}</span>
        {repo.pinned && <span className="project-pin-dot" title="已置顶">·</span>}
        <span className="project-row-actions">
          <button
            className="project-row-action"
            aria-label="更多"
            title="更多"
            onClick={(e) => {
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onMenuClick(r.left, r.bottom + 2);
            }}
          >
            <MoreHorizontal size={13} />
          </button>
          <button
            className="project-row-action"
            aria-label={`在 ${repoLabel(repo)} 中开始新对话`}
            title={`在 ${repoLabel(repo)} 中开始新对话`}
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
            <ul className="session-list">
              {visibleLive.map((s, i) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  isActive={isActiveRepo && activeSessionId === s.id}
                  showKbd={isActiveRepo && i < 5}
                  kbdIndex={i + 1}
                  onClick={() => onSelectSession(s.id)}
                  onContextMenu={(e) => onSessionContextMenu(e, s)}
                  onArchive={() => onArchiveSession(s.id)}
                />
              ))}
              {hiddenLiveCount > 0 && !showMore && (
                <li
                  className="session-row session-row-more"
                  onClick={() => setShowMore(true)}
                >
                  <span className="session-title">展开显示</span>
                  <span className="session-meta-right">{hiddenLiveCount}</span>
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
  onSelectSession,
  onSessionContextMenu,
  onArchiveSession,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sid: string) => void;
  onSessionContextMenu: (e: React.MouseEvent, s: SessionSummary) => void;
  onArchiveSession: (sid: string) => void;
}) {
  if (sessions.length === 0) return null;
  return (
    <div className="no-repo-section">
      <div className="sidebar-section-label no-repo-label">对话</div>
      <ul className="session-list no-repo-list">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            s={s}
            isActive={activeSessionId === s.id}
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
  showKbd,
  kbdIndex,
  onClick,
  onContextMenu,
  onArchive,
}: {
  s: SessionSummary;
  isActive: boolean;
  showKbd: boolean;
  kbdIndex: number;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onArchive?: () => void;
}) {
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
      className={`session-row${isActive ? " active" : ""}${s.archived ? " archived" : ""}`}
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
        <Clock className="h-3 w-3 shrink-0 mr-1 text-muted-foreground" aria-label="自动化" />
      )}
      <span className="session-title">{s.title}</span>
      <span className="session-meta-right">
        {confirming ? (
          <button
            className="session-action session-action-confirm"
            onClick={fireArchive}
            aria-label="确认归档"
            title="确认归档"
          >
            确认
          </button>
        ) : (
          <>
            {onArchive && (
              <button
                className="session-action session-action-archive"
                onClick={armConfirm}
                aria-label="归档"
                title="归档"
              >
                <Archive size={12} />
              </button>
            )}
            {showKbd ? (
              <kbd className="session-kbd">⌘{kbdIndex}</kbd>
            ) : (
              <span className="session-time">{formatRelative(s.updatedAt)}</span>
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
