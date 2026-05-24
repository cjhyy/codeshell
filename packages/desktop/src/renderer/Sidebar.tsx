import React, { useMemo, useState } from "react";
import {
  MessageSquare,
  Search,
  Puzzle,
  Workflow,
  Settings as SettingsIcon,
  ChevronDown,
  ChevronRight,
  Folder,
  X,
  FolderPlus,
} from "lucide-react";
import { Badge } from "./ui/Badge";
import type { ViewMode } from "./view";
import type { Repo } from "./repos";
import type { SessionIndex } from "./transcripts";

interface SidebarProps {
  repos: Repo[];
  /** Session index per repo (keyed by repoKey = repoId or "__global__"). */
  sessions: Record<string, SessionIndex>;
  activeRepoId: string | null;
  activeSessionId: string | null;
  /** Repos collapsed in the project list (UI state lives in App). */
  collapsedRepos: Set<string>;
  approvalsBadge?: number;
  onSelectRepo: (id: string) => void;
  onSelectSession: (repoId: string | null, sessionId: string) => void;
  onToggleRepo: (id: string) => void;
  onAddRepo: () => void;
  onRemoveRepo: (id: string) => void;
  onNewConversation: () => void;
  onOpenSearch: () => void;
  onOpenAutomations: () => void;
  onOpenPlugins: () => void;
  onOpenSettings: () => void;
  viewMode: ViewMode;
}

const COMPACT_SESSION_LIMIT = 5;

/**
 * Project-first sidebar.
 *
 * Top:    workflow shortcuts (new conversation / search / plugins / automations)
 * Middle: 项目 — collapsible folder rows, sessions nested below
 * Bottom: 设置 pinned to the floor
 */
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
  onNewConversation,
  onOpenSearch,
  onOpenAutomations,
  onOpenPlugins,
  onOpenSettings,
  viewMode,
}: SidebarProps) {
  return (
    <aside className="sidebar sidebar-v2">
      <nav className="sidebar-top">
        <SidebarItem
          label="新对话"
          Icon={MessageSquare}
          onClick={onNewConversation}
          active={false}
        />
        <SidebarItem
          label="搜索"
          Icon={Search}
          onClick={onOpenSearch}
          active={false}
        />
        <SidebarItem
          label="插件"
          Icon={Puzzle}
          onClick={onOpenPlugins}
          active={viewMode === "mcp"}
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
            className="sidebar-section-add"
            onClick={onAddRepo}
            aria-label="添加项目"
            title="添加项目"
          >
            <FolderPlus size={13} />
          </button>
        </div>

        <div className="sidebar-projects">
          {repos.length === 0 && (
            <div className="repo-empty">点 + 添加你的第一个 repo</div>
          )}
          {repos.map((repo) => (
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
              onRemove={() => onRemoveRepo(repo.id)}
            />
          ))}
        </div>
      </div>

      <div className="sidebar-bottom">
        <SidebarItem
          label="设置"
          Icon={SettingsIcon}
          onClick={onOpenSettings}
          active={viewMode === "settings"}
        />
      </div>
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
  onRemove,
}: {
  repo: Repo;
  index: SessionIndex | undefined;
  collapsed: boolean;
  isActiveRepo: boolean;
  activeSessionId: string | null;
  onToggle: () => void;
  onSelectRepo: () => void;
  onSelectSession: (sid: string) => void;
  onRemove: () => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const sessions = index?.sessions ?? [];
  const visible = useMemo(
    () => (showMore ? sessions : sessions.slice(0, COMPACT_SESSION_LIMIT)),
    [sessions, showMore],
  );
  const hasMore = sessions.length > COMPACT_SESSION_LIMIT && !showMore;

  return (
    <div className="project-group">
      <div
        className={`project-row${isActiveRepo ? " selected" : ""}`}
        onClick={() => {
          onSelectRepo();
          if (collapsed) onToggle();
        }}
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
        <span className="project-name">{repo.name}</span>
        <button
          className="project-remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          aria-label="移除"
          title="移除项目"
        >
          <X size={11} />
        </button>
      </div>

      {!collapsed && sessions.length > 0 && (
        <ul className="session-list">
          {visible.map((s, i) => (
            <li
              key={s.id}
              className={`session-row${activeSessionId === s.id && isActiveRepo ? " active" : ""}`}
              onClick={() => onSelectSession(s.id)}
              title={s.title}
            >
              <span className="session-title">{s.title}</span>
              <span className="session-meta-right">
                {isActiveRepo && i < 5 ? (
                  <kbd className="session-kbd">⌘{i + 1}</kbd>
                ) : (
                  <span className="session-time">{formatRelative(s.updatedAt)}</span>
                )}
              </span>
            </li>
          ))}
          {hasMore && (
            <li
              className="session-row session-row-more"
              onClick={() => setShowMore(true)}
            >
              <span className="session-title">展开显示</span>
              <span className="session-meta-right">
                {sessions.length - COMPACT_SESSION_LIMIT}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
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
