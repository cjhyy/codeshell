import React from "react";
import { StatusDot } from "./ui/StatusDot";
import { IconButton } from "./ui/IconButton";
import { PanelLeft } from "./ui/icons";

interface Props {
  repoName: string | null;
  sessionTitle: string | null;
  busy: boolean;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

/**
 * Slim TopBar — Codex-style single-row header: macOS traffic-light
 * gutter, sidebar toggle, identity (repo / session title), status.
 * Model selector, permission mode, and context token count live in
 * the composer (see ChatView). Settings access is in the sidebar's
 * pinned bottom row.
 */
export function TopBar({
  repoName,
  sessionTitle,
  busy,
  sidebarCollapsed,
  onToggleSidebar,
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
        <StatusDot status={busy ? "running" : "idle"} title={busy ? "running" : "idle"} />
      </div>
    </header>
  );
}
