import { useEffect, useState } from "react";
import type { TabKey } from "./ManagePage";

interface Props {
  cwd: string;
  onOpenManage: (tab: TabKey, query?: string) => void;
}

interface Counts {
  plugins: number;
  skills: number;
  mcp: number;
}

/**
 * DiscoverHome — the minimal discovery landing for the extensions surface.
 * Centered title + a search box that deep-links into the 技能 tab, and an
 * "已安装概览" of three clickable counts that jump into the management page.
 * Counts are best-effort: any failing source falls back to 0 rather than
 * blocking the whole page.
 */
export function DiscoverHome({ cwd, onOpenManage }: Props) {
  const [counts, setCounts] = useState<Counts | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    setCounts(null);
    Promise.all([
      window.codeshell.listPlugins(cwd).then((d) => d.length).catch(() => 0),
      window.codeshell.listSkills(cwd).then((d) => d.length).catch(() => 0),
      window.codeshell
        .getSettings("user")
        .then((s) => Object.keys(s?.mcpServers ?? {}).length)
        .catch(() => 0),
    ]).then(([plugins, skills, mcp]) => {
      if (alive) setCounts({ plugins, skills, mcp });
    });
    return () => {
      alive = false;
    };
  }, [cwd]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onOpenManage("skills", search.trim() || undefined);
  };

  const stats: { key: TabKey; label: string; icon: string; value: number | null }[] = [
    { key: "plugins", label: "插件", icon: "🧩", value: counts?.plugins ?? null },
    { key: "skills", label: "技能", icon: "📄", value: counts?.skills ?? null },
    { key: "mcp", label: "MCP", icon: "🔌", value: counts?.mcp ?? null },
  ];

  return (
    <div className="ext-home">
      <div className="ext-home-hero">
        <h1 className="ext-home-title">让 codeshell 按你的方式工作</h1>
        <p className="ext-home-subtitle">
          管理插件、技能与 MCP 服务，或从市场添加更多能力
        </p>
        <div className="ext-home-search-wrap">
          <span className="ext-home-search-icon" aria-hidden="true">
            🔍
          </span>
          <input
            className="ext-home-search"
            placeholder="搜索技能、插件…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
      </div>

      <div className="ext-home-cards">
        {stats.map((s) => (
          <button
            key={s.key}
            className="ext-home-card"
            onClick={() => onOpenManage(s.key)}
          >
            <span className="ext-home-card-icon" aria-hidden="true">
              {s.icon}
            </span>
            <span className="ext-home-card-value">
              {s.value === null ? "—" : s.value}
            </span>
            <span className="ext-home-card-label">{s.label}</span>
          </button>
        ))}
        <button
          className="ext-home-card ext-home-card-market"
          onClick={() => onOpenManage("market")}
        >
          <span className="ext-home-card-icon" aria-hidden="true">
            🛒
          </span>
          <span className="ext-home-card-value">+</span>
          <span className="ext-home-card-label">市场</span>
        </button>
      </div>
    </div>
  );
}
