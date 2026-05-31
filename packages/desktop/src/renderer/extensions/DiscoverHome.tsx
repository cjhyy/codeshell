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
    <div className="mx-auto max-w-2xl py-10">
      <div className="text-center">
        <h1 className="text-2xl font-semibold tracking-tight">让 codeshell 按你的方式工作</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          管理插件、技能与 MCP 服务，或从市场添加更多能力
        </p>
        <div className="relative mx-auto mt-5 max-w-md">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2" aria-hidden="true">🔍</span>
          <input
            className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder="搜索技能、插件…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
      </div>

      <div className="mt-8 grid grid-cols-4 gap-3">
        {stats.map((s) => (
          <button
            key={s.key}
            className="flex flex-col items-center gap-1 rounded-xl border bg-card p-4 text-card-foreground shadow-sm transition-colors hover:bg-accent"
            onClick={() => onOpenManage(s.key)}
          >
            <span className="text-2xl" aria-hidden="true">{s.icon}</span>
            <span className="text-lg font-semibold">{s.value === null ? "—" : s.value}</span>
            <span className="text-xs text-muted-foreground">{s.label}</span>
          </button>
        ))}
        <button
          className="flex flex-col items-center gap-1 rounded-xl border border-dashed bg-card p-4 text-card-foreground shadow-sm transition-colors hover:bg-accent"
          onClick={() => onOpenManage("market")}
        >
          <span className="text-2xl" aria-hidden="true">🛒</span>
          <span className="text-lg font-semibold">+</span>
          <span className="text-xs text-muted-foreground">市场</span>
        </button>
      </div>
    </div>
  );
}
