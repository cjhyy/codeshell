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
      {tab === "available" && <AddPanel />}
    </section>
  );
}

function InstalledPlugins() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s = (await window.codeshell.getSettings("user")) ?? {};
        const list = s.mcpServers;
        setServers(Array.isArray(list) ? (list as McpServer[]) : []);
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      }
    })();
  }, []);

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
            <span className="model-active-badge">enabled</span>
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

function AddPanel() {
  return (
    <div className="approvals-empty">
      添加 skill 的入口将在后续版本上线。当前可以把 SKILL.md 放进
      <code style={{ margin: "0 4px" }}>~/.claude/skills/&lt;name&gt;/</code>
      或 <code style={{ margin: "0 4px" }}>.code-shell/skills/&lt;name&gt;/</code>，刷新即可。
    </div>
  );
}
