import React, { useMemo, useState } from "react";
import {
  MessageSquare,
  Search,
  Puzzle,
  Workflow,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  MoreHorizontal,
  PenSquare,
} from "lucide-react";
import { Badge } from "./ui/Badge";
import { ContextMenu, type ContextMenuItem } from "./ui/ContextMenu";
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
  onOpenPlugins: () => void;
  onOpenApprovals: () => void;
  onOpenRuns: () => void;
  onOpenLogs: () => void;
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
  onOpenPlugins,
  onOpenApprovals,
  onOpenRuns,
  onOpenLogs,
  onOpenSettingsPage,
  onRenameSession,
  onArchiveSession,
  onDeleteSession,
  activeRepoPath,
  viewMode,
}: SidebarProps) {
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const closeMenu = (): void => setMenu(null);

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
      label: "创建永久工作树",
      // Worktree wiring lands in a later batch; show the entry now so
      // users see the intent, but no-op until the IPC is in place.
      disabled: true,
      onClick: () => undefined,
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
        if (confirm(`归档「${repoLabel(repo)}」下所有 ${live} 条未归档会话？`)) {
          onArchiveAllSessions(repo.id);
        }
      },
    },
    {
      label: "移除",
      danger: true,
      onClick: () => {
        if (confirm(`确定从侧栏移除「${repoLabel(repo)}」吗？\n本地会话保留 — 重新添加同一目录可恢复。`)) {
          onRemoveRepo(repo.id);
        }
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
    s.archived
      ? { label: "恢复", onClick: () => onArchiveSession(repoId, s.id, false) }
      : { label: "归档", onClick: () => onArchiveSession(repoId, s.id, true) },
    {
      label: "删除",
      danger: true,
      onClick: () => {
        if (confirm(`确定删除会话「${s.title}」吗？`)) onDeleteSession(repoId, s.id);
      },
    },
  ];

  return (
    <aside className="sidebar sidebar-v2">
      <nav className="sidebar-top">
        <SidebarItem label="新对话" Icon={MessageSquare} onClick={onNewConversation} active={false} />
        <SidebarItem label="搜索" Icon={Search} onClick={onOpenSearch} active={false} />
        <SidebarItem label="插件" Icon={Puzzle} onClick={onOpenPlugins} active={viewMode === "mcp"} />
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
            className="sidebar-section-add"
            onClick={onAddRepo}
            aria-label="添加项目"
            title="添加项目"
          >
            <FolderPlus size={13} />
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
            />
          )}
        </div>
      </div>

      <div className="sidebar-bottom">
        <SettingsMenu
          activeRepoPath={activeRepoPath}
          onOpenApprovals={onOpenApprovals}
          onOpenRuns={onOpenRuns}
          onOpenLogs={onOpenLogs}
          onOpenSettingsPage={onOpenSettingsPage}
        />
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
}) {
  const [showMore, setShowMore] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const all = index?.sessions ?? [];
  const live = useMemo(() => all.filter((s) => !s.archived), [all]);
  const archived = useMemo(() => all.filter((s) => s.archived), [all]);

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
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
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

          {archived.length > 0 && (
            <div className="archived-group">
              <button
                className="archived-toggle"
                onClick={() => setShowArchived((v) => !v)}
              >
                {showArchived ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                <span>已归档</span>
                <span className="archived-count">{archived.length}</span>
              </button>
              {showArchived && (
                <ul className="session-list session-list-archived">
                  {archived.map((s) => (
                    <SessionRow
                      key={s.id}
                      s={s}
                      isActive={isActiveRepo && activeSessionId === s.id}
                      showKbd={false}
                      kbdIndex={0}
                      onClick={() => onSelectSession(s.id)}
                      onContextMenu={(e) => onSessionContextMenu(e, s)}
                    />
                  ))}
                </ul>
              )}
            </div>
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
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  onSelectSession: (sid: string) => void;
  onSessionContextMenu: (e: React.MouseEvent, s: SessionSummary) => void;
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
}: {
  s: SessionSummary;
  isActive: boolean;
  showKbd: boolean;
  kbdIndex: number;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  return (
    <li
      className={`session-row${isActive ? " active" : ""}${s.archived ? " archived" : ""}`}
      onClick={onClick}
      onContextMenu={onContextMenu}
      title={s.title}
    >
      <span className="session-title">{s.title}</span>
      <span className="session-meta-right">
        {showKbd ? (
          <kbd className="session-kbd">⌘{kbdIndex}</kbd>
        ) : (
          <span className="session-time">{formatRelative(s.updatedAt)}</span>
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
