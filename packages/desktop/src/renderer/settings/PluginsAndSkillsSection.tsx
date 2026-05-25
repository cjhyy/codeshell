import React, { useEffect, useMemo, useState } from "react";
import type { SkillSummary } from "../../preload/types";
import { Select } from "../ui/Select";
import { useConfirm } from "../ui/ConfirmDialog";

interface Props {
  activeRepoPath: string | null;
}

export function PluginsAndSkillsSection({ activeRepoPath }: Props) {
  const [tab, setTab] = useState<"skills" | "available">("skills");

  return (
    <section className="settings-section ps-section">
      <div className="settings-scope">
        <button
          className={`logs-bucket${tab === "skills" ? " active" : ""}`}
          onClick={() => setTab("skills")}
        >
          已安装 Skills
        </button>
        <button
          className={`logs-bucket${tab === "available" ? " active" : ""}`}
          onClick={() => setTab("available")}
        >
          添加
        </button>
      </div>

      {tab === "skills" && <InstalledSkills activeRepoPath={activeRepoPath} />}
      {tab === "available" && (
        <AddPanel
          activeRepoPath={activeRepoPath}
          onInstalled={() => setTab("skills")}
        />
      )}
    </section>
  );
}

interface GroupedSkills {
  namespace: string;
  /** True when the namespace key is the synthetic "其他" bucket. */
  synthetic: boolean;
  skills: SkillSummary[];
}

const STANDALONE_NAMESPACE = "__standalone__";

function groupSkills(skills: SkillSummary[]): GroupedSkills[] {
  const map = new Map<string, SkillSummary[]>();
  for (const s of skills) {
    const idx = s.name.indexOf(":");
    const ns = idx > 0 ? s.name.slice(0, idx) : STANDALONE_NAMESPACE;
    if (!map.has(ns)) map.set(ns, []);
    map.get(ns)!.push(s);
  }
  const groups: GroupedSkills[] = [];
  for (const [ns, list] of map) {
    list.sort((a, b) => a.name.localeCompare(b.name));
    groups.push({
      namespace: ns,
      synthetic: ns === STANDALONE_NAMESPACE,
      skills: list,
    });
  }
  // Synthetic bucket always last; otherwise alphabetic by namespace.
  groups.sort((a, b) => {
    if (a.synthetic && !b.synthetic) return 1;
    if (!a.synthetic && b.synthetic) return -1;
    return a.namespace.localeCompare(b.namespace);
  });
  return groups;
}

function shortNameOf(s: SkillSummary): string {
  const idx = s.name.indexOf(":");
  return idx > 0 ? s.name.slice(idx + 1) : s.name;
}

function InstalledSkills({ activeRepoPath }: { activeRepoPath: string | null }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [viewing, setViewing] = useState<{ skill: SkillSummary; body: string } | null>(null);
  const [disabledSet, setDisabledSet] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const confirm = useConfirm();

  const cwd = activeRepoPath ?? "/";

  const refresh = async () => {
    try {
      const [list, settings] = await Promise.all([
        window.codeshell.listSkills(cwd),
        window.codeshell.getSettings("user"),
      ]);
      setSkills(list);
      const disabled = settings?.disabledSkills;
      setDisabledSet(new Set(Array.isArray(disabled) ? (disabled as string[]) : []));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, [activeRepoPath]);

  const filtered = useMemo(() => {
    if (!skills) return [];
    if (!filter.trim()) return skills;
    const needle = filter.toLowerCase();
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(needle) ||
        s.description.toLowerCase().includes(needle),
    );
  }, [skills, filter]);

  const groups = useMemo(() => groupSkills(filtered), [filtered]);

  if (error) return <div className="view-error">{error}</div>;
  if (!skills) return <div className="view-loading">加载中…</div>;

  const toggleDisabled = async (names: string[], shouldDisable: boolean) => {
    const next = new Set(disabledSet);
    for (const n of names) {
      if (shouldDisable) next.add(n);
      else next.delete(n);
    }
    setDisabledSet(next);
    await window.codeshell.updateSettings("user", { disabledSkills: [...next] });
  };

  const openView = async (s: SkillSummary) => {
    try {
      const body = await window.codeshell.readSkillBody(s.filePath);
      setViewing({ skill: s, body });
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    }
  };

  const toggleCollapsed = (ns: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(ns)) next.delete(ns);
      else next.add(ns);
      return next;
    });
  };

  const toggleSelected = (name: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAllInGroup = (g: GroupedSkills, selectAll: boolean) => {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const s of g.skills) {
        if (selectAll) next.add(s.name);
        else next.delete(s.name);
      }
      return next;
    });
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
      setSelected((cur) => {
        const next = new Set(cur);
        next.delete(s.name);
        return next;
      });
      await refresh();
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    }
  };

  const batchUninstall = async () => {
    if (selected.size === 0) return;
    const targets = skills.filter((s) => selected.has(s.name));
    const pluginOnes = targets.filter((s) => s.source === "plugin");
    const removable = targets.filter((s) => s.source !== "plugin");
    if (removable.length === 0) {
      await confirm({
        title: "无法批量卸载",
        message: "所选都是 plugin skill，无法在此处卸载。使用「批量禁用」隐藏它们。",
        confirmLabel: "知道了",
      });
      return;
    }
    const ok = await confirm({
      title: "批量卸载",
      message: `将卸载 ${removable.length} 个 skill${pluginOnes.length > 0 ? `，跳过 ${pluginOnes.length} 个 plugin skill` : ""}。\n该操作会从磁盘删除文件夹，不可恢复。`,
      detail: removable.map((s) => s.name).join("\n"),
      confirmLabel: `卸载 ${removable.length} 个`,
      destructive: true,
    });
    if (!ok) return;
    for (const s of removable) {
      try {
        await window.codeshell.uninstallSkill(s.filePath, s.source);
      } catch (e) {
        console.error("uninstall failed", s.name, e);
      }
    }
    setSelected(new Set());
    await refresh();
  };

  const batchDisable = async (shouldDisable: boolean) => {
    if (selected.size === 0) return;
    await toggleDisabled([...selected], shouldDisable);
  };

  const allSelectedInGroup = (g: GroupedSkills) =>
    g.skills.length > 0 && g.skills.every((s) => selected.has(s.name));

  return (
    <div className="skills-panel">
      <div className="settings-toolbar skills-toolbar">
        <input
          className="sessions-filter"
          placeholder="搜索 skill"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button className="approval-btn deny" onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {selected.size > 0 && (
        <div className="skills-batch-bar">
          <span className="skills-batch-count">{selected.size} 个已选</span>
          <button
            className="approval-btn deny"
            onClick={() => void batchDisable(true)}
          >
            批量禁用
          </button>
          <button
            className="approval-btn deny"
            onClick={() => void batchDisable(false)}
          >
            批量启用
          </button>
          <button
            className="approval-btn deny skills-batch-danger"
            onClick={() => void batchUninstall()}
          >
            批量卸载
          </button>
          <button
            className="skills-batch-clear"
            onClick={() => setSelected(new Set())}
          >
            取消选择
          </button>
        </div>
      )}

      {groups.length === 0 ? (
        <div className="approvals-empty">没有匹配的 skill</div>
      ) : (
        <div className="skill-group-list">
          {groups.map((g) => {
            const isCollapsed = collapsed.has(g.namespace);
            const enabledCount = g.skills.filter((s) => !disabledSet.has(s.name)).length;
            const allSelected = allSelectedInGroup(g);
            const someSelected =
              !allSelected && g.skills.some((s) => selected.has(s.name));

            return (
              <section
                key={g.namespace}
                className={`skill-group${isCollapsed ? " is-collapsed" : ""}`}
              >
                <header
                  className="skill-group-head"
                  onClick={() => toggleCollapsed(g.namespace)}
                >
                  <span className="skill-group-toggle" aria-hidden>
                    {isCollapsed ? "▸" : "▾"}
                  </span>
                  <label
                    className="skill-group-check"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={allSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someSelected;
                      }}
                      onChange={(e) => selectAllInGroup(g, e.target.checked)}
                    />
                  </label>
                  <strong className="skill-group-name">
                    {g.synthetic ? "未分组" : g.namespace}
                  </strong>
                  <span className="skill-group-meta">
                    {enabledCount}/{g.skills.length} 启用
                  </span>
                  {g.skills[0]?.source && !g.synthetic && (
                    <span className={`skill-source skill-source-${g.skills[0].source}`}>
                      {g.skills[0].source}
                    </span>
                  )}
                </header>

                {!isCollapsed && (
                  <ul className="skill-list">
                    {g.skills.map((s) => {
                      const isDisabled = disabledSet.has(s.name);
                      const isSelected = selected.has(s.name);
                      return (
                        <li
                          key={s.filePath}
                          className={`skill-row${isDisabled ? " disabled" : ""}${isSelected ? " is-selected" : ""}`}
                        >
                          <label
                            className="skill-row-check"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleSelected(s.name)}
                            />
                          </label>
                          <div className="skill-row-main">
                            <div className="skill-row-head">
                              <strong className="skill-row-name">
                                {g.synthetic ? s.name : shortNameOf(s)}
                              </strong>
                              <span className={`skill-source skill-source-${s.source}`}>
                                {s.source}
                              </span>
                            </div>
                            {s.description && (
                              <div className="skill-row-desc">{s.description}</div>
                            )}
                            <div className="skill-row-path">{s.filePath}</div>
                          </div>
                          <div className="skill-row-actions">
                            <button
                              className="skills-row-icon-btn"
                              onClick={() => void openView(s)}
                              title="查看 SKILL.md"
                            >
                              查看
                            </button>
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
                            <button
                              className="skills-row-icon-btn danger"
                              onClick={() => void uninstallOne(s)}
                              title={s.source === "plugin" ? "plugin skill 不能在此处卸载" : "卸载"}
                            >
                              卸载
                            </button>
                            <label className="skill-toggle" title="启用 / 禁用">
                              <input
                                type="checkbox"
                                checked={!isDisabled}
                                onChange={() => void toggleDisabled([s.name], !isDisabled)}
                              />
                            </label>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}

      {viewing && (
        <div className="skill-view-backdrop" onClick={() => setViewing(null)}>
          <div className="skill-view" onClick={(e) => e.stopPropagation()}>
            <header className="skill-view-head">
              <strong>{viewing.skill.name}</strong>
              <span className="session-meta">{viewing.skill.source}</span>
              <button className="approval-btn deny" onClick={() => setViewing(null)}>
                关闭
              </button>
            </header>
            <pre className="skill-view-body">{viewing.body}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

function AddPanel({
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
    <div className="skills-panel">
      <div className="settings-option-grid">
        <button className="settings-option-card" onClick={() => void choose()}>
          <span className="settings-option-title">导入本地 Skill</span>
          <span className="settings-option-desc">选择一个包含 SKILL.md 的文件夹。</span>
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

