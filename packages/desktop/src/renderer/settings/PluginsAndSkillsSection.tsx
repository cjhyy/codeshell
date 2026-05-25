import React, { useEffect, useState } from "react";
import type { SkillSummary } from "../../preload/types";

interface McpServer {
  name: string;
  command?: string;
  url?: string;
  transport?: string;
}

interface Props {
  activeRepoPath: string | null;
}

export function PluginsAndSkillsSection({ activeRepoPath }: Props) {
  const [tab, setTab] = useState<"plugins" | "skills" | "available">("plugins");

  return (
    <section className="settings-section ps-section">
      <div className="settings-scope">
        <button
          className={`logs-bucket${tab === "plugins" ? " active" : ""}`}
          onClick={() => setTab("plugins")}
        >
          已安装插件
        </button>
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

      {tab === "plugins" && <InstalledPlugins />}
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

function InstalledPlugins() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const s = (await window.codeshell.getSettings("user")) ?? {};
      setServers(mcpServersFromSettings(s.mcpServers));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // No "disable" toggle: core only reads `mcpServers`. A separate
  // `disabledMcpServers` bucket would be UI-only state that no part of
  // the engine consults, so toggling it back to "enabled" later would
  // be a lie. Removing the server is the only honest verb here; users
  // can re-add via 「MCP 服务器」 if they need it again.
  const remove = async (server: McpServer) => {
    if (!confirm(`移除 MCP 插件「${server.name}」？\n要重新启用需要再次添加。`)) return;
    try {
      await window.codeshell.updateSettings("user", { mcpServers: { [server.name]: null } });
      await refresh();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  if (error) return <div className="view-error">{error}</div>;
  if (!servers) return <div className="view-loading">加载中…</div>;

  if (servers.length === 0) {
    return (
      <div className="approvals-empty">
        没有已安装的 MCP 插件。到「MCP 服务器」模块添加。
      </div>
    );
  }

  return (
    <ul className="mcp-list">
      {servers.map((s) => (
        <li key={s.name} className="mcp-row">
          <div className="mcp-row-head">
            <strong>{s.name}</strong>
            <span className="session-meta">{s.transport ?? (s.url ? "http" : "stdio")}</span>
            <button
              className="approval-btn deny"
              onClick={() => void remove(s)}
              title="下次启动 engine 时移除"
            >
              移除
            </button>
          </div>
          {(s.command || s.url) && (
            <div className="mcp-row-detail">
              <code>{s.command ?? s.url}</code>
            </div>
          )}
        </li>
      ))}
    </ul>
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
          <select value={scope} onChange={(e) => setScope(e.target.value as "user" | "project")}>
            <option value="user">user</option>
            <option value="project" disabled={!activeRepoPath}>project</option>
          </select>
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

function mcpServersFromSettings(value: unknown): McpServer[] {
  if (Array.isArray(value)) return value as McpServer[];
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([name, raw]) => ({
        name,
        ...(raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {}),
      }))
      .filter((x): x is McpServer => typeof x.name === "string");
  }
  return [];
}
