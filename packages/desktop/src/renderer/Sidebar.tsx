import React from "react";

interface SidebarProps {
  /** Hard-coded for B8; B9 wires the real list. */
  repos: { id: string; name: string }[];
  activeRepoId: string | null;
  onSelectRepo: (id: string) => void;
  onAddRepo: () => void;
}

const MENU_ITEMS = [
  { icon: "💬", label: "对话" },
  { icon: "🔎", label: "搜索" },
  { icon: "🧩", label: "插件" },
  { icon: "⚙", label: "自动化" },
];

export function Sidebar({ repos, activeRepoId, onSelectRepo, onAddRepo }: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="sidebar-menu">
        {MENU_ITEMS.map((item) => (
          <div key={item.label} className="sidebar-menu-item">
            <span className="sidebar-menu-icon">{item.icon}</span>
            <span>{item.label}</span>
          </div>
        ))}
      </nav>

      <div className="sidebar-divider" />

      <div className="sidebar-section-label">项目</div>

      <div className="sidebar-repos">
        {repos.map((repo) => (
          <div
            key={repo.id}
            className={`sidebar-repo-item${activeRepoId === repo.id ? " selected" : ""}`}
            onClick={() => onSelectRepo(repo.id)}
          >
            {repo.name}
          </div>
        ))}
        <div className="sidebar-repo-item sidebar-add" onClick={onAddRepo}>
          + 添加
        </div>
      </div>
    </aside>
  );
}
