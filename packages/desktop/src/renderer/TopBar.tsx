import React, { useState, useRef, useEffect } from "react";
import { StatusDot } from "./ui/StatusDot";
import { IconButton } from "./ui/IconButton";
import { PanelLeft } from "./ui/icons";
import { StatusPopover } from "./topbar/StatusPopover";
import type { LiveActivity } from "./topbar/liveActivity";
import type { TaskListMessage } from "./types";

interface Props {
  repoName: string | null;
  sessionTitle: string | null;
  busy: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
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
export function TopBar({
  repoName,
  sessionTitle,
  busy,
  sidebarCollapsed,
  onToggleSidebar,
  activity,
  tasks,
}: Props) {
  return (
    <header className="flex h-11 items-center justify-between border-b border-border px-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="w-[68px] shrink-0" aria-hidden="true" />
        <IconButton
          label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={onToggleSidebar}
        >
          <PanelLeft size={14} />
        </IconButton>
        <span className="font-semibold">code-shell</span>
        {repoName && <span className="text-muted-foreground">/</span>}
        {repoName && <span className="text-foreground">{repoName}</span>}
        {sessionTitle && <span className="text-muted-foreground">·</span>}
        {sessionTitle && <span className="truncate text-muted-foreground">{sessionTitle}</span>}
      </div>
      <div className="flex items-center">
        <StatusBadge busy={busy} activity={activity} tasks={tasks ?? null} />
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
