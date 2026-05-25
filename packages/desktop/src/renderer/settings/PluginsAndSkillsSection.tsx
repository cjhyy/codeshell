import React, { useEffect, useState } from "react";
import type { SkillSummary } from "../../preload/types";
import { Select } from "../ui/Select";

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

function InstalledSkills({ activeRepoPath }: { activeRepoPath: string | null }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [viewing, setViewing] = useState<{ skill: SkillSummary; body: string } | null>(null);
  const [disabledSet, setDisabledSet] = useState<Set<string>>(new Set());

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

  if (error) return <div className="view-error">{error}</div>;
  if (!skills) return <div className="view-loading">加载中…</div>;

  const filtered = filter
    ? skills.filter((s) =>
        s.name.toLowerCase().includes(filter.toLowerCase()) ||
        s.description.toLowerCase().includes(filter.toLowerCase()),
      )
    : skills;

  const toggleDisabled = async (name: string) => {
    const next = new Set(disabledSet);
    if (next.has(name)) next.delete(name);
    else next.add(name);
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

  return (
    <div className="skills-panel">
      <div className="settings-toolbar">
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

      {filtered.length === 0 ? (
        <div className="approvals-empty">没有匹配的 skill</div>
      ) : (
        <ul className="skill-list">
          {filtered.map((s) => {
            const isDisabled = disabledSet.has(s.name);
            return (
              <li key={s.filePath} className={`skill-row${isDisabled ? " disabled" : ""}`}>
                <div className="skill-row-head">
                  <strong className="skill-row-name">{s.name}</strong>
                  <span className={`skill-source skill-source-${s.source}`}>{s.source}</span>
                  <button
                    className="approval-btn deny skill-row-action"
                    onClick={() => void openView(s)}
                  >
                    查看 SKILL.md
                  </button>
                  <label className="skill-toggle" title="启用 / 禁用">
                    <input
                      type="checkbox"
                      checked={!isDisabled}
                      onChange={() => void toggleDisabled(s.name)}
                    />
                  </label>
                </div>
                {s.description && (
                  <div className="skill-row-desc">{s.description}</div>
                )}
                <div className="skill-row-path">{s.filePath}</div>
              </li>
            );
          })}
        </ul>
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

