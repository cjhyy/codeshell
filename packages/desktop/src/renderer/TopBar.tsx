import React, { memo, useState, useRef, useEffect } from "react";
import { StatusDot } from "./ui/StatusDot";
import { IconButton } from "./ui/IconButton";
import { PanelLeft, PanelRight } from "./ui/icons";
import { StatusPopover } from "./topbar/StatusPopover";
import type { LiveActivity } from "./topbar/liveActivity";
import type { TaskListMessage } from "./types";

interface Props {
  repoName: string | null;
  sessionTitle: string | null;
  busy: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Right-side panel dock (files/browser/review/terminal) open state + toggle. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  /**
   * Snapshot of what the agent is doing right now. Only used to
   * populate the hover popover; the dot itself only needs `busy`.
   */
  activity?: LiveActivity;
  /** Latest TaskList snapshot. When present the popover shows the
   *  numbered task overview instead of the tool/elapsed summary. */
  tasks?: TaskListMessage | null;
}

/**
 * Slim TopBar — Codex-style single-row header: macOS traffic-light
 * gutter, sidebar toggle, identity (repo / session title), status.
 * Model selector, permission mode, and context token count live in
 * the composer (see ChatView). Settings access is in the sidebar's
 * pinned bottom row.
 *
 * The right-edge status dot now opens a hover popover showing the
 * current tool / step count / elapsed time, mirroring Codex's "what
 * is the agent doing right now" affordance.
 */
function TopBarImpl({
  repoName,
  sessionTitle,
  busy,
  sidebarCollapsed,
  onToggleSidebar,
  panelOpen,
  onTogglePanel,
  activity,
  tasks,
}: Props) {
  return (
    // The window is frameless on macOS (titleBarStyle: "hiddenInset"),
    // so the only thing that lets the user drag it is a
    // -webkit-app-region: drag surface. Tailwind v4 has no utility for
    // that property, so set it inline on the header. Interactive
    // children (the sidebar toggle, the status badge) must opt back out
    // with `no-drag`, otherwise the drag region swallows their clicks.
    <header
      className="flex h-11 items-center justify-between border-b border-border px-3 text-sm"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex items-center gap-2">
        <span className="w-[68px] shrink-0" aria-hidden="true" />
        <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <IconButton
            label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
            onClick={onToggleSidebar}
          >
            <PanelLeft size={14} />
          </IconButton>
        </span>
        <span className="font-semibold">code-shell</span>
        {repoName && <span className="text-muted-foreground">/</span>}
        {repoName && <span className="text-foreground">{repoName}</span>}
        {sessionTitle && <span className="text-muted-foreground">·</span>}
        {sessionTitle && <span className="truncate text-muted-foreground">{sessionTitle}</span>}
      </div>
      <div className="flex items-center gap-1">
        <StatusBadge busy={busy} activity={activity} tasks={tasks ?? null} />
        <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <IconButton
            label={panelOpen ? "关闭面板" : "打开面板"}
            onClick={onTogglePanel}
            active={panelOpen}
          >
            <PanelRight size={14} />
          </IconButton>
        </span>
      </div>
    </header>
  );
}

/**
 * Hoverable wrapper around the dot. We can't reuse pure CSS :hover
 * because the popover needs to stay visible while the cursor crosses
 * the gap between the dot and the panel — track open state in JS so
 * the panel can extend its own hover zone.
 */
function StatusBadge({
  busy,
  activity,
  tasks,
}: {
  busy: boolean;
  activity?: LiveActivity;
  tasks: TaskListMessage | null;
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = (): void => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = (): void => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 120);
  };
  useEffect(() => () => cancelClose(), []);

  return (
    <div
      className="relative flex items-center"
      // Opt out of the header's drag region so hover/focus reach the dot.
      style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      // tabIndex makes the div keyboard-focusable so the onFocus/onBlur popover
      // toggling works via keyboard, not just descendant focus bubbling.
      tabIndex={0}
      onMouseEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onMouseLeave={scheduleClose}
      onFocus={() => setOpen(true)}
      onBlur={scheduleClose}
    >
      <StatusDot
        status={busy ? "running" : "idle"}
        title={busy ? "running" : "idle"}
      />
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1">
          <StatusPopover
            activity={
              activity ?? {
                lastToolName: "",
                lastTool: null,
                toolCount: 0,
                turnStartedAt: 0,
                toolInFlight: false,
              }
            }
            busy={busy}
            tasks={tasks}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Memoized with a value-based comparator. App recomputes `activity` (and the
 * `messages`-derived `tasks`) on EVERY streamed token, handing TopBar a fresh
 * object each time — which, unmemoized, re-rendered this header ~30×/sec during
 * streaming at ~10ms a pop (the dominant non-MessageStream cost behind the
 * freeze: perf showed commit.TopBar ≈ commit.App ≫ commit.MessageStream).
 *
 * The visible header only depends on busy/repoName/sessionTitle/sidebar; the
 * `activity`/`tasks` objects feed only the hover popover. So we re-render only
 * when a *meaningful* field changes — the activity's current tool / in-flight /
 * count, or the task list identity — not on every token that merely grows the
 * streaming text. The popover, when open, still shows the latest tool because
 * those fields ARE in the comparator. (perf: topbar-rerender-per-token)
 */
function topBarPropsEqual(a: Props, b: Props): boolean {
  return (
    a.repoName === b.repoName &&
    a.sessionTitle === b.sessionTitle &&
    a.busy === b.busy &&
    a.sidebarCollapsed === b.sidebarCollapsed &&
    a.onToggleSidebar === b.onToggleSidebar &&
    a.panelOpen === b.panelOpen &&
    a.onTogglePanel === b.onTogglePanel &&
    a.tasks === b.tasks &&
    a.activity?.lastToolName === b.activity?.lastToolName &&
    a.activity?.toolInFlight === b.activity?.toolInFlight &&
    a.activity?.toolCount === b.activity?.toolCount &&
    a.activity?.lastTool?.id === b.activity?.lastTool?.id &&
    a.activity?.lastTool?.status === b.activity?.lastTool?.status
  );
}

export const TopBar = memo(TopBarImpl, topBarPropsEqual);
