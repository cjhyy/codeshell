import React, { useCallback, useEffect, useState } from "react";
import type {
  McpProbeResult,
  McpServerProbeInput,
} from "../../preload/types";

interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: "stdio" | "streamable-http" | "sse";
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export function McpView() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = (await window.codeshell.getSettings("user")) ?? {};
      const list = parseServers(s.mcpServers);
      setServers(list);
      if (list.length > 0) void probe(list, false);
      else setProbes({});
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  const probe = useCallback(async (list: McpServer[], force: boolean) => {
    setBusy(true);
    try {
      const inputs: McpServerProbeInput[] = list.map((s) => ({
        name: s.name,
        command: s.command,
        args: s.args,
        env: s.env,
        url: s.url,
        transport: s.transport,
        headers: s.headers,
      }));
      const results = await window.codeshell.probeMcpServers(inputs, force);
      const map: Record<string, McpProbeResult> = {};
      for (const r of results) map[r.name] = r;
      setProbes(map);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <div className="view-error">{error}</div>;
  if (!servers) return <div className="view-loading">加载中…</div>;

  return (
    <div className="mcp-view">
      <header className="mcp-section-head">
        <h2 className="approvals-section-title">
          MCP 服务器 <span className="approvals-count">{servers.length}</span>
        </h2>
        <button
          className="approval-btn deny"
          onClick={() => void probe(servers, true)}
          disabled={servers.length === 0 || busy}
        >
          {busy ? "测试中…" : "重新测试"}
        </button>
      </header>

      {servers.length === 0 ? (
        <div className="mcp-empty">
          <div className="mcp-empty-title">没有配置的 MCP 服务器</div>
          <div className="mcp-empty-hint">到「设置 → MCP 服务器」添加。</div>
        </div>
      ) : (
        <div className="mcp-card-list">
          {servers.map((s) => {
            const p = probes[s.name];
            const transport = s.transport ?? (s.url ? "streamable-http" : "stdio");
            const target = s.command
              ? [s.command, ...(s.args ?? [])].join(" ")
              : s.url ?? "";
            return (
              <article key={s.name} className="mcp-card">
                <div className="mcp-card-head">
                  <div className="mcp-card-title">
                    <strong>{s.name}</strong>
                    <span className={`mcp-transport-pill mcp-transport-${transport}`}>
                      {transport === "stdio" ? "stdio" : transport === "sse" ? "SSE" : "HTTP"}
                    </span>
                    <StatusPill probe={p} loading={busy && !p} />
                  </div>
                  {p?.status === "ok" && (
                    <span className="mcp-card-stamp">{p.toolCount ?? 0} tools</span>
                  )}
                </div>
                {target && (
                  <div className="mcp-card-target" title={target}>
                    <code>{target}</code>
                  </div>
                )}
                {p?.status === "error" && (
                  <div className="mcp-card-meta">
                    <span className="mcp-card-error-msg" style={{ color: "var(--status-err)" }}>
                      {p.errorMessage}
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function StatusPill({ probe, loading }: { probe?: McpProbeResult; loading: boolean }) {
  if (loading || probe?.status === "probing") return <span className="mcp-status-pill probing">连接中…</span>;
  if (!probe) return <span className="mcp-status-pill unknown">未测试</span>;
  if (probe.status === "ok") return <span className="mcp-status-pill ok">已连接</span>;
  if (probe.status === "error") return <span className="mcp-status-pill err">连接失败</span>;
  return <span className="mcp-status-pill unknown">未知</span>;
}

function parseServers(value: unknown): McpServer[] {
  if (Array.isArray(value)) {
    return value.filter(
      (x): x is McpServer => !!x && typeof x === "object" && typeof (x as McpServer).name === "string",
    );
  }
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
