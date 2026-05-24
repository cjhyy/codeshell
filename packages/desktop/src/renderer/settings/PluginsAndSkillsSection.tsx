import React, { useEffect, useState } from "react";

interface McpServer {
  name: string;
  command?: string;
  url?: string;
  transport?: string;
}

interface Props {
  activeRepoPath: string | null;
}

/**
 * Plugins + Skills management module of the Settings page.
 *
 * Phase E ships the layout + installed MCP/plugins list (re-read from
 * settings.json). Skill listing is wired in batch F once the core
 * exposes a skills IPC — until then we show a 'no API yet' note for
 * that tab.
 */
export function PluginsAndSkillsSection({ activeRepoPath }: Props) {
  const [tab, setTab] = useState<"plugins" | "skills" | "available">("plugins");
  void activeRepoPath;

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
      {tab === "skills" && <InstalledSkills />}
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

function InstalledSkills() {
  // Skills are core-side artefacts (filesystem under ~/.code-shell/plugins/...).
  // Wiring the IPC to enumerate them lands in batch F.
  return (
    <div className="approvals-empty">
      Skill 列表需要 core 端 IPC 支持，将在下一批迭代中接通。
    </div>
  );
}

function AddPanel() {
  return (
    <div className="approvals-empty">
      添加插件/skill 的 UI 即将上线。当前请直接编辑 settings.json 添加
      <code style={{ marginLeft: 6 }}>mcpServers</code> 条目。
    </div>
  );
}
