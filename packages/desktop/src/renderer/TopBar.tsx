import React, { useState, useRef, useEffect } from "react";
import { StatusDot } from "./ui/StatusDot";
import { IconButton } from "./ui/IconButton";
import { PanelLeft } from "./ui/icons";
import { StatusPopover } from "./topbar/StatusPopover";
import type { LiveActivity } from "./topbar/liveActivity";

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
}: Props) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <span className="topbar-traffic-gutter" aria-hidden="true" />
        <IconButton
          label={sidebarCollapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={onToggleSidebar}
        >
          <PanelLeft size={14} />
        </IconButton>
        <span className="topbar-app">code-shell</span>
        {repoName && <span className="topbar-sep">/</span>}
        {repoName && <span className="topbar-repo">{repoName}</span>}
        {sessionTitle && <span className="topbar-sep">·</span>}
        {sessionTitle && <span className="topbar-session">{sessionTitle}</span>}
      </div>
      <div className="topbar-right">
        <StatusBadge busy={busy} activity={activity} />
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
}: {
  busy: boolean;
  activity?: LiveActivity;
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
      className="topbar-status"
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
        <div className="topbar-status-popover-anchor">
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
          />
        </div>
      )}
    </div>
  );
}
