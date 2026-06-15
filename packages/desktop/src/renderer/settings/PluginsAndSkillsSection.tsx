/**
 * Customize page — three pane layout:
 *
 *   ┌────────────┬─────────────────┬────────────────────────┐
 *   │ plugin     │ skills          │ detail (SKILL.md /     │
 *   │ list       │ in selected     │   plugin info / Add)   │
 *   │ +AddPanel  │ plugin          │                        │
 *   └────────────┴─────────────────┴────────────────────────┘
 *
 * Default state: every plugin and skill is enabled (checkbox checked).
 * Unchecking writes the name into `settings.disabledPlugins` /
 * `disabledSkills` — the engine reads these and filters at scanSkills.
 *
 * The "本地" synthetic bucket is constructed renderer-side from skills
 * whose source is not "plugin"; it has no plugin-level checkbox (it
 * isn't a real plugin), but each skill underneath still has its own.
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { cacheGet, cacheSet } from "./settingsCache";
import type {
  GithubDetectedSkill,
  GithubRepoInspection,
  PluginSummary,
  SkillSummary,
} from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useConfirm, useAlert } from "../ui/DialogProvider";
import { Markdown } from "../Markdown";
import { writeSettings } from "../settingsBus";

function skillSourceBadgeClass(source: string): string {
  return cn(
    "rounded border px-1.5 py-0.5 text-[10px] font-medium",
    source === "plugin" && "border-status-warn/40 text-status-warn",
    source === "project" && "border-primary/40 text-primary",
    source === "user" && "border-status-running/40 text-status-running",
    source !== "plugin" && source !== "project" && source !== "user" && "border-border text-muted-foreground",
  );
}

interface Props {
  activeRepoPath: string | null;
}

export function PluginsAndSkillsSection({ activeRepoPath }: Props) {
  return (
    <section className="mb-6 flex flex-col gap-3">
      <CustomizePage activeRepoPath={activeRepoPath} />
    </section>
  );
}

// ─── Local synthetic bucket ──────────────────────────────────────────

const STANDALONE_NAMESPACE = "__standalone__";
const STANDALONE_LABEL = "本地";

function shortNameOf(s: SkillSummary): string {
  const idx = s.name.indexOf(":");
  return idx > 0 ? s.name.slice(idx + 1) : s.name;
}

function namespaceOf(s: SkillSummary): string {
  const idx = s.name.indexOf(":");
  return idx > 0 ? s.name.slice(0, idx) : STANDALONE_NAMESPACE;
}

interface PluginRow {
  /** Display key — for the synthetic "本地" entry this is STANDALONE_NAMESPACE. */
  key: string;
  /** Human label rendered in the row. */
  label: string;
  /** Source/info line ("installed from …" / "本地"). */
  sourceLabel: string;
  skillCount: number;
  /** True for the renderer-side synthetic 本地 bucket (no plugin-level toggle). */
  synthetic: boolean;
  /** The corresponding PluginSummary (undefined for the synthetic bucket). */
  summary?: PluginSummary;
}

function buildPluginRows(
  skills: SkillSummary[],
  plugins: PluginSummary[],
): PluginRow[] {
  const rows: PluginRow[] = [];

  // Real plugins first — alphabetical by display name.
  const realPlugins = [...plugins].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of realPlugins) {
    rows.push({
      key: p.name,
      label: p.name,
      sourceLabel: p.sourceLabel,
      skillCount: p.skillCount,
      synthetic: false,
      summary: p,
    });
  }

  // Synthetic 本地 bucket — all skills whose source is not "plugin".
  const localSkills = skills.filter((s) => s.source !== "plugin");
  if (localSkills.length > 0) {
    rows.push({
      key: STANDALONE_NAMESPACE,
      label: STANDALONE_LABEL,
      sourceLabel: "本地",
      skillCount: localSkills.length,
      synthetic: true,
    });
  }
  return rows;
}

function skillsForPlugin(
  skills: SkillSummary[],
  pluginKey: string,
): SkillSummary[] {
  if (pluginKey === STANDALONE_NAMESPACE) {
    return skills
      .filter((s) => s.source !== "plugin")
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  return skills
    .filter((s) => namespaceOf(s) === pluginKey)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Selection model ────────────────────────────────────────────────

type Selection =
  | { kind: "plugin"; pluginKey: string }
  | { kind: "skill"; skillName: string }
  | { kind: "addPanel" }
  | { kind: "empty" };

/** Last-loaded snapshot per cwd (settingsCache) — seeds remounts so tab
 * switches don't flash the loading placeholder. */
interface CustomizeSnapshot {
  skills: SkillSummary[];
  plugins: PluginSummary[];
  disabled: Set<string>;
  disabledPlugins: Set<string>;
}

function CustomizePage({ activeRepoPath }: { activeRepoPath: string | null }) {
  const cacheKey = `plugins-skills:${activeRepoPath ?? "/"}`;
  const [seed] = useState(() => cacheGet<CustomizeSnapshot>(cacheKey));
  const [skills, setSkills] = useState<SkillSummary[] | null>(seed?.skills ?? null);
  const [plugins, setPlugins] = useState<PluginSummary[]>(seed?.plugins ?? []);
  const [disabledSet, setDisabledSet] = useState<Set<string>>(seed?.disabled ?? new Set());
  // Bare plugin names disabled at the plugin level. Distinct from disabledSet
  // (per-skill): this is what suppresses a plugin's hooks too (e.g.
  // superpowers' SessionStart injection), since loadPluginHooks reads
  // disabledPlugins — disabledSkills alone never reaches the hook path.
  const [disabledPluginsSet, setDisabledPluginsSet] = useState<Set<string>>(
    seed?.disabledPlugins ?? new Set(),
  );
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selection, setSelection] = useState<Selection>({ kind: "empty" });
  const [skillBody, setSkillBody] = useState<string | null>(null);
  // Tracks the filePath the current skillBody belongs to. Ref (not state) so
  // updating it doesn't retrigger the lazy-load effect — the effect only
  // depends on selection / skillsByName.
  const skillBodyForRef = useRef<string | null>(null);
  const confirm = useConfirm();
  const alert = useAlert();

  const cwd = activeRepoPath ?? "/";

  const refresh = async () => {
    try {
      const [skillList, pluginList, settings] = await Promise.all([
        window.codeshell.listSkills(cwd),
        window.codeshell.listPlugins(cwd),
        window.codeshell.getSettings("user"),
      ]);
      setSkills(skillList);
      setPlugins(pluginList);
      const ds = settings?.disabledSkills;
      const disabled = new Set(Array.isArray(ds) ? (ds as string[]) : []);
      setDisabledSet(disabled);
      const dp = settings?.disabledPlugins;
      const disabledPlugins = new Set(Array.isArray(dp) ? (dp as string[]) : []);
      setDisabledPluginsSet(disabledPlugins);
      cacheSet(cacheKey, {
        skills: skillList,
        plugins: pluginList,
        disabled,
        disabledPlugins,
      } satisfies CustomizeSnapshot);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, [activeRepoPath]);

  const pluginRows = useMemo(
    () => buildPluginRows(skills ?? [], plugins),
    [skills, plugins],
  );

  const skillsByName = useMemo(() => {
    const m = new Map<string, SkillSummary>();
    for (const s of skills ?? []) m.set(s.name, s);
    return m;
  }, [skills]);

  const selectedPluginRow = useMemo<PluginRow | null>(() => {
    if (selection.kind === "plugin") {
      return pluginRows.find((r) => r.key === selection.pluginKey) ?? null;
    }
    if (selection.kind === "skill") {
      const s = skillsByName.get(selection.skillName);
      if (!s) return null;
      const ns = namespaceOf(s);
      return pluginRows.find((r) => r.key === ns) ?? null;
    }
    return null;
  }, [selection, pluginRows, skillsByName]);

  const middleSkills = useMemo(() => {
    if (!skills || !selectedPluginRow) return [];
    let list = skillsForPlugin(skills, selectedPluginRow.key);
    if (filter.trim()) {
      const needle = filter.toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(needle) ||
          s.description.toLowerCase().includes(needle),
      );
    }
    return list;
  }, [skills, selectedPluginRow, filter]);

  // Lazily load SKILL.md body when the right pane needs it.
  useEffect(() => {
    if (selection.kind !== "skill") {
      setSkillBody(null);
      skillBodyForRef.current = null;
      return;
    }
    const s = skillsByName.get(selection.skillName);
    if (!s) {
      setSkillBody(null);
      skillBodyForRef.current = null;
      return;
    }
    if (skillBodyForRef.current === s.filePath) return;
    let cancelled = false;
    void (async () => {
      try {
        const body = await window.codeshell.readSkillBody(s.filePath);
        if (!cancelled) {
          setSkillBody(body);
          skillBodyForRef.current = s.filePath;
        }
      } catch (e) {
        if (!cancelled) {
          setSkillBody(`# 读取失败\n\n${String(e instanceof Error ? e.message : e)}`);
          skillBodyForRef.current = s.filePath;
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selection, skillsByName]);

  if (error) return <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">{error}</div>;
  if (!skills) return <div className="p-4 text-sm text-muted-foreground">加载中…</div>;

  const toggleSkillDisabled = async (name: string, shouldDisable: boolean) => {
    const next = new Set(disabledSet);
    if (shouldDisable) next.add(name);
    else next.delete(name);
    setDisabledSet(next);
    await writeSettings("user", {
      disabledSkills: [...next],
    });
  };

  /**
   * Cascade: plugin checkbox is an aggregate of its skills. Toggling it
   * batch-flips every skill in that group (drives the skill-list tri-state)
   * AND writes the bare plugin name into disabledPlugins. The disabledPlugins
   * write is the part that suppresses the plugin's hooks too — disabledSkills
   * never reaches loadPluginHooks, so without it a plugin like superpowers
   * keeps injecting its SessionStart ruleset even when "off". pluginKey is the
   * bare name (PluginRow.key === PluginSummary.name === skill namespace),
   * exactly what loadPluginHooks / scanSkills match against. The synthetic
   * 本地 bucket has no plugin-level toggle, so it never calls this.
   */
  const togglePluginGroup = async (
    pluginKey: string,
    shouldDisableGroup: boolean,
  ) => {
    if (!skills || pluginKey === STANDALONE_NAMESPACE) return;
    const groupSkills = skillsForPlugin(skills, pluginKey);
    const next = new Set(disabledSet);
    for (const s of groupSkills) {
      if (shouldDisableGroup) next.add(s.name);
      else next.delete(s.name);
    }
    const nextPlugins = new Set(disabledPluginsSet);
    if (shouldDisableGroup) nextPlugins.add(pluginKey);
    else nextPlugins.delete(pluginKey);
    setDisabledSet(next);
    setDisabledPluginsSet(nextPlugins);
    await writeSettings("user", {
      disabledSkills: [...next],
      disabledPlugins: [...nextPlugins],
    });
  };

  /** Aggregate state of a plugin group: all enabled / all disabled / mixed. */
  const pluginGroupState = (pluginKey: string): "all" | "none" | "some" => {
    if (!skills) return "all";
    // A plugin-level disable (disabledPlugins) is the strongest "off" signal —
    // it kills both the skill list and the plugin's hooks, so the group reads
    // as fully off regardless of per-skill entries.
    if (disabledPluginsSet.has(pluginKey)) return "none";
    const groupSkills = skillsForPlugin(skills, pluginKey);
    if (groupSkills.length === 0) return "all";
    let disabled = 0;
    for (const s of groupSkills) if (disabledSet.has(s.name)) disabled++;
    if (disabled === 0) return "all";
    if (disabled === groupSkills.length) return "none";
    return "some";
  };

  const uninstallOne = async (s: SkillSummary) => {
    if (s.source === "plugin") {
      await confirm({
        title: "无法卸载 plugin skill",
        message: `「${s.name}」来自插件，无法在此处卸载。可以使用「禁用」隐藏它，或移除对应插件。`,
        confirmLabel: "知道了",
      });
      return;
    }
    const ok = await confirm({
      title: "卸载 skill",
      message: `确认卸载「${s.name}」？这会删除磁盘上的文件夹。`,
      detail: s.filePath,
      confirmLabel: "卸载",
      destructive: true,
    });
    if (!ok) return;
    try {
      await window.codeshell.uninstallSkill(s.filePath, s.source);
      // If the uninstalled skill was selected, drop the selection.
      if (selection.kind === "skill" && selection.skillName === s.name) {
        setSelection({ kind: "empty" });
      }
      await refresh();
    } catch (e) {
      void alert({ title: "卸载失败", message: String(e instanceof Error ? e.message : e) });
    }
  };

  const onSelectPlugin = (row: PluginRow) =>
    setSelection({ kind: "plugin", pluginKey: row.key });
  const onSelectSkill = (s: SkillSummary) =>
    setSelection({ kind: "skill", skillName: s.name });
  const onSelectAddPanel = () => setSelection({ kind: "addPanel" });

  const isAddPanelActive = selection.kind === "addPanel";

  return (
    <div className="grid min-h-[560px] grid-cols-1 gap-3 xl:grid-cols-[260px_320px_1fr]">
      {/* ── Left pane: plugin list ────────────────────────────────── */}
      <aside className="min-h-0 rounded-md border p-3">
        <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
          {pluginRows.map((row) => {
            const isSelected =
              (selection.kind === "plugin" && selection.pluginKey === row.key) ||
              (selection.kind === "skill" &&
                selectedPluginRow?.key === row.key);
            const groupState = pluginGroupState(row.key);
            return (
              <li
                key={row.key}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-accent",
                  isSelected && "bg-accent",
                )}
                onClick={() => onSelectPlugin(row)}
              >
                {!row.synthetic ? (
                  <label
                    className="shrink-0"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Switch
                      checked={groupState === "all"}
                      onCheckedChange={() =>
                        // From "all" → disable all; from "none" or "some" → enable all.
                        // The "some → all" choice mirrors macOS Finder / Claude Code:
                        // clicking an indeterminate checkbox enables everything.
                        void togglePluginGroup(row.key, groupState === "all")
                      }
                      title="启用 / 禁用整个插件（级联到下属 skill）"
                    />
                  </label>
                ) : (
                  <span
                    className="shrink-0"
                    aria-hidden
                    style={{ width: 16 }}
                  />
                )}
                <div className="min-w-0 flex flex-1 flex-col">
                  <span className="truncate text-sm font-medium text-foreground">{row.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {row.sourceLabel}
                  </span>
                  <span className="mt-1 w-fit rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {row.skillCount} skill{row.skillCount === 1 ? "" : "s"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <Button
          type="button"
          variant={isAddPanelActive ? "secondary" : "outline"}
          className="mt-2 w-full justify-start"
          onClick={onSelectAddPanel}
        >
          + 添加插件
        </Button>
      </aside>

      {/* ── Middle pane: skill list ───────────────────────────────── */}
      <section className="min-h-0 rounded-md border p-3">
        <div className="mb-3 flex items-center gap-2">
          <Input
            className="h-9 flex-1"
            placeholder="搜索 skill"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-3 text-sm"
            onClick={() => void refresh()}
            title="刷新"
          >
            刷新
          </Button>
        </div>
        {selectedPluginRow ? (
          middleSkills.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {filter ? "没有匹配的 skill" : "该插件未提供 skill"}
            </div>
          ) : (
            <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
              {middleSkills.map((s) => {
                const isDisabled = disabledSet.has(s.name);
                const isSelected =
                  selection.kind === "skill" && selection.skillName === s.name;
                return (
                  <li
                    key={s.filePath}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 hover:bg-accent",
                      isSelected && "bg-accent",
                    )}
                    onClick={() => onSelectSkill(s)}
                  >
                    <label
                      className="shrink-0"
                      onClick={(e) => e.stopPropagation()}
                      title="启用 / 禁用"
                    >
                      <Switch
                        checked={!isDisabled}
                        onCheckedChange={() =>
                          void toggleSkillDisabled(s.name, !isDisabled)
                        }
                      />
                    </label>
                    <div className="min-w-0 flex flex-1 flex-col">
                      <span className="truncate text-sm font-medium text-foreground">
                        {selectedPluginRow.synthetic ? s.name : shortNameOf(s)}
                      </span>
                      {s.description && (
                        <span className="truncate text-xs text-muted-foreground">
                          {s.description.split("\n")[0]}
                        </span>
                      )}
                    </div>
                    {s.source !== "plugin" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-status-err"
                        title="卸载"
                        onClick={(e) => {
                          e.stopPropagation();
                          void uninstallOne(s);
                        }}
                      >
                        ⋯
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <div className="p-4 text-center text-sm text-muted-foreground">选择左侧任一插件查看其 skill</div>
        )}
      </section>

      {/* ── Right pane: detail / plugin card / AddPanel ───────────── */}
      <section className="min-h-0 rounded-md border p-3">
        {selection.kind === "addPanel" ? (
          <AddPanel
            activeRepoPath={activeRepoPath}
            onInstalled={() => {
              void refresh();
              setSelection({ kind: "empty" });
            }}
          />
        ) : selection.kind === "skill" ? (
          (() => {
            const s = skillsByName.get(selection.skillName);
            if (!s) {
              return (
                <div className="p-4 text-center text-sm text-muted-foreground">该 skill 不存在或已被移除</div>
              );
            }
            return (
              <>
                <header className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="min-w-0 truncate text-sm font-semibold text-foreground">{s.name}</span>
                  <span className={skillSourceBadgeClass(s.source)}>
                    {s.source}
                  </span>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => {
                        void navigator.clipboard.writeText(s.name);
                      }}
                      title="复制 skill 名称"
                    >
                      复制名称
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs"
                      onClick={() => void window.codeshell.revealInFinder(s.filePath)}
                      title="在 Finder 中显示"
                    >
                      定位
                    </Button>
                    {s.source !== "plugin" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-xs text-status-err hover:text-status-err"
                        onClick={() => void uninstallOne(s)}
                        title="卸载"
                      >
                        卸载
                      </Button>
                    )}
                  </div>
                  <span className="w-full truncate rounded bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground">{s.filePath}</span>
                </header>
                <div className="min-h-0 overflow-y-auto">
                  {skillBody === null ? (
                    <div className="p-4 text-sm text-muted-foreground">加载中…</div>
                  ) : (
                    <Markdown text={skillBody} />
                  )}
                </div>
              </>
            );
          })()
        ) : selection.kind === "plugin" && selectedPluginRow ? (
          <PluginInfoCard row={selectedPluginRow} />
        ) : (
          <div className="p-4 text-center text-sm text-muted-foreground">
            选择左侧任一插件以查看其 skill
          </div>
        )}
      </section>
    </div>
  );
}

function PluginInfoCard({ row }: { row: PluginRow }) {
  if (row.synthetic) {
    return (
      <div className="rounded-md border p-3">
        <header className="mb-3 flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold text-foreground">{row.label}</span>
        </header>
        <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
          <span className="label">说明</span>
          <span className="value">
            来自 user / project 范围的本地 skill。可在中间栏单独启用或禁用。
          </span>
        </div>
        <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
          <span className="label">数量</span>
          <span className="value">{row.skillCount}</span>
        </div>
      </div>
    );
  }
  const p = row.summary;
  if (!p) return null;
  return (
    <div className="rounded-md border p-3">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-sm font-semibold text-foreground">{p.name}</span>
        <span className={skillSourceBadgeClass("plugin")}>plugin</span>
      </header>
      {p.description && (
        <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
          <span className="label">描述</span>
          <span className="value">{p.description}</span>
        </div>
      )}
      <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
        <span className="label">来源</span>
        <span className="value">{p.sourceLabel}</span>
      </div>
      {p.marketplace && (
        <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
          <span className="label">Marketplace</span>
          <span className="value">{p.marketplace}</span>
        </div>
      )}
      <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
        <span className="label">版本</span>
        <span className="value">{p.version || "(未知)"}</span>
      </div>
      <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
        <span className="label">安装位置</span>
        <span className="value">{p.installPath}</span>
      </div>
      <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
        <span className="label">Skill 数量</span>
        <span className="value">{p.skillCount}</span>
      </div>
      <div className="grid grid-cols-[100px_1fr] gap-3 border-b py-2 text-sm last:border-b-0 [&_.label]:text-muted-foreground [&_.value]:min-w-0 [&_.value]:break-words">
        <span className="label">安装时间</span>
        <span className="value">{p.installedAt}</span>
      </div>
    </div>
  );
}

// ─── AddPanel — unchanged from the previous tab implementation ────────

function AddPanel({
  activeRepoPath,
  onInstalled,
}: {
  activeRepoPath: string | null;
  onInstalled: () => void;
}) {
  const [source, setSource] = useState<"github" | "local">("github");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1 rounded-md border bg-muted/30 p-1">
        <Button
          type="button"
          variant={source === "github" ? "secondary" : "ghost"}
          size="sm"
          className="rounded-sm px-2 py-1 text-sm"
          onClick={() => setSource("github")}
        >
          从 GitHub 安装
        </Button>
        <Button
          type="button"
          variant={source === "local" ? "secondary" : "ghost"}
          size="sm"
          className="rounded-sm px-2 py-1 text-sm"
          onClick={() => setSource("local")}
        >
          从本地文件夹
        </Button>
      </div>

      {source === "github" ? (
        <GithubAddPanel activeRepoPath={activeRepoPath} onInstalled={onInstalled} />
      ) : (
        <LocalAddPanel activeRepoPath={activeRepoPath} onInstalled={onInstalled} />
      )}
    </div>
  );
}

function LocalAddPanel({
  activeRepoPath,
  onInstalled,
}: {
  activeRepoPath: string | null;
  onInstalled: () => void;
}) {
  const [source, setSource] = useState<{ path: string; name: string } | null>(null);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async () => {
    const picked = await window.codeshell.pickSkillDir();
    if (!picked) return;
    setSource(picked);
    setName(picked.name);
    setError(null);
  };

  const install = async () => {
    if (!source) return;
    setSaving(true);
    setError(null);
    try {
      await window.codeshell.installLocalSkill(
        source.path,
        scope,
        scope === "project" ? activeRepoPath ?? undefined : undefined,
        name.trim() || undefined,
      );
      onInstalled();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
        <Button type="button" variant="outline" className="h-auto flex-col items-start gap-1 p-3 text-left" onClick={() => void choose()}>
          <span className="text-sm font-medium text-foreground">选择本地文件夹</span>
          <span className="text-xs text-muted-foreground">需要包含 SKILL.md。</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
          <span>来源文件夹</span>
          <Input value={source?.path ?? ""} readOnly placeholder="选择一个 Skill 文件夹" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
          <span>安装名称</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="skill-name" />
        </label>
        <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
          <span>安装位置</span>
          <Select<"user" | "project">
            value={scope}
            onChange={(v) => setScope(v)}
            options={[
              { value: "user", label: "全局", description: "对所有项目可用" },
              {
                value: "project",
                label: "当前项目",
                description: activeRepoPath ?? "未选中项目",
                disabled: !activeRepoPath,
              },
            ]}
          />
        </label>
      </div>

      {error && <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">{error}</div>}
      <Button
        variant="solid"
        className="w-fit"
        disabled={!source || saving || (scope === "project" && !activeRepoPath)}
        onClick={() => void install()}
      >
        {saving ? "安装中..." : "安装 Skill"}
      </Button>
    </div>
  );
}

function GithubAddPanel({
  activeRepoPath,
  onInstalled,
}: {
  activeRepoPath: string | null;
  onInstalled: () => void;
}) {
  const [url, setUrl] = useState("");
  const [inspecting, setInspecting] = useState(false);
  const [inspection, setInspection] = useState<GithubRepoInspection | null>(null);
  const [selected, setSelected] = useState<GithubDetectedSkill | null>(null);
  const [scope, setScope] = useState<"user" | "project">("user");
  const [installName, setInstallName] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trustAck, setTrustAck] = useState(false);
  const confirm = useConfirm();

  const reset = () => {
    setInspection(null);
    setSelected(null);
    setInstallName("");
    setTrustAck(false);
    setError(null);
  };

  const inspect = async () => {
    setError(null);
    setInspecting(true);
    setInspection(null);
    setSelected(null);
    try {
      // Pass existing installed names so the preview can flag conflicts.
      const installed = await window.codeshell.listSkills(activeRepoPath ?? "/");
      const names = installed.map((s) => s.name);
      const result = await window.codeshell.inspectGithubSkill(url.trim(), names);
      setInspection(result);
      // Auto-select if only one skill detected.
      if (result.skills.length === 1) {
        setSelected(result.skills[0]);
        setInstallName(result.skills[0].name);
      }
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInspecting(false);
    }
  };

  const install = async () => {
    if (!inspection || !selected) return;
    if (selected.alreadyInstalled) {
      const ok = await confirm({
        title: "已存在同名 skill",
        message: `「${selected.name}」似乎已经安装。重新安装会因目录冲突而失败，先卸载旧版本再继续。`,
        confirmLabel: "知道了",
      });
      if (!ok) return;
      return;
    }
    if (!trustAck) {
      setError("请先确认信任来源");
      return;
    }
    setInstalling(true);
    setError(null);
    try {
      await window.codeshell.installFromGithub({
        inspection,
        selected,
        scope,
        cwd: scope === "project" ? activeRepoPath ?? undefined : undefined,
        installName: installName.trim() || selected.name,
      });
      onInstalled();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          className="h-9 flex-1"
          placeholder="https://github.com/owner/repo"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (inspection) reset();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim() && !inspecting) void inspect();
          }}
        />
        <Button
          variant="solid"
          disabled={!url.trim() || inspecting}
          onClick={() => void inspect()}
        >
          {inspecting ? "解析中…" : "解析"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        支持仓库 URL，或子目录形式 <code>/tree/&lt;ref&gt;/&lt;subpath&gt;</code>。
        系统会读取仓库目录树，不会自动执行任何脚本。
      </p>

      {error && <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">{error}</div>}

      {inspection && (
        <div className="rounded-md border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <strong>
              {inspection.url.owner}/{inspection.url.repo}
            </strong>
            <span className="text-xs text-muted-foreground">
              {inspection.url.ref ?? inspection.defaultBranch}
            </span>
            {inspection.isPlugin && (
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">检测到 plugin.json</span>
            )}
          </div>

          {inspection.warning && (
            <div className="rounded-md bg-status-warn/10 p-2 text-sm text-status-warn">{inspection.warning}</div>
          )}

          {inspection.skills.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">没有可安装的 skill</div>
          ) : (
            <div className="grid gap-2">
              {inspection.skills.map((s) => {
                const isSelected = selected?.dirInRepo === s.dirInRepo;
                return (
                  <Button
                    type="button"
                    variant="outline"
                    key={s.dirInRepo}
                    className={cn(
                      "h-auto flex-col items-start p-3 text-left",
                      isSelected && "border-primary bg-primary/10",
                    )}
                    onClick={() => {
                      setSelected(s);
                      setInstallName(s.name);
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <strong>{s.name}</strong>
                      {s.alreadyInstalled && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">已安装</span>
                      )}
                    </div>
                    {s.description && (
                      <div className="mt-1 text-xs text-muted-foreground">{s.description}</div>
                    )}
                    <div className="mt-1 font-mono text-xs text-muted-foreground">{s.dirInRepo}</div>
                  </Button>
                );
              })}
            </div>
          )}

          {selected && (
            <div className="mt-3 rounded-md border p-3">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                  <span>安装名称</span>
                  <Input
                    value={installName}
                    onChange={(e) => setInstallName(e.target.value)}
                    placeholder={selected.name}
                  />
                </label>
                <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                  <span>安装位置</span>
                  <Select<"user" | "project">
                    value={scope}
                    onChange={setScope}
                    options={[
                      { value: "user", label: "全局" },
                      {
                        value: "project",
                        label: "当前项目",
                        description: activeRepoPath ?? "未选中项目",
                        disabled: !activeRepoPath,
                      },
                    ]}
                  />
                </label>
              </div>

              <div className="mt-3">
                <label className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Switch
                    checked={trustAck}
                    onCheckedChange={setTrustAck}
                  />
                  <span>
                    我已确认信任 {inspection.url.owner}/{inspection.url.repo}。
                    远程仓库的内容会被复制到本地 skills 目录，但不会被自动执行。
                  </span>
                </label>
              </div>

              <Button
                variant="solid"
                className="w-fit"
                disabled={
                  installing ||
                  !trustAck ||
                  selected.alreadyInstalled ||
                  (scope === "project" && !activeRepoPath)
                }
                onClick={() => void install()}
              >
                {installing
                  ? "安装中…"
                  : selected.alreadyInstalled
                    ? "已安装"
                    : `安装「${installName || selected.name}」`}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
