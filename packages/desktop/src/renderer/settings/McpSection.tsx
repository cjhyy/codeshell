import React, { useCallback, useEffect, useMemo, useState } from "react";
import type {
  McpProbeResult,
  McpServerProbeInput,
} from "../../preload/types";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useConfirm, truncateTitle } from "../ui/ConfirmDialog";

interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  transport?: "stdio" | "streamable-http" | "sse";
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** (stdio) NAMES of env vars forwarded from the parent process. */
  envVars?: string[];
  /**
   * (HTTP) NAME of an env var sent as `Authorization: Bearer <value>` —
   * the value is read from the environment at connect time, never stored.
   */
  bearerTokenEnvVar?: string;
  /** (HTTP) header-name → env-var-NAME map, values read at connect time. */
  envHeaders?: Record<string, string>;
  /** Codex-style toggle. Absent/true = on; only false disables. */
  enabled?: boolean;
  source?: "settings" | "plugin";
  editable?: boolean;
  /** Plugin server whose OWNER plugin is disabled — listed but inert
   *  (装了就展示;引擎不会连接它,启用插件才生效). */
  pluginDisabled?: boolean;
}

export function isEditableMcpServer(s: McpServer): boolean {
  return s.editable !== false && s.source !== "plugin";
}

export function persistableMcpServers(servers: McpServer[]): McpServer[] {
  return servers.filter(isEditableMcpServer);
}

/**
 * Owning plugin name for a plugin-sourced server. Plugin MCP servers are keyed
 * `<pluginName>:<serverName>` (core loadPluginMcp), so the owner is the prefix.
 * Returns undefined for user servers or unkeyed names. (TODO 6.2)
 */
export function ownerPluginOf(s: McpServer): string | undefined {
  if (s.source !== "plugin") return undefined;
  const i = s.name.indexOf(":");
  return i > 0 ? s.name.slice(0, i) : undefined;
}

/** A server is on unless explicitly disabled (or its owner plugin is). */
function isEnabled(s: McpServer): boolean {
  return s.enabled !== false && !s.pluginDisabled;
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
      const disabledPlugins = Array.isArray(s.disabledPlugins)
        ? s.disabledPlugins.filter((x): x is string => typeof x === "string")
        : [];
      const merged = await window.codeshell.listMergedMcpServers(
        settingsRecordOf(s.mcpServers),
        disabledPlugins,
        // pluginDisabled is a RUNTIME-effective flag, not "which settings file
        // am I editing" — always fold the ACTIVE repo's capabilityOverrides
        // (能力总览 project on/off), even while viewing the 用户(全局) scope.
        // Otherwise a project-enabled plugin's MCP shows 关闭 in the global
        // view while the session is actually connecting it (user-confusing).
        activeRepoPath ?? undefined,
      );
      const list = mcpServersFromSettings(merged);
      setServers(list);
      void runProbe(list, false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [scope, cwd, activeRepoPath]);

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
      envVars: s.envVars,
      bearerTokenEnvVar: s.bearerTokenEnvVar,
      envHeaders: s.envHeaders,
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
    const record = Object.fromEntries(
      persistableMcpServers(next).map((s) => [s.name, stripNameFromServer(s)]),
    );
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
    if (!isEditableMcpServer(s)) return;
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
            envVars: s.envVars,
            bearerTokenEnvVar: s.bearerTokenEnvVar,
            envHeaders: s.envHeaders,
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
    <section className="mb-6 flex flex-col gap-3">
      <header className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">MCP 服务器</h3>
          {/* 生效时机(feedback): 配置改动即时 reconcile 物理连接,但正在
              进行的对话里模型看到的工具表在下一条消息才刷新。说清楚,免得
              「改了没反应」的错觉。 */}
          <p className="text-xs text-muted-foreground">
            增删 / 启停即时生效;正在进行的对话在你发送下一条消息时看到更新后的工具。
          </p>
        </div>
        <div className="flex items-center gap-2 ">
          <Button
            variant="default"
            onClick={() => void runProbe(servers, true)}
            disabled={servers.length === 0 || loadingProbe.size > 0}
          >
            {loadingProbe.size > 0 ? "测试中…" : "全部测试"}
          </Button>
          <Button
            variant="solid"
            onClick={() => setEdit({ kind: "new" })}
          >
            添加服务器
          </Button>
        </div>
      </header>

      {error && <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">{error}</div>}

      {servers.length === 0 && edit.kind === "closed" && (
        <div className="rounded-md border border-dashed p-4 text-sm">
          <div className="font-medium text-foreground">还没有 MCP 服务器</div>
          <div className="mt-1 text-sm text-muted-foreground">
            MCP 服务器为代理提供额外工具。点击「添加服务器」开始配置。
          </div>
        </div>
      )}

      {/* 归组(feedback#14):用户自己配的在前;插件捆绑的按插件分组,
          与独立 MCP 视觉区分 — 且无论插件是否启用都列出(装了就展示)。 */}
      {(() => {
        const userServers = servers.filter((s) => s.source !== "plugin");
        const pluginServers = servers.filter((s) => s.source === "plugin");
        const byPlugin = new Map<string, McpServer[]>();
        for (const s of pluginServers) {
          const owner = ownerPluginOf(s) ?? "插件";
          byPlugin.set(owner, [...(byPlugin.get(owner) ?? []), s]);
        }
        const renderCard = (s: McpServer, groupedByPlugin = false) => {
          const probe = probes[s.name];
          const loading = loadingProbe.has(s.name);
          return (
            <McpCard
              key={s.name}
              server={s}
              probe={probe}
              loading={loading}
              groupedByPlugin={groupedByPlugin}
              onToggle={() => void toggleServer(s)}
              onTest={() => void testOne(s)}
              onEdit={() => setEdit({ kind: "edit", original: s.name })}
              onRemove={() => void removeServer(s.name)}
              onViewTools={() => setToolsViewer(probe ?? null)}
              onShowErrorDetail={() => setErrorDetailFor(probe ?? null)}
            />
          );
        };
        return (
          <>
            <div className="grid gap-2">{userServers.map((s) => renderCard(s))}</div>
            {Array.from(byPlugin.entries()).map(([owner, list]) => (
              <div key={owner} className="mt-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <span>🧩 {owner} 插件提供</span>
                  {list.every((s) => s.pluginDisabled) && (
                    <span className="rounded bg-muted px-1 text-[10px]">插件已禁用 — 启用后生效</span>
                  )}
                </div>
                <div className="grid gap-2">{list.map((s) => renderCard(s, true))}</div>
              </div>
            ))}
          </>
        );
      })()}

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
  /** Rendered inside a 「🧩 xxx 插件提供」 group — the group header already
   *  names the plugin and its disabled state, so the card drops the
   *  redundant 插件/已停用 pills and shows the BARE server name. */
  groupedByPlugin?: boolean;
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
  groupedByPlugin = false,
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
  const editable = isEditableMcpServer(server);
  // Owning plugin name (TODO 6.2) — see ownerPluginOf.
  const ownerPlugin = ownerPluginOf(server);
  // Inside a plugin group the `plugin:` prefix is noise — show the bare name.
  const displayName =
    groupedByPlugin && ownerPlugin && server.name.startsWith(`${ownerPlugin}:`)
      ? server.name.slice(ownerPlugin.length + 1)
      : server.name;

  return (
    <article className={cn("rounded-md border bg-card p-3", !enabled && "opacity-60")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Switch
            checked={enabled}
            onCheckedChange={editable ? onToggle : undefined}
            disabled={!editable}
            title={editable ? (enabled ? "停用此服务器" : "启用此服务器") : "由插件管理，不能在这里启停"}
          />
          <strong title={server.name}>{displayName}</strong>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {transportLabel(transport)}
          </span>
          {server.source === "plugin" && !groupedByPlugin && (
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              title={ownerPlugin ? `由「${ownerPlugin}」插件提供，只读展示` : "由插件安装提供，只读展示"}
            >
              {ownerPlugin ? `插件: ${ownerPlugin}` : "plugin"}
            </span>
          )}
          {enabled ? (
            <StatusPill probe={probe} loading={loading} />
          ) : (
            // 随插件禁用时组头已有「插件已禁用」徽标 — 卡片不再重复。
            !server.pluginDisabled && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">已停用</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!server.pluginDisabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onTest}
              disabled={loading || !enabled}
              title={enabled ? "测试连接" : "已停用"}
            >
              {loading ? "…" : "测试"}
            </Button>
          )}
          {editable ? (
            <>
              <Button type="button" variant="ghost" size="sm" onClick={onEdit} title="编辑">
                编辑
              </Button>
              <Button type="button" variant="ghost" size="sm" className="text-status-err hover:text-status-err" onClick={onRemove} title="删除">
                删除
              </Button>
            </>
          ) : (
            <span
              className="text-xs text-muted-foreground"
              title={ownerPlugin ? `由「${ownerPlugin}」插件提供;在插件页启停整个插件` : "由插件提供"}
            >
              {groupedByPlugin ? "只读" : ownerPlugin ? `只读：由「${ownerPlugin}」插件管理` : "只读：由插件管理"}
            </span>
          )}
        </div>
      </div>

      {target && (
        <div className="mt-2 truncate rounded bg-muted/40 p-2 font-mono text-xs text-muted-foreground" title={target}>
          <code>{target}</code>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {probe?.status === "ok" && (
          <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onViewTools}>
            {probe.toolCount ?? 0} tools
          </Button>
        )}
        {probe?.status === "error" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-status-err">{probe.errorMessage}</span>
            {probe.errorDetail && (
              <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onShowErrorDetail}>
                查看详情
              </Button>
            )}
          </div>
        )}
        {probe?.lastProbedAt && (
          <span className="text-xs text-muted-foreground" title={probe.lastProbedAt}>
            上次测试：{formatRelativeTime(probe.lastProbedAt)}
          </span>
        )}
      </div>
    </article>
  );
}

function StatusPill({ probe, loading }: { probe?: McpProbeResult; loading: boolean }) {
  if (loading) return <span className="rounded bg-status-running/10 px-1.5 py-0.5 text-[10px] font-medium text-status-running">连接中…</span>;
  if (!probe) return <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">未测试</span>;
  if (probe.status === "ok") return <span className="rounded bg-status-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-status-ok">已连接</span>;
  if (probe.status === "error") return <span className="rounded bg-status-err/10 px-1.5 py-0.5 text-[10px] font-medium text-status-err">连接失败</span>;
  return <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">未知</span>;
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
  const [headersText, setHeadersText] = useState(envOrHeadersToText(initial?.headers, ": "));
  const [bearerEnvVar, setBearerEnvVar] = useState(initial?.bearerTokenEnvVar ?? "");
  const [envHeadersText, setEnvHeadersText] = useState(envOrHeadersToText(initial?.envHeaders, ": "));
  const [showAdvanced, setShowAdvanced] = useState(
    Boolean(initial?.env && Object.keys(initial.env).length) ||
      Boolean(initial?.headers && Object.keys(initial.headers).length) ||
      Boolean(initial?.bearerTokenEnvVar) ||
      Boolean(initial?.envHeaders && Object.keys(initial.envHeaders).length),
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
    let envHeaders: Record<string, string> | undefined;
    try {
      env = parseKeyValueLines(envText);
      headers = parseKeyValueLines(headersText);
      envHeaders = parseKeyValueLines(envHeadersText);
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
            bearerTokenEnvVar: bearerEnvVar.trim() || undefined,
            envHeaders: envHeaders && Object.keys(envHeaders).length ? envHeaders : undefined,
          }),
    };
    onSave(next);
  };

  return (
    <div className="rounded-md border bg-card p-4">
      <header className="mb-4 flex items-center justify-between gap-3">
        <strong>{initial ? `编辑 ${initial.name}` : "添加 MCP 服务器"}</strong>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>关闭</Button>
      </header>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
          <span>名称</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
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
            <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
              <span>Command</span>
              <Input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
              <span>Args</span>
              <Input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder="-y @playwright/mcp@latest"
              />
            </label>
          </>
        ) : (
          <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5" style={{ gridColumn: "1 / -1" }}>
            <span>URL</span>
            <Input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/mcp"
            />
          </label>
        )}
      </div>

      <Button
        variant="ghost"
        size="sm"
        className="my-3 justify-start px-2 text-xs text-muted-foreground"
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
      >
        {showAdvanced ? "▾ 高级" : "▸ 高级"}
      </Button>

      {showAdvanced && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 ">
          {isStdio && (
            <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
              <span>环境变量 (KEY=VALUE)</span>
              <Textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={"FOO=bar\nBAZ=qux"}
              />
            </label>
          )}
          {!isStdio && (
            <>
              <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                <span>Headers (Key: Value)</span>
                <Textarea
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder={"Authorization: Bearer ...\nX-N8N-API-KEY: ..."}
                />
                <span className="text-xs text-muted-foreground">
                  明文 header，会存进配置文件 — 敏感 key 建议改用下面的环境变量方式。
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                <span>Bearer Token 环境变量</span>
                <Input
                  value={bearerEnvVar}
                  onChange={(e) => setBearerEnvVar(e.target.value)}
                  placeholder="MY_MCP_TOKEN"
                />
                <span className="text-xs text-muted-foreground">
                  填环境变量「名」（不是值）。连接时从系统环境读取，作为
                  Authorization: Bearer 发送，token 不会存进配置。
                </span>
              </label>
              <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                <span>环境变量 Headers (Header: 环境变量名)</span>
                <Textarea
                  value={envHeadersText}
                  onChange={(e) => setEnvHeadersText(e.target.value)}
                  placeholder={"X-N8N-API-KEY: N8N_API_KEY"}
                />
                <span className="text-xs text-muted-foreground">
                  左边是 header 名，右边是环境变量「名」；适合 server 要求自定义
                  鉴权 header（非 Bearer）的场景，值同样连接时才读取。
                </span>
              </label>
            </>
          )}
        </div>
      )}

      {validationError && <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">{validationError}</div>}

      <div className="flex items-center gap-2">
        <Button variant="default" onClick={onCancel}>取消</Button>
        <Button variant="solid" onClick={submit}>
          {initial ? "保存" : "添加"}
        </Button>
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="mb-3 flex items-center justify-between gap-3">
          <strong>{probe.name} — tools ({probe.tools?.length ?? 0})</strong>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </header>
        {probe.tools && probe.tools.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {probe.tools.map((t) => (
              <li key={t.name} className="rounded-md border p-2">
                <code className="font-mono text-xs text-foreground">{t.name}</code>
                {t.description && (
                  <span className="mt-1 block text-xs text-muted-foreground">{t.description}</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-4 text-center text-sm text-muted-foreground">服务器未返回任何 tool</div>
        )}
      </div>
    </div>
  );
}

function ErrorDetailViewer({ probe, onClose }: { probe: McpProbeResult; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4" onClick={onClose}>
      <div className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="mb-3 flex items-center justify-between gap-3">
          <strong>{probe.name} — 错误详情</strong>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>关闭</Button>
        </header>
        <div className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">{probe.errorMessage}</div>
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">{probe.errorDetail}</pre>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

export function mcpServersFromSettings(value: unknown): McpServer[] {
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

function settingsRecordOf(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value
        .filter((x): x is McpServer => !!x && typeof x === "object" && typeof (x as McpServer).name === "string")
        .map((s) => [s.name, stripNameFromServer(s)]),
    );
  }
  return {};
}

function stripNameFromServer(s: McpServer): Omit<McpServer, "name"> {
  const { name: _, ...rest } = s;
  return rest;
}

function envOrHeadersToText(
  obj: Record<string, string> | undefined,
  sep: "=" | ": " = "=",
): string {
  if (!obj) return "";
  return Object.entries(obj)
    .map(([k, v]) => `${k}${sep}${v}`)
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
