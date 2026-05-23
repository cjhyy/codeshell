import React from "react";
import { GitBranch, Cpu, Lock, Activity } from "./ui/icons";
import { StatusDot } from "./ui/StatusDot";

interface Props {
  repoName: string | null;
  sessionTitle: string | null;
  branch?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  promptTokens?: number;
  busy: boolean;
}

export function TopBar({
  repoName,
  sessionTitle,
  branch,
  model,
  permissionMode,
  promptTokens,
  busy,
}: Props) {
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
        {branch && (
          <span className="topbar-chip" title="git branch">
            <GitBranch size={12} /> {branch}
          </span>
        )}
        {model && (
          <span className="topbar-chip" title="model">
            <Cpu size={12} /> {model}
          </span>
        )}
        {permissionMode && (
          <span className="topbar-chip" title="permission mode">
            <Lock size={12} /> {permissionMode}
          </span>
        )}
        {typeof promptTokens === "number" && (
          <span className="topbar-chip" title="context tokens">
            <Activity size={12} /> {promptTokens.toLocaleString()}
          </span>
        )}
        <StatusDot status={busy ? "running" : "idle"} title={busy ? "running" : "idle"} />
      </div>
    </header>
  );
}
