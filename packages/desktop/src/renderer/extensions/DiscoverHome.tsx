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

  return (
    <div className="ext-home">
      <h1 className="ext-home-title">让 codeshell 按你的方式工作</h1>
      <input
        className="ext-home-search"
        placeholder="搜索技能、插件…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={onSearchKeyDown}
      />
      <div className="ext-home-overview">
        <button
          className="ext-home-stat"
          onClick={() => onOpenManage("plugins")}
        >
          插件 <b>{counts?.plugins ?? "—"}</b>
        </button>
        <span className="ext-home-dot">·</span>
        <button
          className="ext-home-stat"
          onClick={() => onOpenManage("skills")}
        >
          技能 <b>{counts?.skills ?? "—"}</b>
        </button>
        <span className="ext-home-dot">·</span>
        <button className="ext-home-stat" onClick={() => onOpenManage("mcp")}>
          MCP <b>{counts?.mcp ?? "—"}</b>
        </button>
      </div>
    </div>
  );
}
