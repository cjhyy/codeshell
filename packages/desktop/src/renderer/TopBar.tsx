import React, { memo, useState, useRef, useEffect } from "react";
import { StatusDot } from "./ui/StatusDot";
import { IconButton } from "./ui/IconButton";
import { PanelLeft, PanelRight } from "./ui/icons";
import { StatusPopover } from "./topbar/StatusPopover";
import { WorkspaceIndicator } from "./topbar/WorkspaceIndicator";
import type { LiveActivity } from "./topbar/liveActivity";
import type { TaskListMessage } from "./types";
import { useT } from "./i18n";

interface Props {
  projectName: string | null;
  projectPath?: string | null;
  sessionId?: string | null;
  sessionTitle: string | null;
  busy: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** Right-side panel dock (files/browser/review/terminal) open state + toggle. */
  panelOpen: boolean;
  onTogglePanel: () => void;
  isMac: boolean;
  isFullscreen: boolean;
  /** Whether the panel dock can be opened at all. False in draft state (no
   *  active session yet) — panels need a real conversation/context, so the
   *  toggle is hidden entirely rather than opening an empty dock. */
  panelAvailable?: boolean;
  /**
   * Snapshot of what the agent is doing right now. Only used to
   * populate the hover popover; the dot itself only needs `busy`.
   */
  activity?: LiveActivity;
  /** Latest TaskList snapshot. When present the popover shows the
   *  numbered task overview instead of the tool/elapsed summary. */
  tasks?: TaskListMessage | null;
  /** The session's active persistent goal (CC /goal). When present the dot
   *  shows a ◎ marker and the popover surfaces a Goal block + clear button. */
  activeGoal?: { objective: string; round: number } | null;
  /** Clear the active goal (agent/goalClear). */
  onClearGoal?: () => void;
}

/**
 * Slim TopBar — Codex-style single-row header: macOS traffic-light
 * gutter, sidebar toggle, identity (project / session title), status.
 * Model selector, permission mode, and context token count live in
 * the composer (see ChatView). Settings access is in the sidebar's
 * pinned bottom row.
 *
 * The right-edge status dot now opens a hover popover showing the
 * current tool / step count / elapsed time, mirroring Codex's "what
 * is the agent doing right now" affordance.
 */
function TopBarImpl({
  projectName,
  projectPath,
  sessionId,
  sessionTitle,
  busy,
  sidebarCollapsed,
  onToggleSidebar,
  panelOpen,
  onTogglePanel,
  isMac,
  isFullscreen,
  panelAvailable = true,
  activity,
  tasks,
  activeGoal,
  onClearGoal,
}: Props) {
  const { t } = useT();
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
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isMac && !isFullscreen && <span className="w-[68px] shrink-0" aria-hidden="true" />}
        <span className="shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <IconButton
            label={sidebarCollapsed ? t("topbar.expandSidebar") : t("topbar.collapseSidebar")}
            onClick={onToggleSidebar}
          >
            <PanelLeft size={14} />
          </IconButton>
        </span>
        <span className="shrink-0 font-semibold">code-shell</span>
        {projectName && <span className="shrink-0 text-muted-foreground">/</span>}
        {projectName && <span className="shrink-0 text-foreground">{projectName}</span>}
        {projectName && sessionId && projectPath && (
          <span className="shrink-0" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <WorkspaceIndicator
              sessionId={sessionId}
              projectPath={projectPath}
              projectName={projectName}
              sessionBusy={busy}
              includeProjectNameInLabel={false}
            />
          </span>
        )}
        {sessionTitle && <span className="shrink-0 text-muted-foreground">·</span>}
        {/* Only the title shrinks + ellipsizes. min-w-0 is required for
            truncate to work inside a flex row — without it the span keeps its
            intrinsic width and pushes the right-side status/GOAL icons out of
            the header. */}
        {sessionTitle && (
          <span className="min-w-0 truncate text-muted-foreground" title={sessionTitle}>
            {sessionTitle}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <StatusBadge
          busy={busy}
          activity={activity}
          tasks={tasks ?? null}
          activeGoal={activeGoal ?? null}
          onClearGoal={onClearGoal}
        />
        {panelAvailable && (
          <span style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
            <IconButton
              label={panelOpen ? t("topbar.closePanel") : t("topbar.openPanel")}
              onClick={onTogglePanel}
              active={panelOpen}
            >
              <PanelRight size={14} />
            </IconButton>
          </span>
        )}
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
  activeGoal,
  onClearGoal,
}: {
  busy: boolean;
  activity?: LiveActivity;
  tasks: TaskListMessage | null;
  activeGoal: { objective: string; round: number } | null;
  onClearGoal?: () => void;
}) {
  const { t } = useT();
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
      <div className="flex items-center gap-1.5">
        {activeGoal && (
          // ◎ marker: an active persistent goal exists. Hover the dot to see it.
          <span className="text-xs text-status-running" title={t("topbar.hasActiveGoal")}>
            ◎
          </span>
        )}
        {/* Persistent task indicator: TodoWrite tasks used to be visible ONLY on
            hover (the popover), so users kept missing them. Show a compact
            done/total chip inline whenever tasks exist — hover still opens the
            full list. Hidden when there are no tasks. */}
        {tasks && tasks.tasks.length > 0 && (
          <span
            className="flex items-center gap-0.5 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
            title={t("topbar.tasksTip")}
          >
            <span className="text-status-ok">☑</span>
            {tasks.tasks.filter((tk) => tk.status === "completed").length}/{tasks.tasks.length}
          </span>
        )}
        <StatusDot status={busy ? "running" : "idle"} title={busy ? "running" : "idle"} />
      </div>
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
            activeGoal={activeGoal}
            onClearGoal={onClearGoal}
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
 * The visible header only depends on busy/projectName/sessionTitle/sidebar; the
 * `activity`/`tasks` objects feed only the hover popover. So we re-render only
 * when a *meaningful* field changes — the activity's current tool / in-flight /
 * count, or the task list identity — not on every token that merely grows the
 * streaming text. The popover, when open, still shows the latest tool because
 * those fields ARE in the comparator. (perf: topbar-rerender-per-token)
 */
function topBarPropsEqual(a: Props, b: Props): boolean {
  return (
    a.projectName === b.projectName &&
    a.projectPath === b.projectPath &&
    a.sessionId === b.sessionId &&
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
    a.activity?.lastTool?.status === b.activity?.lastTool?.status &&
    // Active goal drives the ◎ marker + popover Goal block, so changes must
    // re-render. Compare by value (objective + round); the callback identity
    // is stable enough to ignore.
    a.activeGoal?.objective === b.activeGoal?.objective &&
    a.activeGoal?.round === b.activeGoal?.round
  );
}

export const TopBar = memo(TopBarImpl, topBarPropsEqual);
