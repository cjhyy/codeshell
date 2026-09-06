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
import type { RendererConfigurationTarget } from "../../preload/types";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";

interface Props {
  cwd: string;
  configurationTarget: RendererConfigurationTarget;
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
export function DiscoverHome({ cwd, configurationTarget, onOpenManage }: Props) {
  const { t, lang } = useT();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [search, setSearch] = useState("");
  const [searchTab, setSearchTab] = useState<"plugins" | "skills" | "panels">("skills");

  useEffect(() => {
    let alive = true;
    setCounts(null);
    Promise.all([
      window.codeshell
        .listPlugins(configurationTarget)
        .then((d) => d.length)
        .catch(() => 0),
      window.codeshell
        .listPanelAppExtensions(cwd, lang)
        .then((d) => d.length)
        .catch(() => 0),
      window.codeshell
        .listSkills(configurationTarget, { includeDisabled: true })
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
          const merged = await window.codeshell.listMergedMcpServers(
            base,
            disabledPlugins,
            configurationTarget,
          );
          return Object.keys(merged ?? {}).length;
        })
        .catch(() => 0),
    ]).then(([plugins, panels, skills, mcp]) => {
      if (alive) setCounts({ plugins, panels, skills, mcp });
    });
    return () => {
      alive = false;
    };
  }, [configurationTarget, cwd, lang]);

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
    <div className="mx-auto min-w-0 max-w-5xl">
      <div className="rounded-3xl border border-primary/10 bg-primary/5 px-5 py-8 text-center sm:px-8 sm:py-10">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl border border-primary/15 bg-background/80 text-primary shadow-sm">
          <Puzzle size={23} aria-hidden />
        </span>
        <h1 className="text-balance text-2xl font-semibold tracking-tight sm:text-3xl">
          {t("ext.discover.title")}
        </h1>
        <p className="mx-auto mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t("ext.discover.subtitle")}
        </p>
        <form
          className="mx-auto mt-6 flex max-w-2xl flex-wrap gap-2 rounded-2xl border border-border/70 bg-background p-2 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault();
            onOpenManage(searchTab, search.trim() || undefined);
          }}
        >
          <SimpleSelect<"plugins" | "skills" | "panels">
            value={searchTab}
            onChange={setSearchTab}
            options={[
              { value: "plugins", label: t("ext.discover.plugins") },
              { value: "skills", label: t("ext.discover.skills") },
              { value: "panels", label: t("ext.discover.panels") },
            ]}
            ariaLabel={t("ext.manage.navLabel")}
            className="h-10 w-auto min-w-28 border-0 bg-muted/40 text-xs shadow-none"
          />
          <div className="relative min-w-0 basis-44 flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              type="search"
              aria-label={t("ext.manage.searchIn", {
                category: stats.find((item) => item.key === searchTab)!.label,
              })}
              className="h-10 w-full rounded-lg border-0 bg-background pl-10 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              placeholder={t("ext.manage.searchIn", {
                category: stats.find((item) => item.key === searchTab)!.label,
              })}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button type="submit" className="h-10 flex-1 gap-2 rounded-xl px-4 sm:flex-none">
            {t("ext.common.search")}
            <ArrowRight size={15} aria-hidden />
          </Button>
        </form>
      </div>

      <div className="mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,230px),1fr))] gap-3">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.key}
              type="button"
              className="group flex min-h-[148px] items-start gap-3 rounded-2xl border border-border/70 bg-card p-5 text-left text-card-foreground shadow-sm transition-colors hover:border-primary/30 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onOpenManage(s.key)}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{s.label}</span>
                  <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                </span>
                <span className="mt-1 block text-2xl font-semibold leading-none text-foreground">
                  {s.key === "market" ? <ShoppingCart size={23} aria-hidden /> : (s.value ?? "—")}
                </span>
                <span className="mt-2 block text-xs leading-5 text-muted-foreground">
                  {s.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
