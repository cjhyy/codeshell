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
import type {
  GithubDetectedSkill,
  GithubRepoInspection,
  PluginSummary,
  SkillSummary,
} from "../../preload/types";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { useConfirm } from "../ui/ConfirmDialog";
import { Markdown } from "../Markdown";
import { writeSettings } from "../settingsBus";

interface Props {
  activeRepoPath: string | null;
}

export function PluginsAndSkillsSection({ activeRepoPath }: Props) {
  return (
    <section className="settings-section ps-section customize-host">
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

function CustomizePage({ activeRepoPath }: { activeRepoPath: string | null }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [disabledSet, setDisabledSet] = useState<Set<string>>(new Set());
  // Bare plugin names disabled at the plugin level. Distinct from disabledSet
  // (per-skill): this is what suppresses a plugin's hooks too (e.g.
  // superpowers' SessionStart injection), since loadPluginHooks reads
  // disabledPlugins — disabledSkills alone never reaches the hook path.
  const [disabledPluginsSet, setDisabledPluginsSet] = useState<Set<string>>(
    new Set(),
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
      setDisabledSet(new Set(Array.isArray(ds) ? (ds as string[]) : []));
      const dp = settings?.disabledPlugins;
      setDisabledPluginsSet(new Set(Array.isArray(dp) ? (dp as string[]) : []));
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

  if (error) return <div className="view-error">{error}</div>;
  if (!skills) return <div className="view-loading">加载中…</div>;

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
      alert(String(e instanceof Error ? e.message : e));
    }
  };

  const onSelectPlugin = (row: PluginRow) =>
    setSelection({ kind: "plugin", pluginKey: row.key });
  const onSelectSkill = (s: SkillSummary) =>
    setSelection({ kind: "skill", skillName: s.name });
  const onSelectAddPanel = () => setSelection({ kind: "addPanel" });

  const isAddPanelActive = selection.kind === "addPanel";

  return (
    <div className="customize-three-pane">
      {/* ── Left pane: plugin list ────────────────────────────────── */}
      <aside className="customize-pane">
        <ul className="customize-plugin-list">
          {pluginRows.map((row) => {
            const isSelected =
              (selection.kind === "plugin" && selection.pluginKey === row.key) ||
              (selection.kind === "skill" &&
                selectedPluginRow?.key === row.key);
            const groupState = pluginGroupState(row.key);
            return (
              <li
                key={row.key}
                className={`customize-plugin-row${isSelected ? " is-selected" : ""}`}
                onClick={() => onSelectPlugin(row)}
              >
                {!row.synthetic ? (
                  <label
                    className="customize-plugin-row-check"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={groupState === "all"}
                      ref={(el) => {
                        if (el) el.indeterminate = groupState === "some";
                      }}
                      onChange={() =>
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
                    className="customize-plugin-row-check"
                    aria-hidden
                    style={{ width: 16 }}
                  />
                )}
                <div className="customize-plugin-row-main">
                  <span className="customize-plugin-row-name">{row.label}</span>
                  <span className="customize-plugin-row-source">
                    {row.sourceLabel}
                  </span>
                  <span className="customize-plugin-row-count">
                    {row.skillCount} skill{row.skillCount === 1 ? "" : "s"}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className={`customize-plugin-add${isAddPanelActive ? " is-active" : ""}`}
          onClick={onSelectAddPanel}
        >
          + 添加插件
        </button>
      </aside>

      {/* ── Middle pane: skill list ───────────────────────────────── */}
      <section className="customize-pane">
        <div className="customize-toolbar">
          <input
            className="sessions-filter"
            placeholder="搜索 skill"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            className="approval-btn deny"
            onClick={() => void refresh()}
            title="刷新"
          >
            刷新
          </button>
        </div>
        {selectedPluginRow ? (
          middleSkills.length === 0 ? (
            <div className="customize-empty">
              {filter ? "没有匹配的 skill" : "该插件未提供 skill"}
            </div>
          ) : (
            <ul className="customize-skill-list">
              {middleSkills.map((s) => {
                const isDisabled = disabledSet.has(s.name);
                const isSelected =
                  selection.kind === "skill" && selection.skillName === s.name;
                return (
                  <li
                    key={s.filePath}
                    className={`customize-skill-row${isSelected ? " is-selected" : ""}`}
                    onClick={() => onSelectSkill(s)}
                  >
                    <label
                      className="customize-skill-row-check"
                      onClick={(e) => e.stopPropagation()}
                      title="启用 / 禁用"
                    >
                      <input
                        type="checkbox"
                        checked={!isDisabled}
                        onChange={() =>
                          void toggleSkillDisabled(s.name, !isDisabled)
                        }
                      />
                    </label>
                    <div className="customize-skill-row-main">
                      <span className="customize-skill-row-name">
                        {selectedPluginRow.synthetic ? s.name : shortNameOf(s)}
                      </span>
                      {s.description && (
                        <span className="customize-skill-row-desc">
                          {s.description.split("\n")[0]}
                        </span>
                      )}
                    </div>
                    {s.source !== "plugin" && (
                      <button
                        className="customize-skill-row-kebab"
                        title="卸载"
                        onClick={(e) => {
                          e.stopPropagation();
                          void uninstallOne(s);
                        }}
                      >
                        ⋯
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <div className="customize-empty">选择左侧任一插件查看其 skill</div>
        )}
      </section>

      {/* ── Right pane: detail / plugin card / AddPanel ───────────── */}
      <section className="customize-pane customize-detail">
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
                <div className="customize-empty">该 skill 不存在或已被移除</div>
              );
            }
            return (
              <>
                <header className="customize-detail-head">
                  <span className="customize-detail-name">{s.name}</span>
                  <span className={`skill-source skill-source-${s.source}`}>
                    {s.source}
                  </span>
                  <div className="customize-detail-actions">
                    <button
                      className="skills-row-icon-btn"
                      onClick={() => {
                        void navigator.clipboard.writeText(s.name);
                      }}
                      title="复制 skill 名称"
                    >
                      复制名称
                    </button>
                    <button
                      className="skills-row-icon-btn"
                      onClick={() => void window.codeshell.revealInFinder(s.filePath)}
                      title="在 Finder 中显示"
                    >
                      定位
                    </button>
                    {s.source !== "plugin" && (
                      <button
                        className="skills-row-icon-btn danger"
                        onClick={() => void uninstallOne(s)}
                        title="卸载"
                      >
                        卸载
                      </button>
                    )}
                  </div>
                  <span className="customize-detail-path">{s.filePath}</span>
                </header>
                <div className="customize-detail-body">
                  {skillBody === null ? (
                    <div className="view-loading">加载中…</div>
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
          <div className="customize-empty">
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
      <div className="customize-plugin-card">
        <header className="customize-detail-head">
          <span className="customize-detail-name">{row.label}</span>
        </header>
        <div className="customize-plugin-card-row">
          <span className="label">说明</span>
          <span className="value">
            来自 user / project 范围的本地 skill。可在中间栏单独启用或禁用。
          </span>
        </div>
        <div className="customize-plugin-card-row">
          <span className="label">数量</span>
          <span className="value">{row.skillCount}</span>
        </div>
      </div>
    );
  }
  const p = row.summary;
  if (!p) return null;
  return (
    <div className="customize-plugin-card">
      <header className="customize-detail-head">
        <span className="customize-detail-name">{p.name}</span>
        <span className={`skill-source skill-source-plugin`}>plugin</span>
      </header>
      {p.description && (
        <div className="customize-plugin-card-row">
          <span className="label">描述</span>
          <span className="value">{p.description}</span>
        </div>
      )}
      <div className="customize-plugin-card-row">
        <span className="label">来源</span>
        <span className="value">{p.sourceLabel}</span>
      </div>
      {p.marketplace && (
        <div className="customize-plugin-card-row">
          <span className="label">Marketplace</span>
          <span className="value">{p.marketplace}</span>
        </div>
      )}
      <div className="customize-plugin-card-row">
        <span className="label">版本</span>
        <span className="value">{p.version || "(未知)"}</span>
      </div>
      <div className="customize-plugin-card-row">
        <span className="label">安装位置</span>
        <span className="value">{p.installPath}</span>
      </div>
      <div className="customize-plugin-card-row">
        <span className="label">Skill 数量</span>
        <span className="value">{p.skillCount}</span>
      </div>
      <div className="customize-plugin-card-row">
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
    <div className="skills-panel">
      <div className="add-source-tabs">
        <button
          className={`add-source-tab${source === "github" ? " active" : ""}`}
          onClick={() => setSource("github")}
        >
          从 GitHub 安装
        </button>
        <button
          className={`add-source-tab${source === "local" ? " active" : ""}`}
          onClick={() => setSource("local")}
        >
          从本地文件夹
        </button>
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
    <div className="add-panel-body">
      <div className="settings-option-grid">
        <button className="settings-option-card" onClick={() => void choose()}>
          <span className="settings-option-title">选择本地文件夹</span>
          <span className="settings-option-desc">需要包含 SKILL.md。</span>
        </button>
      </div>

      <div className="settings-form-grid">
        <label className="settings-field">
          <span>来源文件夹</span>
          <input value={source?.path ?? ""} readOnly placeholder="选择一个 Skill 文件夹" />
        </label>
        <label className="settings-field">
          <span>安装名称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="skill-name" />
        </label>
        <label className="settings-field">
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

      {error && <div className="view-error">{error}</div>}
      <button
        className="approval-btn approve settings-save-btn"
        disabled={!source || saving || (scope === "project" && !activeRepoPath)}
        onClick={() => void install()}
      >
        {saving ? "安装中..." : "安装 Skill"}
      </button>
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
    <div className="add-panel-body">
      <div className="github-input-row">
        <input
          className="github-url-input"
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
        <button
          className="approval-btn approve"
          disabled={!url.trim() || inspecting}
          onClick={() => void inspect()}
        >
          {inspecting ? "解析中…" : "解析"}
        </button>
      </div>
      <p className="github-url-hint">
        支持仓库 URL，或子目录形式 <code>/tree/&lt;ref&gt;/&lt;subpath&gt;</code>。
        系统会读取仓库目录树，不会自动执行任何脚本。
      </p>

      {error && <div className="view-error">{error}</div>}

      {inspection && (
        <div className="github-preview">
          <div className="github-preview-head">
            <strong>
              {inspection.url.owner}/{inspection.url.repo}
            </strong>
            <span className="session-meta">
              {inspection.url.ref ?? inspection.defaultBranch}
            </span>
            {inspection.isPlugin && (
              <span className="github-plugin-pill">检测到 plugin.json</span>
            )}
          </div>

          {inspection.warning && (
            <div className="github-warning">{inspection.warning}</div>
          )}

          {inspection.skills.length === 0 ? (
            <div className="approvals-empty">没有可安装的 skill</div>
          ) : (
            <div className="github-skill-list">
              {inspection.skills.map((s) => {
                const isSelected = selected?.dirInRepo === s.dirInRepo;
                return (
                  <button
                    key={s.dirInRepo}
                    className={`github-skill-card${isSelected ? " is-selected" : ""}`}
                    onClick={() => {
                      setSelected(s);
                      setInstallName(s.name);
                    }}
                  >
                    <div className="github-skill-name">
                      <strong>{s.name}</strong>
                      {s.alreadyInstalled && (
                        <span className="github-skill-installed">已安装</span>
                      )}
                    </div>
                    {s.description && (
                      <div className="github-skill-desc">{s.description}</div>
                    )}
                    <div className="github-skill-path">{s.dirInRepo}</div>
                  </button>
                );
              })}
            </div>
          )}

          {selected && (
            <div className="github-install-block">
              <div className="settings-form-grid">
                <label className="settings-field">
                  <span>安装名称</span>
                  <input
                    value={installName}
                    onChange={(e) => setInstallName(e.target.value)}
                    placeholder={selected.name}
                  />
                </label>
                <label className="settings-field">
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

              <div className="github-trust-row">
                <label className="github-trust-label">
                  <input
                    type="checkbox"
                    checked={trustAck}
                    onChange={(e) => setTrustAck(e.target.checked)}
                  />
                  <span>
                    我已确认信任 {inspection.url.owner}/{inspection.url.repo}。
                    远程仓库的内容会被复制到本地 skills 目录，但不会被自动执行。
                  </span>
                </label>
              </div>

              <button
                className="approval-btn approve settings-save-btn"
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
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
