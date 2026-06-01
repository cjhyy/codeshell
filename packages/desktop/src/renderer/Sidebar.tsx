import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  MessageSquare,
  Search,
  Blocks,
  Workflow,
  Folder,
  FolderOpen,
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
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-border bg-card/40">
      <nav className="flex flex-col gap-0.5 p-2">
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

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">项目</span>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground"
            onClick={onAddRepo}
            aria-label="添加项目"
            title="添加项目"
          >
            <Plus size={16} strokeWidth={2.25} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2">
          {orderedRepos.length === 0 && noRepoSessions.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">点 + 添加你的第一个 repo</div>
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

      <div className="border-t border-border p-2">
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
    <div className="mb-1">
      <div
        className={
          "group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-sm " +
          (isActiveRepo ? "bg-accent" : "hover:bg-accent/60")
        }
        onClick={() => {
          onSelectRepo();
          onToggle();
        }}
        onContextMenu={onRepoContextMenu}
      >
        {collapsed ? (
          <Folder size={13} className="shrink-0 text-muted-foreground" />
        ) : (
          <FolderOpen size={13} className="shrink-0 text-muted-foreground" />
        )}
        <span className="flex-1 truncate font-medium">{repoLabel(repo)}</span>
        {repo.pinned && <span className="text-primary" title="已置顶">·</span>}
        <span className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
          <button
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
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
            className="rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
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
            <ul className="ml-3 mt-0.5 space-y-0.5 pl-2">
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
                  className="flex cursor-pointer items-center justify-between rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-accent/60"
                  onClick={() => setShowMore(true)}
                >
                  <span>展开显示</span>
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
    <div className="mt-2">
      <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">对话</div>
      <ul className="space-y-0.5">
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
        <Clock className="h-3 w-3 shrink-0 text-muted-foreground" aria-label="自动化" />
      )}
      <span className="flex-1 truncate">{s.title}</span>
      <span className="relative flex shrink-0 items-center">
        {confirming ? (
          <button
            className="rounded px-1.5 text-xs text-status-err hover:bg-background"
            onClick={fireArchive}
            aria-label="确认归档"
            title="确认归档"
          >
            确认
          </button>
        ) : (
          <>
            {/* Shortcut / relative-time badge sits in normal flow and defines
                the slot width. */}
            {showKbd ? (
              <kbd className="rounded bg-muted px-1 text-[10px] text-muted-foreground">⌘{kbdIndex}</kbd>
            ) : (
              <span className="text-[10px] text-muted-foreground">{formatRelative(s.updatedAt)}</span>
            )}
            {/* Archive action overlays the badge on hover (absolute, right-
                anchored) so it covers the shortcut instead of pushing it. */}
            {onArchive && (
              <button
                className="absolute right-0 rounded bg-accent p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
                onClick={armConfirm}
                aria-label="归档"
                title="归档"
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
