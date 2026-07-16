import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useRefreshOnSettingsChange } from "./useSettingsResource";
import type { McpProbeResult, McpServerProbeInput } from "../../preload/types";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { useConfirm, truncateTitle } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import { useT } from "../i18n/I18nProvider";
import { translate } from "../i18n/translate";
import { loadUILanguage } from "../uiLanguage";
import type { MaskedCredentialView } from "../credentials/types";

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
  /** (HTTP) id of a stored token/link/oauth credential used as Bearer auth. */
  credentialRef?: string;
  /** Codex-style toggle. Absent/true = on; only false disables. */
  enabled?: boolean;
  source?: "settings" | "plugin";
  editable?: boolean;
  /** Plugin server whose OWNER plugin is disabled — listed but inert
   *  (装了就展示;引擎不会连接它,启用插件才生效). */
  pluginDisabled?: boolean;
  /** Plugin server that currently carries a user env/credential override
   *  (settings.mcpServerOverrides). UI-only flag from mcp:listMerged. */
  hasOverride?: boolean;
}

/** Fields a user may supplement onto a plugin MCP server (mirror of core
 *  MCPServerOverride). command/args/url/transport are intentionally absent. */
const MCP_OVERRIDE_FIELDS = [
  "env",
  "envVars",
  "credentialRef",
  "bearerTokenEnvVar",
  "envHeaders",
] as const;

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

function hasEntries(obj: Record<string, string> | undefined): boolean {
  return Boolean(obj && Object.keys(obj).length > 0);
}

export function isHttpMcpAuthConfigured(s: {
  headers?: Record<string, string>;
  credentialRef?: string;
  bearerTokenEnvVar?: string;
  envHeaders?: Record<string, string>;
}): boolean {
  return Boolean(
    hasEntries(s.headers) || s.credentialRef || s.bearerTokenEnvVar || hasEntries(s.envHeaders),
  );
}

type HttpAuthMode = "none" | "bearer" | "headers" | "oauth";

function isOAuthCredential(c: Pick<MaskedCredentialView, "type">): boolean {
  return c.type === "oauth";
}

export function inferHttpAuthMode(
  s: {
    headers?: Record<string, string>;
    credentialRef?: string;
    bearerTokenEnvVar?: string;
    envHeaders?: Record<string, string>;
  },
  credentials: Array<Pick<MaskedCredentialView, "id" | "type">> = [],
): HttpAuthMode {
  if (!isHttpMcpAuthConfigured(s)) return "none";
  const ref = s.credentialRef;
  if (ref && credentials.some((c) => c.id === ref && isOAuthCredential(c))) return "oauth";
  if (hasEntries(s.envHeaders) || hasEntries(s.headers)) return "headers";
  if (ref || s.bearerTokenEnvVar) return "bearer";
  return "none";
}

function isRemoteMcpTransport(s: McpServer): boolean {
  const transport = s.transport ?? (s.url ? "streamable-http" : "stdio");
  return transport !== "stdio";
}

function isAuthErrorText(text: string | undefined): boolean {
  if (!text) return false;
  return /unauthorized|\b401\b|-32001|invalid token|no auth provider|鉴权/i.test(text);
}

function isHttpAuthProbeError(s: McpServer, probe: McpProbeResult | undefined): boolean {
  if (!probe || probe.status !== "error" || !isRemoteMcpTransport(s)) return false;
  return isAuthErrorText(probe.errorMessage) || isAuthErrorText(probe.errorDetail);
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
  activeProjectPath: string | null;
}

type EditState =
  | { kind: "closed" }
  | { kind: "new" }
  | { kind: "edit"; original: string }
  // Supplement a PLUGIN server's env/credential — identity fields locked,
  // saved to the global mcpServerOverrides layer (not mcpServers).
  | { kind: "override"; original: string };

export function McpSection({ scope, activeProjectPath }: Props) {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [probes, setProbes] = useState<Record<string, McpProbeResult>>({});
  const [loadingProbe, setLoadingProbe] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState>({ kind: "closed" });
  const [toolsViewer, setToolsViewer] = useState<McpProbeResult | null>(null);
  const [errorDetailFor, setErrorDetailFor] = useState<McpProbeResult | null>(null);
  const confirm = useConfirm();
  const { t } = useT();

  const projectPath = scope === "project" ? (activeProjectPath ?? undefined) : undefined;

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = (await window.codeshell.getSettings(scope, projectPath)) ?? {};
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
        activeProjectPath ?? undefined,
      );
      const list = mcpServersFromSettings(merged);
      setServers(list);
      void runProbe(list, false);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [scope, projectPath, activeProjectPath]);

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
      credentialRef: s.credentialRef,
    }));
    const probingNames = probeable.map((x) => x.name);
    setLoadingProbe((prev) => {
      const next = new Set(prev);
      for (const n of probingNames) next.add(n);
      return next;
    });
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
      // Only clear the names this run set — a concurrent testOne() owns its
      // own entry and must not be wiped here.
      setLoadingProbe((prev) => {
        const next = new Set(prev);
        for (const n of probingNames) next.delete(n);
        return next;
      });
    }
  }, []);

  // Load on mount + auto-refresh on config change anywhere.
  useRefreshOnSettingsChange(() => void load(), [load]);

  const removeServer = async (name: string) => {
    const ok = await confirm({
      title: t("settingsX.mcp.confirmRemoveTitle"),
      message: t("settingsX.mcp.confirmRemoveMsg", { name: truncateTitle(name) }),
      confirmLabel: t("settingsX.mcp.remove"),
      destructive: true,
    });
    if (!ok) return;
    await window.codeshell.updateSettings(scope, { mcpServers: { [name]: null } }, projectPath);
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
    const updated = servers.map((x) => (x.name === s.name ? { ...x, enabled: nextEnabled } : x));
    await window.codeshell.updateSettings(
      scope,
      { mcpServers: { [s.name]: stripNameFromServer({ ...s, enabled: nextEnabled }) } },
      projectPath,
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
      void runProbe(
        updated.filter((x) => x.name === s.name),
        true,
      );
    }
  };

  const saveEdit = async (next: McpServer, originalName?: string) => {
    const others = servers.filter((s) => s.name !== originalName && s.name !== next.name);
    const updated = [...others, next];
    // Rename must be ATOMIC: write the new server AND delete the old key in ONE
    // updateSettings patch. The old two-step (persist new, then a separate patch
    // to null the old key) could persist BOTH old+new if the second write
    // failed/crashed. deepMerge in settings-service honors nested `null` to
    // delete a key, so { mcpServers: { new: {...}, old: null } } does both.
    const record: Record<string, unknown> = Object.fromEntries(
      persistableMcpServers(updated).map((s) => [s.name, stripNameFromServer(s)]),
    );
    if (originalName && originalName !== next.name) {
      record[originalName] = null;
    }
    await window.codeshell.updateSettings(scope, { mcpServers: record }, projectPath);
    setServers(updated);
    if (originalName && originalName !== next.name) {
      await window.codeshell.invalidateMcpProbeCache(originalName);
    }
    await window.codeshell.invalidateMcpProbeCache(next.name);
    setEdit({ kind: "closed" });
    broadcastSettingsChanged();
    void runProbe(updated, true);
  };

  // Save (or clear) the env/credential supplement for a PLUGIN server. Always
  // writes the GLOBAL mcpServerOverrides layer — never mcpServers — so the
  // plugin's command/url stay owned by the manifest and survive updates.
  const saveOverride = async (name: string, next: McpServer) => {
    const supplement: Record<string, unknown> = {};
    let any = false;
    for (const f of MCP_OVERRIDE_FIELDS) {
      const v = next[f];
      const present = v !== undefined && !(Array.isArray(v) && v.length === 0);
      // settings deepMerge: a present field overwrites, a `null` deletes the
      // stale one. Send every field so a CLEARED field is actually removed
      // (a plain absent key would leave the old value behind).
      supplement[f] = present ? v : null;
      if (present) any = true;
    }
    // No fields left → drop the whole override entry (null deletes the key).
    const value = any ? supplement : null;
    await window.codeshell.updateSettings(
      "user",
      { mcpServerOverrides: { [name]: value } },
      undefined,
    );
    await window.codeshell.invalidateMcpProbeCache(name);
    setEdit({ kind: "closed" });
    broadcastSettingsChanged();
    await load();
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
            credentialRef: s.credentialRef,
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
          <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">
            {t("settingsX.mcp.title")}
          </h3>
          {/* 生效时机(feedback): 配置改动即时 reconcile 物理连接,但正在
              进行的对话里模型看到的工具表在下一条消息才刷新。说清楚,免得
              「改了没反应」的错觉。 */}
          <p className="text-xs text-muted-foreground">{t("settingsX.mcp.desc")}</p>
        </div>
        <div className="flex items-center gap-2 ">
          <Button
            variant="default"
            onClick={() => void runProbe(servers, true)}
            disabled={servers.length === 0 || loadingProbe.size > 0}
          >
            {loadingProbe.size > 0 ? t("settingsX.mcp.testing") : t("settingsX.mcp.testAll")}
          </Button>
          <Button variant="solid" onClick={() => setEdit({ kind: "new" })}>
            {t("settingsX.mcp.addServer")}
          </Button>
        </div>
      </header>

      {error && (
        <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">{error}</div>
      )}

      {servers.length === 0 && edit.kind === "closed" && (
        <div className="rounded-md border border-dashed p-4 text-sm">
          <div className="font-medium text-foreground">{t("settingsX.mcp.emptyTitle")}</div>
          <div className="mt-1 text-sm text-muted-foreground">{t("settingsX.mcp.emptyDesc")}</div>
        </div>
      )}

      {/* 归组(feedback#14):用户自己配的在前;插件捆绑的按插件分组,
          与独立 MCP 视觉区分 — 且无论插件是否启用都列出(装了就展示)。 */}
      {(() => {
        const userServers = servers.filter((s) => s.source !== "plugin");
        const pluginServers = servers.filter((s) => s.source === "plugin");
        const byPlugin = new Map<string, McpServer[]>();
        for (const s of pluginServers) {
          const owner = ownerPluginOf(s) ?? t("settingsX.mcp.defaultPluginName");
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
              onOverride={() => setEdit({ kind: "override", original: s.name })}
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
                  <span>{t("settingsX.mcp.providedByPlugin", { owner })}</span>
                  {list.every((s) => s.pluginDisabled) && (
                    <span className="rounded bg-muted px-1 text-[10px]">
                      {t("settingsX.mcp.pluginDisabledBadge")}
                    </span>
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
          initial={
            edit.kind === "edit" || edit.kind === "override"
              ? (servers.find((s) => s.name === edit.original) ?? null)
              : null
          }
          mode={edit.kind === "override" ? "override" : "full"}
          onCancel={() => setEdit({ kind: "closed" })}
          onSave={(next) =>
            edit.kind === "override"
              ? void saveOverride(edit.original, next)
              : void saveEdit(next, edit.kind === "edit" ? edit.original : undefined)
          }
        />
      )}

      {toolsViewer && <ToolsViewer probe={toolsViewer} onClose={() => setToolsViewer(null)} />}
      {errorDetailFor && (
        <ErrorDetailViewer probe={errorDetailFor} onClose={() => setErrorDetailFor(null)} />
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
  /** Open the env/credential supplement editor (plugin servers only). */
  onOverride: () => void;
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
  onOverride,
  onRemove,
  onViewTools,
  onShowErrorDetail,
}: McpCardProps) {
  const { t } = useT();
  const transport = server.transport ?? (server.url ? "streamable-http" : "stdio");
  const target = server.command
    ? [server.command, ...(server.args ?? [])].join(" ")
    : (server.url ?? "");
  const enabled = isEnabled(server);
  const editable = isEditableMcpServer(server);
  const authIssue = isHttpAuthProbeError(server, probe);
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
            title={
              editable
                ? enabled
                  ? t("settingsX.mcp.disableThis")
                  : t("settingsX.mcp.enableThis")
                : t("settingsX.mcp.pluginManagedNoToggle")
            }
          />
          <strong title={server.name}>{displayName}</strong>
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {transportLabel(transport)}
          </span>
          {server.source === "plugin" && !groupedByPlugin && (
            <span
              className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              title={
                ownerPlugin
                  ? t("settingsX.mcp.pluginProvidedReadonly", { owner: ownerPlugin })
                  : t("settingsX.mcp.pluginInstalledReadonly")
              }
            >
              {ownerPlugin ? t("settingsX.mcp.pluginPrefix", { owner: ownerPlugin }) : "plugin"}
            </span>
          )}
          {server.hasOverride && (
            <span
              className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              title={t("settingsX.mcp.overrideBadgeTitle")}
            >
              {t("settingsX.mcp.overrideBadge")}
            </span>
          )}
          {transport !== "stdio" && (
            <span
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px] font-medium",
                authIssue
                  ? "bg-status-err/10 text-status-err"
                  : isHttpMcpAuthConfigured(server)
                    ? "bg-primary/10 text-primary"
                    : "bg-muted text-muted-foreground",
              )}
              title={
                authIssue
                  ? t("settingsX.mcp.authRequiredTitle")
                  : isHttpMcpAuthConfigured(server)
                    ? t("settingsX.mcp.authConfiguredTitle")
                    : t("settingsX.mcp.authNoneTitle")
              }
            >
              {authIssue
                ? t("settingsX.mcp.authRequired")
                : isHttpMcpAuthConfigured(server)
                  ? t("settingsX.mcp.authConfigured")
                  : t("settingsX.mcp.authNone")}
            </span>
          )}
          {enabled ? (
            <StatusPill probe={probe} loading={loading} authIssue={authIssue} />
          ) : (
            // 随插件禁用时组头已有「插件已禁用」徽标 — 卡片不再重复。
            !server.pluginDisabled && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {t("settingsX.mcp.disabled")}
              </span>
            )
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
              title={enabled ? t("settingsX.mcp.testConn") : t("settingsX.mcp.disabled")}
            >
              {loading ? "…" : t("settingsX.mcp.test")}
            </Button>
          )}
          {editable ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onEdit}
                title={t("settingsX.mcp.edit")}
              >
                {t("settingsX.mcp.edit")}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-status-err hover:text-status-err"
                onClick={onRemove}
                title={t("settingsX.mcp.delete")}
              >
                {t("settingsX.mcp.delete")}
              </Button>
            </>
          ) : (
            <>
              {/* Plugin servers stay read-only for command/url, but the user may
                  supplement env/credential — those save to the global override
                  layer and survive plugin updates. Hidden while the owner
                  plugin is disabled (the server is inert anyway). */}
              {!server.pluginDisabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={onOverride}
                  title={t("settingsX.mcp.supplementCredTitle")}
                >
                  {t("settingsX.mcp.supplementCred")}
                </Button>
              )}
              <span
                className="text-xs text-muted-foreground"
                title={
                  ownerPlugin
                    ? t("settingsX.mcp.pluginManagedHint", { owner: ownerPlugin })
                    : t("settingsX.mcp.pluginProvidedHint")
                }
              >
                {groupedByPlugin
                  ? t("settingsX.mcp.readOnly")
                  : ownerPlugin
                    ? t("settingsX.mcp.readOnlyPluginManaged", { owner: ownerPlugin })
                    : t("settingsX.mcp.readOnlyPlugin")}
              </span>
            </>
          )}
        </div>
      </div>

      {target && (
        <div
          className="mt-2 truncate rounded bg-muted/40 p-2 font-mono text-xs text-muted-foreground"
          title={target}
        >
          <code>{target}</code>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {probe?.status === "ok" && (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto p-0 text-xs"
            onClick={onViewTools}
          >
            {probe.toolCount ?? 0} tools
          </Button>
        )}
        {probe?.status === "error" && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-status-err">
              {authIssue ? t("settingsX.mcp.authRequiredError") : probe.errorMessage}
            </span>
            {probe.errorDetail && (
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-xs"
                onClick={onShowErrorDetail}
              >
                {t("settingsX.mcp.viewDetail")}
              </Button>
            )}
          </div>
        )}
        {probe?.lastProbedAt && (
          <span className="text-xs text-muted-foreground" title={probe.lastProbedAt}>
            {t("settingsX.mcp.lastTested", { time: formatRelativeTime(probe.lastProbedAt) })}
          </span>
        )}
      </div>
    </article>
  );
}

function StatusPill({
  probe,
  loading,
  authIssue = false,
}: {
  probe?: McpProbeResult;
  loading: boolean;
  authIssue?: boolean;
}) {
  const { t } = useT();
  if (loading)
    return (
      <span className="rounded bg-status-running/10 px-1.5 py-0.5 text-[10px] font-medium text-status-running">
        {t("settingsX.mcp.connecting")}
      </span>
    );
  if (!probe)
    return (
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
        {t("settingsX.mcp.untested")}
      </span>
    );
  if (probe.status === "ok")
    return (
      <span className="rounded bg-status-ok/10 px-1.5 py-0.5 text-[10px] font-medium text-status-ok">
        {t("settingsX.mcp.connected")}
      </span>
    );
  if (probe.status === "error")
    return (
      <span className="rounded bg-status-err/10 px-1.5 py-0.5 text-[10px] font-medium text-status-err">
        {authIssue ? t("settingsX.mcp.authRequired") : t("settingsX.mcp.connFailed")}
      </span>
    );
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {t("settingsX.mcp.unknown")}
    </span>
  );
}

function OAuthCredentialStatus({ credential }: { credential?: MaskedCredentialView }) {
  const { t } = useT();
  if (!credential) {
    return (
      <div className="mt-3 text-xs text-muted-foreground">
        {t("settingsX.mcp.oauthNoCredential")}
      </div>
    );
  }

  const state = credential.oauthStatus?.state ?? (credential.hasSecret ? "valid" : "missing");
  const label =
    state === "valid"
      ? t("settingsX.mcp.oauthStatusValid")
      : state === "expired"
        ? t("settingsX.mcp.oauthStatusExpired")
        : state === "invalid"
          ? t("settingsX.mcp.oauthStatusInvalid")
          : t("settingsX.mcp.oauthStatusMissing");
  const expiresAt = credential.oauthStatus?.expiresAt;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span
        className={cn(
          "rounded px-1.5 py-0.5 text-[10px] font-medium",
          state === "valid" ? "bg-status-ok/10 text-status-ok" : "bg-status-err/10 text-status-err",
        )}
      >
        {label}
      </span>
      <span className="truncate">
        {credential.label} ({credential.id})
      </span>
      {expiresAt && (
        <span>
          {t("settingsX.mcp.oauthExpiresAt", {
            time: new Date(expiresAt).toLocaleString(),
          })}
        </span>
      )}
      {credential.oauthStatus?.hasRefreshToken && (
        <span>{t("settingsX.mcp.oauthRefreshAvailable")}</span>
      )}
    </div>
  );
}

function transportLabel(t: "stdio" | "streamable-http" | "sse"): string {
  if (t === "stdio") return "stdio";
  if (t === "sse") return "SSE";
  return "HTTP";
}

function formatRelativeTime(iso: string): string {
  const lang = loadUILanguage();
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 30_000) return translate(lang, "settingsX.mcp.justNow");
  if (ms < 60_000) return translate(lang, "settingsX.mcp.secondsAgo", { n: Math.floor(ms / 1000) });
  if (ms < 3_600_000)
    return translate(lang, "settingsX.mcp.minutesAgo", { n: Math.floor(ms / 60_000) });
  if (ms < 86_400_000)
    return translate(lang, "settingsX.mcp.hoursAgo", { n: Math.floor(ms / 3_600_000) });
  return new Date(iso).toLocaleString();
}

interface EditorProps {
  initial: McpServer | null;
  existingNames: string[];
  /** "override" locks identity fields (name/transport/command/args/url) and
   *  only lets the user supplement env/credential for a plugin server. */
  mode?: "full" | "override";
  onCancel: () => void;
  onSave: (next: McpServer) => void;
}

function McpEditor({ initial, existingNames, mode = "full", onCancel, onSave }: EditorProps) {
  const isOverride = mode === "override";
  const toast = useToast();
  const [transport, setTransport] = useState<"stdio" | "streamable-http" | "sse">(
    initial?.transport ?? (initial?.url ? "streamable-http" : "stdio"),
  );
  const [name, setName] = useState(initial?.name ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");
  const [args, setArgs] = useState((initial?.args ?? []).join(" "));
  const [url, setUrl] = useState(initial?.url ?? "");
  const [envText, setEnvText] = useState(envOrHeadersToText(initial?.env));
  const [forwardEnvVarsText, setForwardEnvVarsText] = useState(envNamesToText(initial?.envVars));
  const [headersText, setHeadersText] = useState(envOrHeadersToText(initial?.headers, ": "));
  const [bearerEnvVar, setBearerEnvVar] = useState(initial?.bearerTokenEnvVar ?? "");
  const [credentialRef, setCredentialRef] = useState(initial?.credentialRef ?? "");
  const [credentials, setCredentials] = useState<MaskedCredentialView[]>([]);
  const [envHeadersText, setEnvHeadersText] = useState(
    envOrHeadersToText(initial?.envHeaders, ": "),
  );
  const [authMode, setAuthMode] = useState<HttpAuthMode>(() => inferHttpAuthMode(initial ?? {}));
  const [authModeTouched, setAuthModeTouched] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(
    // Override mode IS the env/credential editor — always start expanded.
    isOverride ||
      Boolean(initial?.env && Object.keys(initial.env).length) ||
      Boolean(initial?.envVars && initial.envVars.length) ||
      Boolean(initial?.headers && Object.keys(initial.headers).length) ||
      Boolean(initial?.bearerTokenEnvVar) ||
      Boolean(initial?.credentialRef) ||
      Boolean(initial?.envHeaders && Object.keys(initial.envHeaders).length),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [oauthBusy, setOAuthBusy] = useState(false);
  const [oauthError, setOAuthError] = useState<string | null>(null);
  const [oauthClientId, setOAuthClientId] = useState("");
  const [oauthAuthorizationEndpoint, setOAuthAuthorizationEndpoint] = useState("");
  const [oauthTokenEndpoint, setOAuthTokenEndpoint] = useState("");
  const [oauthScopes, setOAuthScopes] = useState("");
  const { t } = useT();

  // Load credentials (user scope) to offer token/link Bearer and OAuth sources.
  useEffect(() => {
    void window.codeshell.credentials.list("").then((all) => setCredentials(all));
  }, []);

  const isStdio = transport === "stdio";
  const bearerCredOptions = useMemo(
    () =>
      credentials
        .filter((c) => c.type === "token" || c.type === "link")
        .map((c) => ({ value: c.id, label: `${c.label} (${c.id})` })),
    [credentials],
  );
  const oauthCredentials = useMemo(
    () => credentials.filter((c) => c.type === "oauth"),
    [credentials],
  );
  const oauthCredOptions = useMemo(
    () => oauthCredentials.map((c) => ({ value: c.id, label: `${c.label} (${c.id})` })),
    [oauthCredentials],
  );
  const selectedOAuthCredential = useMemo(
    () => oauthCredentials.find((c) => c.id === credentialRef),
    [credentialRef, oauthCredentials],
  );
  useEffect(() => {
    if (authModeTouched) return;
    setAuthMode(inferHttpAuthMode(initial ?? {}, credentials));
  }, [authModeTouched, credentials, initial]);

  const otherNames = useMemo(
    () => existingNames.filter((n) => n !== initial?.name),
    [existingNames, initial?.name],
  );

  const setAuthModeFromUi = (next: HttpAuthMode) => {
    setAuthModeTouched(true);
    setAuthMode(next);
    if (next === "none") {
      setCredentialRef("");
      setBearerEnvVar("");
      setEnvHeadersText("");
      setHeadersText("");
      return;
    }
    if (next === "oauth") {
      if (!selectedOAuthCredential) setCredentialRef(oauthCredentials[0]?.id ?? "");
      setBearerEnvVar("");
      return;
    }
    if (next === "bearer" && selectedOAuthCredential) {
      setCredentialRef("");
    }
  };

  const reloadCredentials = async () => {
    setCredentials(await window.codeshell.credentials.list(""));
  };

  const runOAuthAction = async (action: () => Promise<void>) => {
    if (oauthBusy) return;
    setOAuthBusy(true);
    setOAuthError(null);
    try {
      await action();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setOAuthError(message);
      toast({ message });
    } finally {
      setOAuthBusy(false);
    }
  };

  const onOAuthLogin = () => {
    void runOAuthAction(async () => {
      const serverName = name.trim();
      const serverUrl = url.trim();
      if (!serverName) throw new Error(t("settingsX.mcp.nameEmpty"));
      if (isStdio || !serverUrl) throw new Error(t("settingsX.mcp.oauthNeedsHttpUrl"));
      try {
        new URL(serverUrl);
      } catch {
        throw new Error(t("settingsX.mcp.urlInvalid"));
      }
      const result = await window.codeshell.mcpOAuth.login({
        source: "mcp",
        serverName,
        serverUrl,
        credentialId: selectedOAuthCredential?.id,
        clientId: oauthClientId.trim() || undefined,
        authorizationEndpoint: oauthAuthorizationEndpoint.trim() || undefined,
        tokenEndpoint: oauthTokenEndpoint.trim() || undefined,
        scopes: oauthScopes.split(/[\s,]+/).filter(Boolean),
      });
      await reloadCredentials();
      setCredentialRef(result.credential.id);
      setAuthMode("oauth");
      setAuthModeTouched(true);
    });
  };

  const onOAuthRefresh = () => {
    if (!selectedOAuthCredential) return;
    void runOAuthAction(async () => {
      await window.codeshell.mcpOAuth.refresh(selectedOAuthCredential.id);
      await reloadCredentials();
    });
  };

  const onOAuthLogout = () => {
    if (!selectedOAuthCredential) return;
    void runOAuthAction(async () => {
      const result = await window.codeshell.mcpOAuth.logout(selectedOAuthCredential.id);
      setCredentialRef("");
      await reloadCredentials();
      toast({
        message: result.remoteRevoked
          ? t("settingsX.mcp.oauthLogoutDone")
          : t("settingsX.mcp.oauthLogoutWarning"),
      });
    });
  };

  const submit = () => {
    const trimmedName = name.trim();
    // Override mode locks identity fields, so skip their validation — the user
    // only supplies env/credential supplements for an existing plugin server.
    if (!isOverride) {
      if (!trimmedName) return setValidationError(t("settingsX.mcp.nameEmpty"));
      if (otherNames.includes(trimmedName))
        return setValidationError(t("settingsX.mcp.nameDuplicate"));
      if (isStdio) {
        if (!command.trim()) return setValidationError(t("settingsX.mcp.stdioNeedsCommand"));
      } else {
        if (!url.trim()) return setValidationError(t("settingsX.mcp.needsUrl", { transport }));
        try {
          new URL(url.trim());
        } catch {
          return setValidationError(t("settingsX.mcp.urlInvalid"));
        }
      }
    }
    let env: Record<string, string> | undefined;
    let envVars: string[] | undefined;
    let headers: Record<string, string> | undefined;
    let envHeaders: Record<string, string> | undefined;
    try {
      env = parseKeyValueLines(envText);
      envVars = parseEnvNames(forwardEnvVarsText);
      headers = parseKeyValueLines(headersText);
      envHeaders = parseKeyValueLines(envHeadersText);
    } catch (e) {
      return setValidationError(
        t("settingsX.mcp.advParseFailed", { message: (e as Error).message }),
      );
    }

    const includeAllAuthFields = !authModeTouched;
    const includeBearerAuth = includeAllAuthFields || authMode === "bearer";
    const includeHeaderAuth = includeAllAuthFields || authMode === "headers";
    const includeOAuthAuth = includeAllAuthFields || authMode === "oauth";
    const nextCredentialRef =
      includeAllAuthFields || includeBearerAuth || includeOAuthAuth
        ? credentialRef || undefined
        : undefined;
    const nextBearerEnvVar = includeBearerAuth ? bearerEnvVar.trim() || undefined : undefined;
    const nextEnvHeaders =
      includeHeaderAuth && envHeaders && Object.keys(envHeaders).length ? envHeaders : undefined;
    const nextHeaders =
      includeHeaderAuth && headers && Object.keys(headers).length ? headers : undefined;

    // Override mode emits ONLY the supplement fields — saveOverride writes them
    // to the global mcpServerOverrides layer; command/url stay owned by the
    // plugin. We still key by the (locked) original name + transport.
    const next: McpServer = isOverride
      ? {
          name: trimmedName,
          transport,
          ...(isStdio
            ? {
                env: env && Object.keys(env).length ? env : undefined,
                envVars: envVars && envVars.length ? envVars : undefined,
              }
            : {
                credentialRef: nextCredentialRef,
                bearerTokenEnvVar: nextBearerEnvVar,
                envHeaders: nextEnvHeaders,
              }),
        }
      : {
          name: trimmedName,
          transport,
          ...(isStdio
            ? {
                command: command.trim(),
                args: args.trim() ? splitArgs(args.trim()) : undefined,
                env: env && Object.keys(env).length ? env : undefined,
                envVars: envVars && envVars.length ? envVars : undefined,
              }
            : {
                url: url.trim(),
                headers: nextHeaders,
                credentialRef: nextCredentialRef,
                bearerTokenEnvVar: nextBearerEnvVar,
                envHeaders: nextEnvHeaders,
              }),
        };
    onSave(next);
  };

  return (
    <div className="rounded-md border bg-card p-4">
      <header className="mb-4 flex items-center justify-between gap-3">
        <strong>
          {isOverride
            ? t("settingsX.mcp.overrideTitle", { name: initial?.name ?? "" })
            : initial
              ? t("settingsX.mcp.editTitle", { name: initial.name })
              : t("settingsX.mcp.addTitle")}
        </strong>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t("settingsX.mcp.close")}
        </Button>
      </header>

      {isOverride && (
        <p className="mb-4 rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">
          {t("settingsX.mcp.overrideNote")}
        </p>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
          <span>{t("settingsX.mcp.fieldName")}</span>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-server"
            disabled={isOverride}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
          <span>Transport</span>
          <Select<"stdio" | "streamable-http" | "sse">
            value={transport}
            onChange={(v) => setTransport(v)}
            disabled={isOverride}
            options={[
              {
                value: "stdio",
                label: "stdio",
                description: t("settingsX.mcp.transportStdioDesc"),
              },
              {
                value: "streamable-http",
                label: "HTTP",
                description: t("settingsX.mcp.transportHttpDesc"),
              },
              { value: "sse", label: "SSE", description: t("settingsX.mcp.transportSseDesc") },
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
          <label
            className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5"
            style={{ gridColumn: "1 / -1" }}
          >
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
        {showAdvanced ? `▾ ${t("settingsX.mcp.advanced")}` : `▸ ${t("settingsX.mcp.advanced")}`}
      </Button>

      {showAdvanced && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 ">
          {isStdio && (
            <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
              <span>{t("settingsX.mcp.envVarsLabel")}</span>
              <Textarea
                value={envText}
                onChange={(e) => setEnvText(e.target.value)}
                placeholder={"FOO=bar\nBAZ=qux"}
              />
              <span className="text-xs text-muted-foreground">
                {t("settingsX.mcp.envVarsHint")}
              </span>
            </label>
          )}
          {isStdio && (
            <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
              <span>{t("settingsX.mcp.forwardEnvVarsLabel")}</span>
              <Textarea
                value={forwardEnvVarsText}
                onChange={(e) => setForwardEnvVarsText(e.target.value)}
                placeholder={"GITHUB_TOKEN\nFIGMA_TOKEN"}
              />
              <span className="text-xs text-muted-foreground">
                {t("settingsX.mcp.forwardEnvVarsHint")}
              </span>
            </label>
          )}
          {!isStdio && (
            <>
              <div className="border-t pt-3 md:col-span-2">
                <div className="text-sm font-medium text-foreground">
                  {t("settingsX.mcp.httpAuthTitle")}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t("settingsX.mcp.httpAuthDesc")}
                </p>
              </div>
              <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground">
                <span>{t("settingsX.mcp.authMethodLabel")}</span>
                <Select<HttpAuthMode>
                  value={authMode}
                  onChange={setAuthModeFromUi}
                  options={[
                    { value: "none", label: t("settingsX.mcp.authModeNone") },
                    { value: "bearer", label: t("settingsX.mcp.authModeBearer") },
                    { value: "headers", label: t("settingsX.mcp.authModeHeaders") },
                    { value: "oauth", label: t("settingsX.mcp.authModeOAuth") },
                  ]}
                />
              </label>
              {authMode === "bearer" && (
                <>
                  <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground">
                    <span>{t("settingsX.mcp.useCredential")}</span>
                    <Select<string>
                      value={credentialRef}
                      onChange={(v) => setCredentialRef(v)}
                      options={[
                        { value: "", label: t("settingsX.mcp.credNone") },
                        ...bearerCredOptions,
                      ]}
                    />
                    <span className="text-xs text-muted-foreground">
                      {t("settingsX.mcp.useCredentialHint")}
                    </span>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                    <span>{t("settingsX.mcp.bearerEnvVarLabel")}</span>
                    <Input
                      value={bearerEnvVar}
                      onChange={(e) => setBearerEnvVar(e.target.value)}
                      placeholder="MY_MCP_TOKEN"
                    />
                    <span className="text-xs text-muted-foreground">
                      {t("settingsX.mcp.bearerEnvVarHint")}
                    </span>
                  </label>
                </>
              )}
              {authMode === "headers" && (
                <>
                  <label className="flex flex-col gap-1.5 text-sm md:col-span-2 [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                    <span>{t("settingsX.mcp.envHeadersLabel")}</span>
                    <Textarea
                      value={envHeadersText}
                      onChange={(e) => setEnvHeadersText(e.target.value)}
                      placeholder={"x-api-key: MCP_API_KEY\nX-API-Key: OTHER_MCP_KEY"}
                    />
                    <span className="text-xs text-muted-foreground">
                      {t("settingsX.mcp.envHeadersHint")}
                    </span>
                  </label>
                  {!isOverride && (
                    <label className="flex flex-col gap-1.5 text-sm md:col-span-2 [&>span]:text-muted-foreground [&_input]:rounded-sm [&_input]:border [&_input]:bg-transparent [&_input]:px-2 [&_input]:py-1.5 [&_textarea]:rounded-sm [&_textarea]:border [&_textarea]:bg-transparent [&_textarea]:px-2 [&_textarea]:py-1.5">
                      <span>{t("settingsX.mcp.headersLabel")}</span>
                      <Textarea
                        value={headersText}
                        onChange={(e) => setHeadersText(e.target.value)}
                        placeholder={"Accept: application/json\nX-Client-Name: code-shell"}
                      />
                      <span className="text-xs text-muted-foreground">
                        {t("settingsX.mcp.headersHint")}
                      </span>
                    </label>
                  )}
                </>
              )}
              {authMode === "oauth" && (
                <div className="md:col-span-2 rounded-md border bg-muted/20 p-3">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto]">
                    <label className="flex flex-col gap-1.5 text-sm [&>span]:text-muted-foreground">
                      <span>{t("settingsX.mcp.oauthCredential")}</span>
                      <Select<string>
                        value={credentialRef}
                        onChange={(v) => setCredentialRef(v)}
                        options={[
                          { value: "", label: t("settingsX.mcp.credNone") },
                          ...oauthCredOptions,
                        ]}
                      />
                    </label>
                    <div className="flex items-end gap-2">
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={onOAuthLogin}
                        disabled={oauthBusy}
                      >
                        {selectedOAuthCredential?.oauthStatus?.state === "expired"
                          ? t("settingsX.mcp.oauthRelogin")
                          : t("settingsX.mcp.oauthLogin")}
                      </Button>
                      <Button
                        type="button"
                        variant="default"
                        size="sm"
                        onClick={onOAuthRefresh}
                        disabled={!selectedOAuthCredential || oauthBusy}
                      >
                        {t("settingsX.mcp.oauthRefresh")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onOAuthLogout}
                        disabled={!selectedOAuthCredential || oauthBusy}
                      >
                        {t("settingsX.mcp.oauthLogout")}
                      </Button>
                    </div>
                  </div>
                  <OAuthCredentialStatus credential={selectedOAuthCredential} />
                  <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
                    <Input
                      value={oauthClientId}
                      onChange={(event) => setOAuthClientId(event.target.value)}
                      placeholder={t("settingsX.mcp.oauthClientIdPlaceholder")}
                      disabled={oauthBusy}
                    />
                    <Input
                      value={oauthScopes}
                      onChange={(event) => setOAuthScopes(event.target.value)}
                      placeholder={t("settingsX.mcp.oauthScopesPlaceholder")}
                      disabled={oauthBusy}
                    />
                    <Input
                      value={oauthAuthorizationEndpoint}
                      onChange={(event) => setOAuthAuthorizationEndpoint(event.target.value)}
                      placeholder={t("settingsX.mcp.oauthAuthorizationPlaceholder")}
                      disabled={oauthBusy}
                    />
                    <Input
                      value={oauthTokenEndpoint}
                      onChange={(event) => setOAuthTokenEndpoint(event.target.value)}
                      placeholder={t("settingsX.mcp.oauthTokenPlaceholder")}
                      disabled={oauthBusy}
                    />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("settingsX.mcp.oauthDiscoveryHint")}
                  </p>
                  {oauthError && <p className="mt-2 text-xs text-status-err">{oauthError}</p>}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {validationError && (
        <div className="rounded-md bg-status-err/10 p-3 text-sm text-status-err">
          {validationError}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button variant="default" onClick={onCancel}>
          {t("settingsX.mcp.cancel")}
        </Button>
        <Button variant="solid" onClick={submit} disabled={oauthBusy}>
          {initial ? t("settingsX.mcp.save") : t("settingsX.mcp.add")}
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
  const { t } = useT();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between gap-3">
          <strong>
            {t("settingsX.mcp.toolsHeader", { name: probe.name, count: probe.tools?.length ?? 0 })}
          </strong>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("settingsX.mcp.close")}
          </Button>
        </header>
        {probe.tools && probe.tools.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {probe.tools.map((tool) => (
              <li key={tool.name} className="rounded-md border p-2">
                <code className="font-mono text-xs text-foreground">{tool.name}</code>
                {tool.description && (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {tool.description}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {t("settingsX.mcp.noToolReturned")}
          </div>
        )}
      </div>
    </div>
  );
}

function ErrorDetailViewer({ probe, onClose }: { probe: McpProbeResult; onClose: () => void }) {
  const { t } = useT();
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-md border bg-popover p-4 text-popover-foreground shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between gap-3">
          <strong>{t("settingsX.mcp.errorDetailHeader", { name: probe.name })}</strong>
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t("settingsX.mcp.close")}
          </Button>
        </header>
        <div className="rounded-md bg-status-err/10 p-2 text-sm text-status-err">
          {probe.errorMessage}
        </div>
        <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
          {probe.errorDetail}
        </pre>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────

export function mcpServersFromSettings(value: unknown): McpServer[] {
  if (Array.isArray(value)) {
    return value.filter(
      (x): x is McpServer =>
        !!x && typeof x === "object" && typeof (x as McpServer).name === "string",
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
        .filter(
          (x): x is McpServer =>
            !!x && typeof x === "object" && typeof (x as McpServer).name === "string",
        )
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

function envNamesToText(names: string[] | undefined): string {
  return names?.join("\n") ?? "";
}

function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    const equals = line.indexOf("=");
    const idx = equals >= 0 && (colon < 0 || equals < colon) ? equals : colon;
    if (idx < 0)
      throw new Error(translate(loadUILanguage(), "settingsX.mcp.parseFailedLine", { line }));
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 1).trim();
    if (!k) throw new Error(translate(loadUILanguage(), "settingsX.mcp.emptyKeyLine", { line }));
    out[k] = v;
  }
  return out;
}

function parseEnvNames(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("=") || line.includes(":")) {
      throw new Error(translate(loadUILanguage(), "settingsX.mcp.envNameOnlyLine", { line }));
    }
    if (/\s/.test(line)) {
      throw new Error(
        translate(loadUILanguage(), "settingsX.mcp.envNameNoWhitespaceLine", { line }),
      );
    }
    if (!seen.has(line)) {
      out.push(line);
      seen.add(line);
    }
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
