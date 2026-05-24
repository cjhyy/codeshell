import React from "react";
import { StatusDot } from "./ui/StatusDot";

interface Props {
  repoName: string | null;
  sessionTitle: string | null;
  busy: boolean;
}

/**
 * Slim TopBar — just identity (repo / session title) + a status dot.
 * Model selector, permission mode, and context token count now live in
 * the composer (see ChatView). Settings access is in the sidebar's
 * pinned bottom row.
 */
export function TopBar({ repoName, sessionTitle, busy }: Props) {
  return (
    <header className="topbar">
      <div className="topbar-left">
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
