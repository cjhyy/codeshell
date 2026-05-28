import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  McpProbeResult,
  McpServerProbeInput,
} from "../../preload/types";
import { Select } from "../ui/Select";
import { useConfirm, truncateTitle } from "../ui/ConfirmDialog";

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

/**
 * Tell other components that read mcpServers (e.g. McpView in the sidebar)
 * to re-read settings. Same channel ModelSection / PermissionSection use.
 */
function broadcastSettingsChanged(): void {
  window.dispatchEvent(new Event("codeshell:settings-changed"));
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

type EditState =
  | { kind: "closed" }
  | { kind: "new" }
  | { kind: "edit"; original: string };

export function McpSection({ scope, activeRepoPath }: Props) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [loadingProbe, setLoadingProbe] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>({ kind: "closed" });
  const [toolsViewer, setToolsViewer] = useState<McpProbeResult | null>(null);
  const [errorDetailFor, setErrorDetailFor] = useState<McpProbeResult | null>(null);
  const confirm = useConfirm();

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
      const list = mcpServersFromSettings(s.mcpServers);
      setServers(list);
      void runProbe(list, false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [scope, cwd]);

  const runProbe = useCallback(async (list: McpServer[], force: boolean) => {
    // Disabled servers are never connected by the engine, so probing them
    // would be misleading — skip them here too.
    const probeable = list.filter(isEnabled);
    if (probeable.length === 0) {
      setProbes({});
      return;
    }
    const inputs: McpServerProbeInput[] = probeable.map((s) => ({
      name: s.name,
      command: s.command,
      args: s.args,
      env: s.env,
      url: s.url,
      transport: s.transport,
      headers: s.headers,
    }));
    setLoadingProbe(new Set(probeable.map((x) => x.name)));
    try {
      const results = await window.codeshell.probeMcpServers(inputs, force);
      setProbes((prev) => {
        const next = { ...prev };
        for (const r of results) next[r.name] = r;
        return next;
      });
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setLoadingProbe(new Set());
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = async (next: McpServer[]) => {
    const record = Object.fromEntries(next.map((s) => [s.name, stripNameFromServer(s)]));
    await window.codeshell.updateSettings(scope, { mcpServers: record }, cwd);
    setServers(next);
    broadcastSettingsChanged();
  };

  const removeServer = async (name: string) => {
    const ok = await confirm({
      title: "移除 MCP 服务器",
      message: `确认移除「${truncateTitle(name)}」？下次启动 engine 时生效；要恢复需要重新添加。`,
      confirmLabel: "移除",
      destructive: true,
    });
    if (!ok) return;
    await window.codeshell.updateSettings(scope, { mcpServers: { [name]: null } }, cwd);
    await window.codeshell.invalidateMcpProbeCache(name);
    setProbes((prev) => {
      const { [name]: _, ...rest } = prev;
      return rest;
    });
    setServers((cur) => cur.filter((s) => s.name !== name));
    broadcastSettingsChanged();
  };

  const toggleServer = async (s: McpServer) => {
    const nextEnabled = !isEnabled(s);
    // Persist just this server's full config with the flipped flag. We write
    // the whole entry (not a partial) because updateSettings merges records
    // key-by-key but replaces a server entry wholesale.
    const updated = servers.map((x) =>
      x.name === s.name ? { ...x, enabled: nextEnabled } : x,
    );
    await window.codeshell.updateSettings(
      scope,
      { mcpServers: { [s.name]: stripNameFromServer({ ...s, enabled: nextEnabled }) } },
      cwd,
    );
    setServers(updated);
    broadcastSettingsChanged();
    if (!nextEnabled) {
      // Drop the stale "connected" probe so the card doesn't look live.
      await window.codeshell.invalidateMcpProbeCache(s.name);
      setProbes((prev) => {
        const { [s.name]: _, ...rest } = prev;
        return rest;
      });
    } else {
      void runProbe(updated.filter((x) => x.name === s.name), true);
    }
  };

  const saveEdit = async (next: McpServer, originalName?: string) => {
    const others = servers.filter((s) => s.name !== originalName && s.name !== next.name);
    const updated = [...others, next];
    await persist(updated);
    if (originalName && originalName !== next.name) {
      await window.codeshell.updateSettings(scope, { mcpServers: { [originalName]: null } }, cwd);
      await window.codeshell.invalidateMcpProbeCache(originalName);
    }
    await window.codeshell.invalidateMcpProbeCache(next.name);
    setEdit({ kind: "closed" });
    void runProbe(updated, true);
  };

  const testOne = async (s: McpServer) => {
    setLoadingProbe((prev) => new Set(prev).add(s.name));
    try {
      const [r] = await window.codeshell.probeMcpServers(
        [
          {
            name: s.name,
            command: s.command,
            args: s.args,
            env: s.env,
            url: s.url,
            transport: s.transport,
            headers: s.headers,
          },
        ],
        true,
      );
      setProbes((prev) => ({ ...prev, [s.name]: r }));
    } finally {
      setLoadingProbe((prev) => {
        const next = new Set(prev);
        next.delete(s.name);
        return next;
      });
    }
  };

  return (
    <section className="settings-section">
      <header className="mcp-section-head">
        <h3 className="settings-section-title">MCP 服务器</h3>
        <div className="settings-toolbar mcp-section-actions">
          <button
            className="approval-btn deny"
            onClick={() => void runProbe(servers, true)}
            disabled={servers.length === 0 || loadingProbe.size > 0}
          >
            {loadingProbe.size > 0 ? "测试中…" : "全部测试"}
          </button>
          <button
            className="approval-btn approve"
            onClick={() => setEdit({ kind: "new" })}
          >
            添加服务器
          </button>
        </div>
      </header>

      {error && <div className="view-error">{error}</div>}

      {servers.length === 0 && edit.kind === "closed" && (
        <div className="mcp-empty">
          <div className="mcp-empty-title">还没有 MCP 服务器</div>
          <div className="mcp-empty-hint">
            MCP 服务器为代理提供额外工具。点击「添加服务器」开始配置。
          </div>
        </div>
      )}

      <div className="mcp-card-list">
        {servers.map((s) => {
          const probe = probes[s.name];
          const loading = loadingProbe.has(s.name);
          return (
            <McpCard
              key={s.name}
              server={s}
              probe={probe}
              loading={loading}
              onToggle={() => void toggleServer(s)}
              onTest={() => void testOne(s)}
              onEdit={() => setEdit({ kind: "edit", original: s.name })}
              onRemove={() => void removeServer(s.name)}
              onViewTools={() => setToolsViewer(probe ?? null)}
              onShowErrorDetail={() => setErrorDetailFor(probe ?? null)}
            />
          );
        })}
      </div>

      {edit.kind !== "closed" && (
        <McpEditor
          existingNames={servers.map((s) => s.name)}
          initial={edit.kind === "edit" ? servers.find((s) => s.name === edit.original) ?? null : null}
          onCancel={() => setEdit({ kind: "closed" })}
          onSave={(next) =>
            void saveEdit(next, edit.kind === "edit" ? edit.original : undefined)
          }
        />
      )}

      {toolsViewer && (
        <ToolsViewer probe={toolsViewer} onClose={() => setToolsViewer(null)} />
      )}
      {errorDetailFor && (
        <ErrorDetailViewer
          probe={errorDetailFor}
          onClose={() => setErrorDetailFor(null)}
        />
      )}
    </section>
  );
}

interface McpCardProps {
  server: McpServer;
  probe?: McpProbeResult;
  loading: boolean;
  onToggle: () => void;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onViewTools: () => void;
  onShowErrorDetail: () => void;
}

function McpCard({
  server,
  probe,
  loading,
  onToggle,
  onTest,
  onEdit,
  onRemove,
  onViewTools,
  onShowErrorDetail,
}: McpCardProps) {
  const transport = server.transport ?? (server.url ? "streamable-http" : "stdio");
  const target = server.command
    ? [server.command, ...(server.args ?? [])].join(" ")
    : server.url ?? "";
  const enabled = isEnabled(server);

  return (
    <article className={`mcp-card${enabled ? "" : " mcp-card-disabled"}`}>
      <div className="mcp-card-head">
        <div className="mcp-card-title">
          <button
            className={`mcp-toggle${enabled ? " on" : ""}`}
            role="switch"
            aria-checked={enabled}
            onClick={onToggle}
            title={enabled ? "停用此服务器" : "启用此服务器"}
          >
            <span className="mcp-toggle-knob" />
          </button>
          <strong>{server.name}</strong>
          <span className={`mcp-transport-pill mcp-transport-${transport}`}>
            {transportLabel(transport)}
          </span>
          {enabled ? (
            <StatusPill probe={probe} loading={loading} />
          ) : (
            <span className="mcp-status-pill unknown">已停用</span>
          )}
        </div>
        <div className="mcp-card-actions">
          <button
            className="mcp-icon-btn"
            onClick={onTest}
            disabled={loading || !enabled}
            title={enabled ? "测试连接" : "已停用"}
          >
            {loading ? "…" : "测试"}
          </button>
          <button className="mcp-icon-btn" onClick={onEdit} title="编辑">
            编辑
          </button>
          <button className="mcp-icon-btn danger" onClick={onRemove} title="删除">
            删除
          </button>
        </div>
      </div>

      {target && (
        <div className="mcp-card-target" title={target}>
          <code>{target}</code>
        </div>
      )}

      <div className="mcp-card-meta">
        {probe?.status === "ok" && (
          <button className="mcp-tools-link" onClick={onViewTools}>
            {probe.toolCount ?? 0} tools
          </button>
        )}
        {probe?.status === "error" && (
          <div className="mcp-card-error">
            <span className="mcp-card-error-msg">{probe.errorMessage}</span>
            {probe.errorDetail && (
              <button className="mcp-tools-link" onClick={onShowErrorDetail}>
                查看详情
              </button>
            )}
          </div>
        )}
        {probe?.lastProbedAt && (
          <span className="mcp-card-stamp" title={probe.lastProbedAt}>
            上次测试：{formatRelativeTime(probe.lastProbedAt)}
          </span>
        )}
      </div>
    </article>
  );
}

function StatusPill({ probe, loading }: { probe?: McpProbeResult; loading: boolean }) {
  if (loading) return <span className="mcp-status-pill probing">连接中…</span>;
  if (!probe) return <span className="mcp-status-pill unknown">未测试</span>;
  if (probe.status === "ok") return <span className="mcp-status-pill ok">已连接</span>;
  if (probe.status === "error") return <span className="mcp-status-pill err">连接失败</span>;
  return <span className="mcp-status-pill unknown">未知</span>;
}

function transportLabel(t: "stdio" | "streamable-http" | "sse"): string {
  if (t === "stdio") return "stdio";
  if (t === "sse") return "SSE";
  return "HTTP";
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 30_000) return "刚刚";
  if (ms < 60_000) return `${Math.floor(ms / 1000)} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} 小时前`;
  return new Date(iso).toLocaleString();
}

interface EditorProps {
  initial: McpServer | null;
  existingNames: string[];
  onCancel: () => void;
  onSave: (next: McpServer) => void;
}

function McpEditor({ initial, existingNames, onCancel, onSave }: EditorProps) {
  const [transport, setTransport] = useState<"stdio" | "streamable-http" | "sse">(
    initial?.transport ?? (initial?.url ? "streamable-http" : "stdio"),
  );
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join(" "));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [envText, setEnvText] = useState(envOrHeadersToText(initial?.env));
  const [headersText, setHeadersText] = useState(envOrHeadersToText(initial?.headers));
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(initial?.env && Object.keys(initial.env).length) ||
      Boolean(initial?.headers && Object.keys(initial.headers).length),
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  const isStdio = transport === "stdio";
  const otherNames = useMemo(
    () => existingNames.filter((n) => n !== initial?.name),
    [existingNames, initial?.name],
  );

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return setValidationError("name 不能为空");
    if (otherNames.includes(trimmedName))
      return setValidationError("name 与其他服务器重复");
    if (isStdio) {
      if (!command.trim()) return setValidationError("stdio 需要 command");
    } else {
      if (!url.trim()) return setValidationError(`${transport} 需要 url`);
      try {
        new URL(url.trim());
      } catch {
        return setValidationError("url 格式无效");
      }
    }
    let env: Record<string, string> | undefined;
    let headers: Record<string, string> | undefined;
    try {
      env = parseKeyValueLines(envText);
      headers = parseKeyValueLines(headersText);
    } catch (e) {
      return setValidationError(`高级配置解析失败：${(e as Error).message}`);
    }

    const next: McpServer = {
      name: trimmedName,
      transport,
      ...(isStdio
        ? {
            command: command.trim(),
            args: args.trim() ? splitArgs(args.trim()) : undefined,
            env: env && Object.keys(env).length ? env : undefined,
          }
        : {
            url: url.trim(),
            headers: headers && Object.keys(headers).length ? headers : undefined,
          }),
    };
    onSave(next);
  };

  return (
    <div className="mcp-editor">
      <header className="mcp-editor-head">
        <strong>{initial ? `编辑 ${initial.name}` : "添加 MCP 服务器"}</strong>
        <button className="mcp-icon-btn" onClick={onCancel}>关闭</button>
      </header>

      <div className="settings-form-grid">
        <label className="settings-field">
          <span>名称</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
          />
        </label>
        <label className="settings-field">
          <span>Transport</span>
          <Select<"stdio" | "streamable-http" | "sse">
            value={transport}
            onChange={(v) => setTransport(v)}
            options={[
              { value: "stdio", label: "stdio", description: "通过子进程通信（npx / 本地命令）" },
              { value: "streamable-http", label: "HTTP", description: "远程 HTTP 流" },
              { value: "sse", label: "SSE", description: "远程 Server-Sent Events" },
            ]}
          />
        </label>
        {isStdio ? (
          <>
            <label className="settings-field">
              <span>Command</span>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </label>
            <label className="settings-field">
              <span>Args</span>
              <input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="-y @playwright/mcp@latest"
              />
            </label>
          </>
        ) : (
          <label className="settings-field" style={{ gridColumn: "1 / -1" }}>
            <span>URL</span>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
            />
          </label>
        )}
      </div>

      <button
        className="mcp-advanced-toggle"
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? "▾ 高级" : "▸ 高级"}
      </button>

      {showAdvanced && (
        <div className="settings-form-grid mcp-advanced-grid">
          {isStdio && (
            <label className="settings-field">
              <span>环境变量 (KEY=VALUE)</span>
              <textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={"FOO=bar\nBAZ=qux"}
              />
            </label>
          )}
          {!isStdio && (
            <label className="settings-field">
              <span>Headers (Key: Value)</span>
              <textarea
                value={headersText}
                onChange={(e) => setHeadersText(e.target.value)}
                placeholder={"Authorization: Bearer ..."}
              />
            </label>
          )}
        </div>
      )}

      {validationError && <div className="view-error">{validationError}</div>}

      <div className="settings-toolbar">
        <button className="approval-btn deny" onClick={onCancel}>取消</button>
        <button className="approval-btn approve" onClick={submit}>
          {initial ? "保存" : "添加"}
        </button>
      </div>
    </div>
  );
}

interface ToolsViewerProps {
  probe: McpProbeResult;
  onClose: () => void;
}

function ToolsViewer({ probe, onClose }: ToolsViewerProps) {
  return (
    <div className="mcp-modal-backdrop" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <header className="mcp-modal-head">
          <strong>{probe.name} — tools ({probe.tools?.length ?? 0})</strong>
          <button className="mcp-icon-btn" onClick={onClose}>关闭</button>
        </header>
        {probe.tools && probe.tools.length > 0 ? (
          <ul className="mcp-tool-list">
            {probe.tools.map((t) => (
              <li key={t.name} className="mcp-tool-row">
                <code className="mcp-tool-name">{t.name}</code>
                {t.description && (
                  <span className="mcp-tool-desc">{t.description}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="approvals-empty">服务器未返回任何 tool</div>
        )}
      </div>
    </div>
  );
}

function ErrorDetailViewer({ probe, onClose }: { probe: McpProbeResult; onClose: () => void }) {
  return (
    <div className="mcp-modal-backdrop" onClick={onClose}>
      <div className="mcp-modal" onClick={(e) => e.stopPropagation()}>
        <header className="mcp-modal-head">
          <strong>{probe.name} — 错误详情</strong>
          <button className="mcp-icon-btn" onClick={onClose}>关闭</button>
        </header>
        <div className="mcp-error-summary">{probe.errorMessage}</div>
        <pre className="mcp-error-detail">{probe.errorDetail}</pre>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

function mcpServersFromSettings(value: unknown): McpServer[] {
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

function stripNameFromServer(s: McpServer): Omit<McpServer, "name"> {
  const { name: _, ...rest } = s;
  return rest;
}

function envOrHeadersToText(obj: Record<string, string> | undefined): string {
  if (!obj) return "";
  return Object.entries(obj)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    const equals = line.indexOf("=");
    const idx = equals >= 0 && (colon < 0 || equals < colon) ? equals : colon;
    if (idx < 0) throw new Error(`无法解析：${line}`);
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (!k) throw new Error(`空 key：${line}`);
    out[k] = v;
  }
  return out;
}

/** Minimal shell-like splitter — supports quoted segments. */
function splitArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}
