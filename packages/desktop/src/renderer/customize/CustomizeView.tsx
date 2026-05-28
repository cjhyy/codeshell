import React from "react";
import { PluginsAndSkillsSection } from "../settings/PluginsAndSkillsSection";

interface Props {
  activeRepoPath: string | null;
}

/**
 * Full-screen "技能与插件" view, reached from the sidebar-top entry.
 *
 * It hosts the same three-pane PluginsAndSkillsSection that also lives
 * under Settings → Customize, so there is a single source of truth for
 * plugin/skill management — this is just a second door to it.
 */
export function CustomizeView({ activeRepoPath }: Props) {
  return (
    <div className="customize-view">
      <header className="mcp-section-head">
        <h2 className="approvals-section-title">技能与插件</h2>
      </header>
      <PluginsAndSkillsSection activeRepoPath={activeRepoPath} />
    </div>
  );
}
