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
    <div className="flex h-full flex-col gap-3 p-6">
      <header className="flex items-center justify-between gap-4">
        <h2 className="approvals-section-title">扩展</h2>
      </header>
      <ExtensionsPage activeRepoPath={activeRepoPath} />
    </div>
  );
}
