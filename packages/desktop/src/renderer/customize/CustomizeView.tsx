import React from "react";
import { ExtensionsPage } from "../extensions/ExtensionsPage";

interface Props {
  activeRepoPath: string | null;
}

/**
 * Full-screen "扩展" view, reached from the sidebar-top entry.
 *
 * Hosts the same Codex-style ExtensionsPage that also lives under
 * Settings → 扩展, so there is a single source of truth for
 * plugin/skill/MCP management — this is just a second door to it.
 */
export function CustomizeView({ activeRepoPath }: Props) {
  return (
    <div className="customize-view">
      <header className="mcp-section-head">
        <h2 className="approvals-section-title">扩展</h2>
      </header>
      <ExtensionsPage activeRepoPath={activeRepoPath} />
    </div>
  );
}
