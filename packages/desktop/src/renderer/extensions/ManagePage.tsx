/**
 * ManagePage — tabbed container wiring PluginsTab / SkillsTab / McpSection.
 *
 * Owns the enable/disable state for plugins and skills. State lives in TWO
 * user-scope settings arrays:
 *
 *   - disabledSkills: bare skill names that are off.
 *   - disabledPlugins: bare plugin names that are off. THIS is what suppresses
 *     a plugin's hooks (loadPluginHooks only reads disabledPlugins).
 *
 * Toggling a plugin cascades to its skills: every skill whose source is
 * "plugin" and whose namespace === the plugin name is flipped in
 * disabledSkills, AND the plugin name is added/removed in disabledPlugins.
 */

import { useEffect, useRef, useState } from "react";
import { McpSection } from "../settings/McpSection";
import { writeSettings } from "../settingsBus";
import { MarketList } from "./MarketList";
import { PluginsTab } from "./PluginsTab";
import { PanelsTab } from "./PanelsTab";
import { SkillsTab } from "./SkillsTab";
import { useT } from "../i18n/I18nProvider";
import type { SkillSummary } from "../../main/skills-service";
import type { RendererConfigurationTarget } from "../../preload/types";
import {
  FileText,
  PanelTop,
  Plug,
  Puzzle,
  Search,
  ShoppingCart,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleSelect } from "@/components/ui/simple-select";

// A plugin skill's namespace is the part of its name before the first ":".
const STANDALONE_NAMESPACE = "__standalone__";

function namespaceOf(s: SkillSummary): string {
  const idx = s.name.indexOf(":");
  return idx > 0 ? s.name.slice(0, idx) : STANDALONE_NAMESPACE;
}

export type TabKey = "plugins" | "panels" | "skills" | "mcp" | "market";

interface Props {
  cwd: string;
  configurationTarget: RendererConfigurationTarget;
  activeProjectPath: string | null;
  initialTab?: TabKey;
  initialQuery?: string;
  showHeading?: boolean;
}

export function ManagePage({
  cwd,
  configurationTarget,
  activeProjectPath,
  initialTab,
  initialQuery,
  showHeading = true,
}: Props) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>(initialTab ?? "plugins");
  const [query, setQuery] = useState(initialQuery ?? "");
  const searchRef = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set());
  const [disabledPlugins, setDisabledPlugins] = useState<Set<string>>(new Set());

  const refresh = async () => {
    const [skillList, settings] = await Promise.all([
      window.codeshell.listSkills(configurationTarget, { includeDisabled: true }),
      window.codeshell.getSettings("user"),
    ]);
    setSkills(skillList);
    const ds = settings?.disabledSkills;
    setDisabledSkills(new Set(Array.isArray(ds) ? (ds as string[]) : []));
    const dp = settings?.disabledPlugins;
    setDisabledPlugins(new Set(Array.isArray(dp) ? (dp as string[]) : []));
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configurationTarget]);

  const toggleSkill = async (name: string, shouldDisable: boolean) => {
    const next = new Set(disabledSkills);
    if (shouldDisable) next.add(name);
    else next.delete(name);
    setDisabledSkills(next);
    await writeSettings("user", { disabledSkills: [...next] });
  };

  /**
   * Cascade: flips every skill belonging to the plugin in disabledSkills AND
   * adds/removes the plugin name in disabledPlugins, then writes BOTH arrays.
   * The disabledPlugins write is the part that suppresses the plugin's hooks.
   */
  const togglePlugin = async (pluginName: string, shouldDisable: boolean) => {
    const groupSkills = skills.filter(
      (s) => s.source === "plugin" && namespaceOf(s) === pluginName,
    );
    const nextSkills = new Set(disabledSkills);
    for (const s of groupSkills) {
      if (shouldDisable) nextSkills.add(s.name);
      else nextSkills.delete(s.name);
    }
    const nextPlugins = new Set(disabledPlugins);
    if (shouldDisable) nextPlugins.add(pluginName);
    else nextPlugins.delete(pluginName);
    setDisabledSkills(nextSkills);
    setDisabledPlugins(nextPlugins);
    await writeSettings("user", {
      disabledSkills: [...nextSkills],
      disabledPlugins: [...nextPlugins],
    });
  };

  const tabs: Array<{ key: TabKey; label: string; Icon: LucideIcon }> = [
    { key: "plugins", label: t("ext.manage.tabPlugins"), Icon: Puzzle },
    { key: "panels", label: t("ext.manage.tabPanels"), Icon: PanelTop },
    { key: "skills", label: t("ext.manage.tabSkills"), Icon: FileText },
    { key: "mcp", label: t("ext.manage.tabMcp"), Icon: Plug },
    { key: "market", label: t("ext.manage.tabMarket"), Icon: ShoppingCart },
  ];
  const activeTab = tabs.find((item) => item.key === tab)!;
  const tabBtn = ({ key, label, Icon }: (typeof tabs)[number]) => (
    <button
      key={key}
      type="button"
      aria-current={tab === key ? "page" : undefined}
      className={
        "inline-flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring " +
        (tab === key ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-accent/60")
      }
      onClick={() => setTab(key)}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <div className="@container/extensions min-w-0">
      {showHeading && (
        <div className="mb-5 flex items-center gap-3">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Puzzle size={21} aria-hidden />
          </span>
          <div>
            <p className="text-xs text-muted-foreground">{t("ext.manage.title")}</p>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">{activeTab.label}</h1>
          </div>
        </div>
      )}
      <div className="mb-5 rounded-2xl border border-border/70 bg-muted/20 p-3">
        <nav
          aria-label={t("ext.manage.navLabel")}
          className="flex flex-wrap items-center gap-1 @max-[620px]/extensions:hidden"
        >
          {tabs.map(tabBtn)}
        </nav>
        <div className="hidden @max-[620px]/extensions:block">
          <SimpleSelect<TabKey>
            value={tab}
            onChange={setTab}
            options={tabs.map((item) => ({ value: item.key, label: item.label }))}
            ariaLabel={t("ext.manage.navLabel")}
            className="rounded-xl bg-background"
          />
        </div>
        {tab !== "mcp" && tab !== "market" && (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 border-t border-border/60 pt-3">
            {/* Scope disclosure: these switches write the USER-level
            disabledSkills/disabledPlugins — they affect EVERY project. Users
            kept flipping them believing they were per-project (feedback:
            writeflow「关闭了」却没有任何项目级文件), so say it out loud and
            point at the real per-project path. */}
            {(tab === "plugins" || tab === "skills") && (
              <span
                className="rounded-full border border-border/70 bg-background px-2 py-1 text-[11px] text-muted-foreground"
                title={t("ext.manage.globalScopeTip")}
              >
                {t("ext.manage.globalScopeBadge")}
              </span>
            )}
            <div className="relative min-w-0 basis-52 flex-1">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <input
                ref={searchRef}
                type="search"
                aria-label={t("ext.manage.searchIn", { category: activeTab.label })}
                className="h-9 w-full rounded-lg border border-border/70 bg-background pl-9 pr-9 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-search-cancel-button]:hidden"
                placeholder={t("ext.manage.searchIn", { category: activeTab.label })}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 size-7 text-muted-foreground"
                  aria-label={t("ext.common.clearSearch")}
                  onClick={() => {
                    setQuery("");
                    searchRef.current?.focus();
                  }}
                >
                  <X size={13} aria-hidden />
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {tab === "plugins" && (
        <PluginsTab
          cwd={cwd}
          configurationTarget={configurationTarget}
          query={query}
          isEnabled={(p) => !disabledPlugins.has(p.name)}
          onToggle={(p, next) => void togglePlugin(p.name, !next)}
          onChanged={() => void refresh()}
        />
      )}
      {tab === "panels" && (
        <PanelsTab cwd={cwd} activeProjectPath={activeProjectPath} query={query} />
      )}
      {tab === "skills" && (
        <SkillsTab
          configurationTarget={configurationTarget}
          query={query}
          isEnabled={(s) => !disabledSkills.has(s.name)}
          onToggle={(s, next) => void toggleSkill(s.name, !next)}
        />
      )}
      {tab === "mcp" && <McpSection scope="user" activeProjectPath={activeProjectPath} />}
      {tab === "market" && (
        <MarketList configurationTarget={configurationTarget} onInstalled={() => void refresh()} />
      )}
    </div>
  );
}
