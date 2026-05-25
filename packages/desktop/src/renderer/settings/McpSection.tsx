import React, { useEffect, useState } from "react";

interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

export function McpSection({ scope, activeRepoPath }: Props) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    setError(null);
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const list = (s.mcpServers as unknown) ?? [];
    setServers(mcpServersFromSettings(list));
  };

  useEffect(() => {
    void load();
  }, [scope, activeRepoPath]);

  const persist = async (next: McpServer[]) => {
    const record = Object.fromEntries(next.map((server) => [server.name, server]));
    await window.codeshell.updateSettings(scope, { mcpServers: record }, cwd);
    setServers(next);
  };

  const remove = (name: string) => {
    void (async () => {
      await window.codeshell.updateSettings(scope, { mcpServers: { [name]: null } }, cwd);
      setServers((cur) => cur.filter((s) => s.name !== name));
    })();
  };

  const add = async () => {
    setError(null);
    try {
      const parsed = JSON.parse(draft) as McpServer;
      if (!parsed || typeof parsed !== "object" || typeof parsed.name !== "string") {
        throw new Error("需要至少包含 name 字段");
      }
      const next = [...servers.filter((s) => s.name !== parsed.name), parsed];
      await persist(next);
      setDraft("");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section-title">MCP servers</h3>
      {servers.length === 0 ? (
        <div className="approvals-empty">暂未配置</div>
      ) : (
        <ul className="mcp-list">
          {servers.map((s) => (
            <li key={s.name} className="mcp-row">
              <div className="mcp-row-head">
                <strong>{s.name}</strong>
                <span className="session-meta">{s.transport ?? (s.url ? "http" : "stdio")}</span>
                <button className="session-delete" onClick={() => remove(s.name)}>
                  删除
                </button>
              </div>
              {s.command && (
                <div className="mcp-row-detail">
                  <code>{s.command}</code>
                  {s.args && s.args.length > 0 && <code> {s.args.join(" ")}</code>}
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
      <details className="mcp-add">
        <summary>+ 添加 MCP server</summary>
        <textarea
          className="settings-editor"
          style={{ minHeight: 120 }}
          placeholder={`{
  "name": "playwright",
  "command": "npx",
  "args": ["-y", "@playwright/mcp@latest"]
}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="settings-toolbar" style={{ marginTop: "var(--sp-2)" }}>
          {error && <span className="view-error">{error}</span>}
          <button className="approval-btn approve" onClick={() => void add()}>
            添加
          </button>
        </div>
      </details>
    </section>
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
