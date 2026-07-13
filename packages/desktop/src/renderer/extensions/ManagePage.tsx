/**
 * ManagePage — tabbed container wiring PluginsTab / SkillsTab / McpSection.
 *
 * Owns the enable/disable state for plugins and skills (mirrors CustomizePage
 * in PluginsAndSkillsSection). State lives in TWO user-scope settings arrays:
 *
 *   - disabledSkills: bare skill names that are off.
 *   - disabledPlugins: bare plugin names that are off. THIS is what suppresses
 *     a plugin's hooks (loadPluginHooks only reads disabledPlugins).
 *
 * Toggling a plugin cascades to its skills: every skill whose source is
 * "plugin" and whose namespace === the plugin name is flipped in
 * disabledSkills, AND the plugin name is added/removed in disabledPlugins.
 */

import { useEffect, useState } from "react";
import { McpSection } from "../settings/McpSection";
import { writeSettings } from "../settingsBus";
import { MarketList } from "./MarketList";
import { PluginsTab } from "./PluginsTab";
import { SkillsTab } from "./SkillsTab";
import { useT } from "../i18n/I18nProvider";
import type { SkillSummary } from "../../main/skills-service";
import { FileText, Plug, Puzzle, Search, ShoppingCart, type LucideIcon } from "lucide-react";

// Replicated from PluginsAndSkillsSection (helper is not exported there).
// A plugin skill's namespace is the part of its name before the first ":".
const STANDALONE_NAMESPACE = "__standalone__";

function namespaceOf(s: SkillSummary): string {
  const idx = s.name.indexOf(":");
  return idx > 0 ? s.name.slice(0, idx) : STANDALONE_NAMESPACE;
}

export type TabKey = "plugins" | "skills" | "mcp" | "market";

interface Props {
  cwd: string;
  activeProjectPath: string | null;
  initialTab?: TabKey;
  initialQuery?: string;
}

export function ManagePage({ cwd, activeProjectPath, initialTab, initialQuery }: Props) {
  const { t } = useT();
  const [tab, setTab] = useState<TabKey>(initialTab ?? "plugins");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set());
  const [disabledPlugins, setDisabledPlugins] = useState<Set<string>>(new Set());

  const refresh = async () => {
    const [skillList, settings] = await Promise.all([
      window.codeshell.listSkills(cwd, { includeDisabled: true }),
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
  }, [cwd]);

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

  const tabBtn = (key: TabKey, label: string, Icon: LucideIcon) => (
    <button
      className={
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors " +
        (tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60")
      }
      onClick={() => setTab(key)}
    >
      <Icon className="h-4 w-4" aria-hidden="true" />
      {label}
    </button>
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border bg-muted/20 p-1">
          {tabBtn("plugins", t("ext.manage.tabPlugins"), Puzzle)}
          {tabBtn("skills", t("ext.manage.tabSkills"), FileText)}
          {tabBtn("mcp", t("ext.manage.tabMcp"), Plug)}
          {tabBtn("market", t("ext.manage.tabMarket"), ShoppingCart)}
        </div>
        {/* Scope disclosure: these switches write the USER-level
            disabledSkills/disabledPlugins — they affect EVERY project. Users
            kept flipping them believing they were per-project (feedback:
            writeflow「关闭了」却没有任何项目级文件), so say it out loud and
            point at the real per-project path. */}
        {tab !== "mcp" && tab !== "market" && (
          <span
            className="ml-1 shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
            title={t("ext.manage.globalScopeTip")}
          >
            {t("ext.manage.globalScopeBadge")}
          </span>
        )}
        {tab !== "mcp" && tab !== "market" && (
          <div className="relative min-w-[220px] flex-1">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <input
              className="h-9 w-full rounded-md border border-input bg-transparent pl-9 pr-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/15"
              placeholder={t("ext.manage.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        )}
      </div>
      {tab === "plugins" && (
        <PluginsTab
          cwd={cwd}
          query={query}
          isEnabled={(p) => !disabledPlugins.has(p.name)}
          onToggle={(p, next) => void togglePlugin(p.name, !next)}
          onChanged={() => void refresh()}
        />
      )}
      {tab === "skills" && (
        <SkillsTab
          cwd={cwd}
          query={query}
          isEnabled={(s) => !disabledSkills.has(s.name)}
          onToggle={(s, next) => void toggleSkill(s.name, !next)}
        />
      )}
      {tab === "mcp" && <McpSection scope="user" activeProjectPath={activeProjectPath} />}
      {tab === "market" && <MarketList cwd={cwd} onInstalled={() => void refresh()} />}
    </div>
  );
}
