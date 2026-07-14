import { useEffect, useState } from "react";
import type { TabKey } from "./ManagePage";
import { useT } from "../i18n/I18nProvider";
import {
  ArrowRight,
  FileText,
  PanelTop,
  Plug,
  Puzzle,
  Search,
  ShoppingCart,
  type LucideIcon,
} from "lucide-react";

interface Props {
  cwd: string;
  onOpenManage: (tab: TabKey, query?: string) => void;
}

interface Counts {
  plugins: number;
  panels: number;
  skills: number;
  mcp: number;
}

/**
 * DiscoverHome — the minimal discovery landing for the extensions surface.
 * Centered title + a search box that deep-links into the 技能 tab, and an
 * "已安装概览" of clickable package/panel/skill/MCP/market entries.
 * Counts are best-effort: any failing source falls back to 0 rather than
 * blocking the whole page.
 */
export function DiscoverHome({ cwd, onOpenManage }: Props) {
  const { t, lang } = useT();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    setCounts(null);
    Promise.all([
      window.codeshell.listPlugins(cwd).then((d) => d.length).catch(() => 0),
      window.codeshell.listPanelExtensions(cwd, lang).then((d) => d.length).catch(() => 0),
      window.codeshell
        .listSkills(cwd, { includeDisabled: true })
        .then((d) => d.length)
        .catch(() => 0),
      // MCP 数量要算「插件捆绑 + 用户自配」的合并结果 —— 多数人 MCP 都来自
      // 插件(superpowers/playwright 等),只数用户全局 mcpServers 会恒为 0。
      // 复用设置页同一条 listMergedMcpServers 折叠路径(见 McpSection.load)。
      window.codeshell
        .getSettings("user")
        .then(async (s) => {
          const base = (s?.mcpServers ?? {}) as Record<string, unknown>;
          const disabledPlugins = Array.isArray(s?.disabledPlugins)
            ? s.disabledPlugins.filter((x): x is string => typeof x === "string")
            : [];
          const merged = await window.codeshell.listMergedMcpServers(base, disabledPlugins, cwd);
          return Object.keys(merged ?? {}).length;
        })
        .catch(() => 0),
    ]).then(([plugins, panels, skills, mcp]) => {
      if (alive) setCounts({ plugins, panels, skills, mcp });
    });
    return () => {
      alive = false;
    };
  }, [cwd, lang]);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") onOpenManage("skills", search.trim() || undefined);
  };

  const stats: {
    key: TabKey;
    label: string;
    description: string;
    icon: LucideIcon;
    value: number | null;
  }[] = [
    {
      key: "plugins",
      label: t("ext.discover.plugins"),
      description: t("ext.discover.pluginsDesc"),
      icon: Puzzle,
      value: counts?.plugins ?? null,
    },
    {
      key: "panels",
      label: t("ext.discover.panels"),
      description: t("ext.discover.panelsDesc"),
      icon: PanelTop,
      value: counts?.panels ?? null,
    },
    {
      key: "skills",
      label: t("ext.discover.skills"),
      description: t("ext.discover.skillsDesc"),
      icon: FileText,
      value: counts?.skills ?? null,
    },
    {
      key: "mcp",
      label: t("ext.discover.mcp"),
      description: t("ext.discover.mcpDesc"),
      icon: Plug,
      value: counts?.mcp ?? null,
    },
    {
      key: "market",
      label: t("ext.discover.market"),
      description: t("ext.discover.marketDesc"),
      icon: ShoppingCart,
      value: null,
    },
  ];

  return (
    <div className="mx-auto max-w-4xl py-8">
      <div className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{t("ext.discover.title")}</h1>
        <p className="mx-auto mt-2 max-w-2xl text-sm text-muted-foreground">
          {t("ext.discover.subtitle")}
        </p>
        <div className="relative mx-auto mt-6 max-w-xl">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            className="h-11 w-full rounded-lg border border-input bg-background pl-10 pr-3 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15"
            placeholder={t("ext.discover.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
      </div>

      <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
          <button
            key={s.key}
            className="group flex min-h-[118px] items-start gap-3 rounded-lg border bg-card p-4 text-left text-card-foreground shadow-sm transition-colors hover:border-primary/40 hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15"
            onClick={() => onOpenManage(s.key)}
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground group-hover:text-primary">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-foreground">{s.label}</span>
                <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </span>
              <span className="mt-1 block text-2xl font-semibold leading-none text-foreground">
                {s.value === null ? "+" : s.value}
              </span>
              <span className="mt-2 block text-xs leading-5 text-muted-foreground">{s.description}</span>
            </span>
          </button>
          );
        })}
      </div>
    </div>
  );
}
