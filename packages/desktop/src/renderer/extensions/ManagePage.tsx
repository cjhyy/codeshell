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
import type { SkillSummary } from "../../main/skills-service";

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
  activeRepoPath: string | null;
  initialTab?: TabKey;
  initialQuery?: string;
}

export function ManagePage({ cwd, activeRepoPath, initialTab, initialQuery }: Props) {
  const [tab, setTab] = useState<TabKey>(initialTab ?? "plugins");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set());
  const [disabledPlugins, setDisabledPlugins] = useState<Set<string>>(new Set());

  const refresh = async () => {
    const [skillList, settings] = await Promise.all([
      window.codeshell.listSkills(cwd),
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

  return (
    <div className="ext-manage">
      <div className="ext-tabbar">
        <button
          className={tab === "plugins" ? "active" : ""}
          onClick={() => setTab("plugins")}
        >
          插件
        </button>
        <button
          className={tab === "skills" ? "active" : ""}
          onClick={() => setTab("skills")}
        >
          技能
        </button>
        <button
          className={tab === "mcp" ? "active" : ""}
          onClick={() => setTab("mcp")}
        >
          MCP
        </button>
        <button
          className={tab === "market" ? "active" : ""}
          onClick={() => setTab("market")}
        >
          市场
        </button>
        {tab !== "mcp" && tab !== "market" && (
          <input
            className="ext-search"
            placeholder="搜索"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
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
      {tab === "mcp" && (
        <McpSection scope="user" activeRepoPath={activeRepoPath} />
      )}
      {tab === "market" && (
        <MarketList cwd={cwd} onInstalled={() => void refresh()} />
      )}
    </div>
  );
}
