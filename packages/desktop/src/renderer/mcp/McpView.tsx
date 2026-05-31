import React, { useCallback, useEffect, useState } from "react";
import type {
  McpProbeResult,
  McpServerProbeInput,
} from "../../preload/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: "stdio" | "streamable-http" | "sse";
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Codex-style toggle. Absent/true = on; only false disables. */
  enabled?: boolean;
}

/** A server is on unless explicitly disabled. */
function isEnabled(s: McpServer): boolean {
  return s.enabled !== false;
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
      // Disabled servers are never connected by the engine — don't probe
      // them (probing would spawn a child + show a misleading "连接中…").
      const probeable = list.filter(isEnabled);
      if (probeable.length > 0) void probe(probeable, false);
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

  // Re-read settings when any settings writer broadcasts a change (e.g. the
  // MCP toggle in Settings → MCP). Without this McpView keeps the stale list
  // it read on mount, so a toggle "inside" settings never shows up here.
  useEffect(() => {
    window.addEventListener("codeshell:settings-changed", load);
    return () => window.removeEventListener("codeshell:settings-changed", load);
  }, [load]);

  if (error) return <div className="p-6 text-sm text-status-err">{error}</div>;
  if (!servers) return <div className="p-6 text-sm text-muted-foreground">加载中…</div>;

  return (
    <div className="flex flex-col gap-3 p-6">
      <header className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          MCP 服务器 <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{servers.length}</span>
        </h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void probe(servers.filter(isEnabled), true)}
          disabled={servers.filter(isEnabled).length === 0 || busy}
        >
          {busy ? "测试中…" : "重新测试"}
        </Button>
      </header>

      {servers.length === 0 ? (
        <div className="p-6">
          <div className="font-medium">没有配置的 MCP 服务器</div>
          <div className="mt-1 text-sm text-muted-foreground">到「设置 → MCP 服务器」添加。</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {servers.map((s) => {
            const p = probes[s.name];
            const enabled = isEnabled(s);
            const transport = s.transport ?? (s.url ? "streamable-http" : "stdio");
            const target = s.command
              ? [s.command, ...(s.args ?? [])].join(" ")
              : s.url ?? "";
            return (
              <article
                key={s.name}
                className={"rounded-lg border bg-card p-3 text-card-foreground shadow-sm " + (enabled ? "" : "opacity-60")}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <strong>{s.name}</strong>
                    <Badge variant="outline">
                      {transport === "stdio" ? "stdio" : transport === "sse" ? "SSE" : "HTTP"}
                    </Badge>
                    {enabled ? (
                      <StatusPill probe={p} loading={busy && !p} />
                    ) : (
                      <span className="text-xs text-muted-foreground">已停用</span>
                    )}
                  </div>
                  {p?.status === "ok" && (
                    <span className="text-xs text-muted-foreground">{p.toolCount ?? 0} tools</span>
                  )}
                </div>
                {target && (
                  <div className="mt-1 truncate text-xs text-muted-foreground" title={target}>
                    <code className="font-mono">{target}</code>
                  </div>
                )}
                {p?.status === "error" && (
                  <div className="mt-1 text-xs text-status-err">{p.errorMessage}</div>
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
  const base = "text-xs font-medium";
  if (loading || probe?.status === "probing") return <span className={`${base} text-status-running`}>连接中…</span>;
  if (!probe) return <span className={`${base} text-muted-foreground`}>未测试</span>;
  if (probe.status === "ok") return <span className={`${base} text-status-ok`}>已连接</span>;
  if (probe.status === "error") return <span className={`${base} text-status-err`}>连接失败</span>;
  return <span className={`${base} text-muted-foreground`}>未知</span>;
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
