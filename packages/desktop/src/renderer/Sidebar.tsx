import React from "react";
import { X, Plus } from "./ui/icons";
import { SidebarNav } from "./SidebarNav";
import type { ViewMode } from "./view";

interface SidebarProps {
  repos: { id: string; name: string }[];
  activeRepoId: string | null;
  onSelectRepo: (id: string) => void;
  onAddRepo: () => void;
  onRemoveRepo: (id: string) => void;
  viewMode: ViewMode;
  onSelectView: (v: ViewMode) => void;
  approvalsBadge?: number;
  runsBadge?: number;
}

export function Sidebar({
  repos,
  activeRepoId,
  onSelectRepo,
  onAddRepo,
  onRemoveRepo,
  viewMode,
  onSelectView,
  approvalsBadge,
  runsBadge,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <SidebarNav
        active={viewMode}
        onSelect={onSelectView}
        badges={{ approvals: approvalsBadge, runs: runsBadge }}
      />

      <div className="sidebar-divider" />

      <div className="sidebar-section-label">项目</div>

      <div className="sidebar-repos">
        {repos.length === 0 && (
          <div className="repo-empty">点 + 添加你的第一个 repo</div>
        )}
        {repos.map((repo) => (
          <div
            key={repo.id}
            className={`sidebar-repo-item${activeRepoId === repo.id ? " selected" : ""}`}
            onClick={() => onSelectRepo(repo.id)}
          >
            <span className="repo-name">{repo.name}</span>
            <button
              className="repo-remove"
              aria-label="移除"
              title="移除"
              onClick={(e) => {
                e.stopPropagation();
                onRemoveRepo(repo.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <div className="sidebar-repo-item sidebar-add" onClick={onAddRepo}>
          <Plus size={12} /> 添加
        </div>
      </div>
    </aside>
  );
}
