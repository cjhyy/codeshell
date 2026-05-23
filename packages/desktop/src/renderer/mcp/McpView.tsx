import React, { useEffect, useState } from "react";

interface McpServer {
  name: string;
  command?: string;
  url?: string;
  transport?: string;
}

export function McpView() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const s = (await window.codeshell.getSettings("user")) ?? {};
      const list = s.mcpServers;
      setServers(Array.isArray(list) ? (list as McpServer[]) : []);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (error) return <div className="view-error">{error}</div>;
  if (!servers) return <div className="view-loading">加载中…</div>;

  return (
    <div className="mcp-view">
      <h2 className="approvals-section-title">
        MCP 插件 <span className="approvals-count">{servers.length}</span>
      </h2>
      {servers.length === 0 ? (
        <div className="approvals-empty">
          没有配置的 MCP server。到「设置 → MCP」添加。
        </div>
      ) : (
        <ul className="mcp-list">
          {servers.map((s) => (
            <li key={s.name} className="mcp-row">
              <div className="mcp-row-head">
                <strong>{s.name}</strong>
                <span className="session-meta">
                  {s.transport ?? (s.url ? "http" : "stdio")}
                </span>
              </div>
              {s.command && (
                <div className="mcp-row-detail">
                  <code>{s.command}</code>
                </div>
              )}
              {s.url && (
                <div className="mcp-row-detail">
                  <code>{s.url}</code>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="settings-section-help">
        重启 desktop 后 worker 会重新加载这些插件；连接状态需要 worker
        端 `listMcpServers` RPC 才能在这里实时显示。
      </div>
    </div>
  );
}
