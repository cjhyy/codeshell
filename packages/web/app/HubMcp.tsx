import React from "react";
import { ApiError, browserId } from "./auth.js";
import { getApiWorkspace, getApiProject } from "./api-context.js";
import {
  cancelMcpProbe,
  deleteMcpServer,
  enableMcpServer,
  inheritMcpServer,
  makeMcpDraft,
  needsMcpSecretReuse,
  probeMcpServer,
  readMcpConfiguration,
  saveMcpServer,
  type HubMcpConfiguration,
  type HubMcpServer,
  type McpDraft,
  type McpKeyRow,
  type McpProbeResult,
} from "./mcp-configuration.js";
import "./hub-mcp.css";

interface Props {
  onAuthLost: () => void;
  onConfigurationChange?: () => void;
  configurationVersion?: number;
  onDirtyChange?: (dirty: boolean) => void;
}
type Save = (
  operation: (signal: AbortSignal) => Promise<HubMcpConfiguration>,
  message?: string,
  onError?: (cause: unknown) => void,
) => Promise<boolean>;

interface McpFocusLease {
  source: HTMLElement;
  cancelled: boolean;
}

/** Native disabling may leave BODY focused; an explicit handoff cancels recovery. */
function useMcpOperationFocus() {
  const live = React.useRef(false);
  const leases = React.useRef(new Set<McpFocusLease>());
  React.useLayoutEffect(() => {
    live.current = true;
    const handoff = (event: Event) => {
      const target =
        event instanceof FocusEvent && event.type === "focusout"
          ? event.relatedTarget
          : event.target;
      if (!(target instanceof Node) || (target === document.body && event.type !== "pointerdown"))
        return;
      for (const lease of leases.current) {
        if (!lease.source.contains(target)) lease.cancelled = true;
      }
    };
    const blur = () => {
      for (const lease of leases.current) lease.cancelled = true;
    };
    document.addEventListener("focusin", handoff, true);
    document.addEventListener("focusout", handoff, true);
    document.addEventListener("pointerdown", handoff, true);
    window.addEventListener("blur", blur);
    return () => {
      live.current = false;
      blur();
      leases.current.clear();
      document.removeEventListener("focusin", handoff, true);
      document.removeEventListener("focusout", handoff, true);
      document.removeEventListener("pointerdown", handoff, true);
      window.removeEventListener("blur", blur);
    };
  }, []);
  const capture = React.useCallback((scope: HTMLElement | null): McpFocusLease | null => {
    const source = document.activeElement;
    if (!(source instanceof HTMLElement) || source === document.body || !scope?.contains(source))
      return null;
    const lease = { source, cancelled: false };
    leases.current.add(lease);
    return lease;
  }, []);
  const discard = React.useCallback((lease: McpFocusLease | null) => {
    if (!lease) return;
    lease.cancelled = true;
    leases.current.delete(lease);
  }, []);
  const finish = React.useCallback(
    (lease: McpFocusLease | null, target: HTMLElement | null) => {
      const active = document.activeElement;
      const owned =
        live.current &&
        lease &&
        !lease.cancelled &&
        (active === document.body || active === lease.source || !active?.isConnected);
      discard(lease);
      if (owned && target?.isConnected && !target.matches(":disabled")) {
        target.focus();
        if (target.classList.contains("hub-mcp-operation-error"))
          target.scrollIntoView({ block: "center", inline: "nearest" });
      }
    },
    [discard],
  );
  return { capture, discard, finish };
}
const sourceLabels: Record<HubMcpServer["scope"], string> = {
  local: "工作区本地",
  project: "工作区配置",
  user: "用户级",
  managed: "启动配置",
  plugin: "插件提供",
};

/** Full MCP settings view, mounted inside HubSettings so typography/navigation stay shared. */
export function HubMcp({
  onAuthLost,
  onConfigurationChange,
  configurationVersion = 0,
  onDirtyChange,
}: Props) {
  const [configuration, setConfiguration] = React.useState<HubMcpConfiguration | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [draftDirty, setDraftDirty] = React.useState(false);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [editing, setEditing] = React.useState<
    { kind: "new" } | { kind: "edit"; name: string; original: HubMcpServer } | null
  >(null);
  const [deleting, setDeleting] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<Record<string, McpProbeResult>>({});
  const [probing, setProbing] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const callbacks = React.useRef({ onAuthLost, onConfigurationChange, onDirtyChange });
  callbacks.current = { onAuthLost, onConfigurationChange, onDirtyChange };
  const mounted = React.useRef(false);
  const readController = React.useRef<AbortController | null>(null);
  const writeController = React.useRef<AbortController | null>(null);
  const probeController = React.useRef<{
    name: string;
    workspace?: string;
    projectId: string | null;
    controller: AbortController;
  } | null>(null);
  const revision = React.useRef(0);
  const refreshQueued = React.useRef(false);
  const previousVersion = React.useRef(configurationVersion);
  const focus = useMcpOperationFocus();
  const scope = React.useRef<HTMLDivElement>(null);
  const addButton = React.useRef<HTMLButtonElement>(null);
  const searchInput = React.useRef<HTMLInputElement>(null);
  const editorOpener = React.useRef<HTMLButtonElement | null>(null);
  const editorOpenerName = React.useRef<string | null>(null);
  const editButtons = React.useRef(new Map<string, HTMLButtonElement>());
  const editorInitialFocus = React.useRef<McpFocusLease | null>(null);
  const editorReturnFocus = React.useRef<McpFocusLease | null>(null);
  const removeOpener = React.useRef<HTMLButtonElement | null>(null);
  const removeInitialFocus = React.useRef<McpFocusLease | null>(null);
  const removeReturnFocus = React.useRef<McpFocusLease | null>(null);
  const cancelRemoval = React.useRef<HTMLButtonElement>(null);
  const removalErrorRef = React.useRef<HTMLParagraphElement>(null);
  const removalPending = React.useRef(false);
  const [removalError, setRemovalError] = React.useState("");
  const [removalFinished, setRemovalFinished] = React.useState<{
    lease: McpFocusLease | null;
    name: string;
    ok: boolean;
  } | null>(null);

  React.useEffect(() => {
    callbacks.current.onDirtyChange?.(draftDirty || busy);
  }, [draftDirty, busy]);

  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) callbacks.current.onAuthLost();
    else setError(cause instanceof Error ? cause.message : "MCP 操作失败，请重试。");
  }, []);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      callbacks.current.onDirtyChange?.(false);
      writeController.current?.abort();
      const active = probeController.current;
      if (active) {
        active.controller.abort();
        void cancelMcpProbe(active.name, active.workspace, active.projectId).catch(() => {});
      }
    };
  }, []);
  React.useEffect(() => {
    if (previousVersion.current === configurationVersion) return;
    previousVersion.current = configurationVersion;
    if (writeController.current) refreshQueued.current = true;
    else setReload((value) => value + 1);
  }, [configurationVersion]);
  React.useEffect(() => {
    const controller = new AbortController();
    readController.current = controller;
    const readStarted = Date.now();
    const current = ++revision.current;
    setLoading(true);
    setError("");
    void readMcpConfiguration(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && current === revision.current) {
          setConfiguration(value);
          setResults((previous) =>
            Object.fromEntries(
              Object.entries(previous).filter(
                ([, result]) => Date.parse(result.checkedAt) >= readStarted,
              ),
            ),
          );
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && current === revision.current) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted && current === revision.current) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, report]);

  const save: Save = async (
    operation,
    message = "MCP 设置已保存，任务进程会加载新的配置。",
    onError,
  ) => {
    if (writeController.current || probeController.current) return false;
    readController.current?.abort();
    const current = ++revision.current;
    const controller = new AbortController();
    writeController.current = controller;
    setBusy(true);
    setLoading(false);
    setError("");
    setNotice("");
    try {
      const value = await operation(controller.signal);
      if (!mounted.current || controller.signal.aborted || current !== revision.current)
        return false;
      setConfiguration(value);
      setResults({});
      setNotice(message);
      callbacks.current.onConfigurationChange?.();
      return true;
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) {
        if (onError && !(cause instanceof ApiError && cause.status === 401)) onError(cause);
        else report(cause);
      }
      return false;
    } finally {
      if (writeController.current === controller) writeController.current = null;
      if (mounted.current && !controller.signal.aborted) {
        setBusy(false);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          setLoading(true);
          setReload((value) => value + 1);
        }
      }
    }
  };

  const probe = async (name: string) => {
    if (probeController.current || writeController.current) return;
    const controller = new AbortController();
    probeController.current = {
      name,
      controller,
      workspace: getApiWorkspace() ?? "",
      projectId: getApiProject(),
    };
    setProbing(name);
    setError("");
    setNotice("");
    setResults((previous) => {
      const next = { ...previous };
      delete next[name];
      return next;
    });
    try {
      const result = await probeMcpServer(name, controller.signal);
      if (mounted.current && !controller.signal.aborted)
        setResults((previous) => ({ ...previous, [name]: result }));
    } catch (cause) {
      if (mounted.current && !controller.signal.aborted) report(cause);
    } finally {
      if (probeController.current?.controller === controller) probeController.current = null;
      if (mounted.current) setProbing(null);
    }
  };
  const cancelProbe = async () => {
    const active = probeController.current;
    if (!active) return;
    try {
      await cancelMcpProbe(active.name, active.workspace, active.projectId);
    } catch (cause) {
      if (mounted.current) report(cause);
    } finally {
      active.controller.abort();
      if (probeController.current === active) probeController.current = null;
      if (mounted.current) {
        setProbing(null);
        setResults((previous) => ({
          ...previous,
          [active.name]: {
            name: active.name,
            status: "cancelled",
            checkedAt: new Date().toISOString(),
            durationMs: 0,
            error: { code: "cancelled", message: "测试已取消。" },
          },
        }));
      }
    }
  };
  const disabled = busy || loading || probing !== null;
  React.useEffect(() => {
    if (
      deleting &&
      configuration &&
      !configuration.servers.some((server) => server.name === deleting)
    )
      setDeleting(null);
  }, [configuration, deleting]);
  React.useLayoutEffect(() => {
    if (disabled) return;
    if (editing === null && editorReturnFocus.current) {
      const target = editorOpener.current?.isConnected
        ? editorOpener.current
        : editorOpenerName.current
          ? editButtons.current.get(editorOpenerName.current)
          : null;
      focus.finish(
        editorReturnFocus.current,
        target?.isConnected && !target.disabled
          ? target
          : (addButton.current ?? searchInput.current),
      );
      editorReturnFocus.current = null;
    }
    if (deleting && removeInitialFocus.current) {
      focus.finish(removeInitialFocus.current, cancelRemoval.current);
      removeInitialFocus.current = null;
    }
    if (!deleting && removeReturnFocus.current) {
      const target = removeOpener.current;
      focus.finish(
        removeReturnFocus.current,
        target?.isConnected && !target.disabled ? target : searchInput.current,
      );
      removeReturnFocus.current = null;
    }
    if (removalFinished) {
      const targetGone = !configuration?.servers.some(
        (server) => server.name === removalFinished.name,
      );
      // A queued refresh can remove the old card. Let its confirmation cleanup
      // mount the local receipt before consuming this operation's focus lease.
      if (!removalFinished.ok && targetGone && deleting === removalFinished.name) return;
      setRemovalFinished(null);
      removalPending.current = false;
      if (deleting !== removalFinished.name && !(targetGone && deleting === null))
        focus.discard(removalFinished.lease);
      else if (removalFinished.ok) {
        removeReturnFocus.current = removalFinished.lease;
        setDeleting(null);
      } else
        focus.finish(
          removalFinished.lease,
          removalErrorRef.current ?? cancelRemoval.current ?? searchInput.current,
        );
    }
  }, [configuration, deleting, disabled, editing, focus, removalFinished]);
  const openEditor = (next: NonNullable<typeof editing>, opener: HTMLButtonElement) => {
    editorOpener.current = opener;
    editorOpenerName.current = next.kind === "edit" ? next.name : null;
    focus.discard(editorInitialFocus.current);
    editorInitialFocus.current = focus.capture(scope.current);
    setEditing(next);
  };
  const closeEditor = (lease: McpFocusLease | null) => {
    editorReturnFocus.current = lease;
    setEditing(null);
  };
  const editorReady = (target: HTMLElement | null) => {
    focus.finish(editorInitialFocus.current, target);
    editorInitialFocus.current = null;
  };
  const needle = query.trim().toLocaleLowerCase();
  const available = [...(configuration?.servers ?? [])];
  // An external deletion must not unmount an editor and discard unsaved secret fields.
  if (editing?.kind === "edit" && !available.some((server) => server.name === editing.name))
    available.push(editing.original);
  const servers = available.filter(
    (server) =>
      !needle ||
      server.name.toLocaleLowerCase().includes(needle) ||
      (editing?.kind === "edit" && editing.name === server.name),
  );
  const edited =
    editing?.kind === "edit" ? available.find((server) => server.name === editing.name) : undefined;

  return (
    <div ref={scope} className="hub-mcp">
      <div className="config-section-heading hub-mcp-toolbar">
        <label className="config-search">
          <span aria-hidden="true">⌕</span>
          <input
            ref={searchInput}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 MCP 服务…"
            aria-label="搜索 MCP 服务"
          />
        </label>
        <div className="hub-mcp-toolbar-actions">
          <button
            className="config-button config-button-quiet"
            disabled={disabled}
            onClick={() => setReload((value) => value + 1)}
          >
            刷新 MCP
          </button>
          <button
            ref={addButton}
            className="config-button"
            disabled={disabled || editing !== null}
            onClick={(event) => openEditor({ kind: "new" }, event.currentTarget)}
          >
            ＋ 添加服务
          </button>
        </div>
      </div>
      {error && (
        <p className="config-message config-error" role="alert">
          {error}
        </p>
      )}
      {!deleting && removalError && (
        <p
          ref={removalErrorRef}
          className="config-message config-error hub-mcp-operation-error"
          role="alert"
          tabIndex={0}
          aria-label="移除 MCP 服务失败"
        >
          {removalError}
        </p>
      )}
      {notice && (
        <p className="config-message config-success" role="status">
          {notice}
        </p>
      )}
      {busy && (
        <p className="config-help" role="status">
          正在保存 MCP 配置…
        </p>
      )}
      {loading && !configuration && (
        <p className="config-help" role="status">
          正在读取 MCP 配置…
        </p>
      )}
      {editing?.kind === "new" && (
        <div className="config-card hub-mcp-editor-card">
          <h2>添加 MCP 服务</h2>
          <McpEditor
            disabled={disabled}
            save={save}
            focus={focus}
            onReady={editorReady}
            onDone={closeEditor}
            onProbe={(name) => void probe(name)}
            onDirtyChange={setDraftDirty}
          />
        </div>
      )}
      {!servers.length && configuration && editing?.kind !== "new" && (
        <div className="config-empty">
          <span aria-hidden="true">⌘</span>
          <h3>{needle ? "没有匹配的服务" : "连接你的工具与数据"}</h3>
          <p>
            {needle
              ? "试试其他服务名称。"
              : "添加运行 CodeShell 的设备上的命令，或连接提供 MCP 接口的 HTTP 服务。"}
          </p>
        </div>
      )}
      <div className="hub-mcp-list">
        {servers.map((server) => (
          <article className="config-card hub-mcp-card" key={server.name}>
            <div className="hub-mcp-card-head">
              <span className="config-row-icon" aria-hidden="true">
                ⌘
              </span>
              <div className="config-row-copy">
                <strong>{server.name}</strong>
                <span>
                  {server.transport === "stdio"
                    ? "本地命令"
                    : server.transport === "inprocess"
                      ? "内置工具"
                      : "HTTP 服务"}{" "}
                  · {sourceLabels[server.scope]}
                </span>
              </div>
              <button
                className="config-switch"
                type="button"
                role="switch"
                aria-checked={server.enabled}
                aria-label={`${server.enabled ? "停用" : "启用"} MCP ${server.name}`}
                disabled={disabled || server.pluginDisabled}
                onClick={() =>
                  void save((signal) => enableMcpServer(server.name, !server.enabled, signal))
                }
              >
                <span />
              </button>
            </div>
            {editing?.kind === "edit" && editing.name === server.name && edited ? (
              <McpEditor
                key={server.name}
                server={edited}
                disabled={disabled}
                save={save}
                focus={focus}
                onReady={editorReady}
                onDone={closeEditor}
                onProbe={(name) => void probe(name)}
                onDirtyChange={setDraftDirty}
              />
            ) : (
              <>
                <p className="hub-mcp-endpoint">
                  <code>
                    {server.transport === "stdio" ? server.command : server.url || "由任务进程提供"}
                  </code>
                  {server.argsCount > 0 && <span>{server.argsCount} 个已保存参数</span>}
                </p>
                <div className="hub-mcp-metadata">
                  <span className={`config-badge${server.enabled ? " config-badge-accent" : ""}`}>
                    {server.enabled ? "配置启用" : "配置停用"}
                  </span>
                  {server.envKeys.length > 0 && <span>{server.envKeys.length} 个环境变量</span>}
                  {(server.headerKeys.length > 0 ||
                    server.credentialRef ||
                    server.bearerTokenEnvVar ||
                    Object.keys(server.envHeaders).length > 0) && <span>已配置认证</span>}
                  {server.hasLocalOverride && <span>本地覆盖</span>}
                </div>
                {server.source === "plugin" && (
                  <p className="config-help">
                    {server.pluginDisabled
                      ? "所属插件已停用。启用插件后，才能启用或测试这个服务。"
                      : "连接命令与地址由插件提供，可在此启停或测试。"}
                  </p>
                )}
                <div className="hub-mcp-card-actions">
                  {probing === server.name ? (
                    <button className="config-button" onClick={() => void cancelProbe()}>
                      取消测试
                    </button>
                  ) : (
                    <button
                      className="config-button"
                      disabled={
                        disabled || server.pluginDisabled || server.transport === "inprocess"
                      }
                      onClick={() => void probe(server.name)}
                    >
                      测试连接
                    </button>
                  )}
                  {server.editable && (
                    <button
                      ref={(node) => {
                        if (node) editButtons.current.set(server.name, node);
                        else editButtons.current.delete(server.name);
                      }}
                      className="config-button config-button-quiet"
                      disabled={disabled || editing !== null}
                      onClick={(event) => {
                        setDeleting(null);
                        openEditor(
                          { kind: "edit", name: server.name, original: server },
                          event.currentTarget,
                        );
                      }}
                    >
                      编辑
                    </button>
                  )}
                  {server.hasLocalOverride && (
                    <button
                      className="config-button config-button-quiet"
                      disabled={disabled}
                      onClick={() =>
                        void save(
                          (signal) => inheritMcpServer(server.name, signal),
                          "已移除本地覆盖，恢复继承配置。",
                        )
                      }
                    >
                      恢复继承
                    </button>
                  )}
                  {server.deletable && (
                    <button
                      className="config-button config-button-quiet hub-mcp-remove"
                      disabled={disabled || editing !== null}
                      onClick={(event) => {
                        removeOpener.current = event.currentTarget;
                        removeInitialFocus.current = focus.capture(scope.current);
                        setRemovalError("");
                        setDeleting(server.name);
                      }}
                    >
                      移除
                    </button>
                  )}
                </div>
                {deleting === server.name && (
                  <div className="hub-mcp-delete" role={removalError ? undefined : "alert"}>
                    <span>从当前工作区移除 {server.name}？其他工作区的配置不受影响。</span>
                    {removalError && (
                      <p
                        ref={removalErrorRef}
                        className="config-message config-error hub-mcp-operation-error"
                        role="alert"
                        tabIndex={0}
                        aria-label="移除 MCP 服务失败"
                      >
                        {removalError}
                      </p>
                    )}
                    <div>
                      <button
                        ref={cancelRemoval}
                        className="config-button config-button-quiet"
                        disabled={disabled}
                        onClick={() => {
                          removeReturnFocus.current = focus.capture(scope.current);
                          setDeleting(null);
                          setRemovalError("");
                        }}
                      >
                        取消
                      </button>
                      <button
                        className="config-button hub-mcp-remove"
                        disabled={disabled}
                        onClick={async () => {
                          if (disabled || removalPending.current) return;
                          removalPending.current = true;
                          const lease = focus.capture(scope.current);
                          setRemovalError("");
                          const ok = await save(
                            (signal) => deleteMcpServer(server.name, signal),
                            "已从当前工作区移除服务。",
                            (cause) =>
                              setRemovalError(
                                cause instanceof Error ? cause.message : "MCP 操作失败，请重试。",
                              ),
                          );
                          if (mounted.current) setRemovalFinished({ lease, name: server.name, ok });
                        }}
                      >
                        确认移除
                      </button>
                    </div>
                  </div>
                )}
                {probing === server.name && (
                  <p className="hub-mcp-probing" role="status">
                    正在建立测试连接并读取工具列表…
                  </p>
                )}
                {results[server.name] && <ProbeResult result={results[server.name]!} />}
              </>
            )}
          </article>
        ))}
      </div>
      {!!configuration?.removed.length && (
        <details className="hub-mcp-removed">
          <summary>已在当前工作区移除（{configuration.removed.length}）</summary>
          {configuration.removed.map((item) => (
            <div className="hub-mcp-removed-row" key={item.name}>
              <span>{item.name}</span>
              <button
                className="config-button config-button-quiet"
                disabled={disabled}
                onClick={() =>
                  void save(
                    (signal) => inheritMcpServer(item.name, signal),
                    "已恢复继承的 MCP 配置。",
                  )
                }
              >
                恢复继承
              </button>
            </div>
          ))}
        </details>
      )}
      <p className="config-help hub-mcp-explanation">
        连接使用运行 CodeShell
        的设备上的网络、环境和凭据。测试只建立一次短连接并读取工具列表，完成后关闭；不会调用工具或改变启用状态。
      </p>
    </div>
  );
}

function McpEditor({
  server,
  disabled,
  save,
  focus,
  onReady,
  onDone,
  onProbe,
  onDirtyChange,
}: {
  server?: HubMcpServer;
  disabled: boolean;
  save: Save;
  focus: ReturnType<typeof useMcpOperationFocus>;
  onReady: (target: HTMLElement | null) => void;
  onDone: (lease: McpFocusLease | null) => void;
  onProbe: (name: string) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  // Preserve the editing baseline across external refreshes so untouched fields never overwrite another device's changes.
  const original = React.useRef(server).current;
  const formRef = React.useRef<HTMLFormElement>(null);
  const nameRef = React.useRef<HTMLInputElement>(null);
  const commandRef = React.useRef<HTMLInputElement>(null);
  const urlRef = React.useRef<HTMLInputElement>(null);
  const errorRef = React.useRef<HTMLParagraphElement>(null);
  const live = React.useRef(false);
  const pending = React.useRef(false);
  const [finished, setFinished] = React.useState<{
    lease: McpFocusLease | null;
    ok: boolean;
    testAfter: boolean;
  } | null>(null);
  React.useLayoutEffect(() => {
    live.current = true;
    onReady(original ? (commandRef.current ?? urlRef.current) : nameRef.current);
    return () => {
      live.current = false;
    };
  }, []);
  const [draft, setDraft] = React.useState(() => makeMcpDraft(original));
  const baseline = React.useRef(JSON.stringify(draft)).current;
  const dirty = JSON.stringify(draft) !== baseline;
  React.useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  React.useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const [error, setError] = React.useState("");
  const patch = <K extends keyof McpDraft>(field: K, value: McpDraft[K]) =>
    setDraft((previous) => ({ ...previous, [field]: value }));
  const reuse = needsMcpSecretReuse(draft, original);
  const stdio = draft.transport === "stdio";
  React.useLayoutEffect(() => {
    if (disabled || !finished) return;
    setFinished(null);
    pending.current = false;
    if (finished.ok) {
      onDone(finished.lease);
      if (finished.testAfter) onProbe(draft.name.trim());
    } else
      focus.finish(
        finished.lease,
        errorRef.current ?? commandRef.current ?? urlRef.current ?? nameRef.current,
      );
  }, [disabled, draft.name, finished, focus, onDone, onProbe]);
  return (
    <form
      ref={formRef}
      className="hub-mcp-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || pending.current) return;
        pending.current = true;
        const lease = focus.capture(formRef.current);
        setError("");
        const testAfter =
          (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-probe") === "true";
        try {
          const ok = await save(
            (signal) => saveMcpServer(draft, original, signal),
            undefined,
            (cause) => {
              if (live.current)
                setError(cause instanceof Error ? cause.message : "请检查填写内容。");
            },
          );
          if (live.current) setFinished({ lease, ok, testAfter });
          else focus.discard(lease);
        } catch (cause) {
          if (live.current) {
            setError(cause instanceof Error ? cause.message : "请检查填写内容。");
            setFinished({ lease, ok: false, testAfter });
          } else focus.discard(lease);
        }
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="config-sr-only">
          {original ? `编辑 MCP ${original.name}` : "新 MCP 服务"}
        </legend>
        <div className="config-form-grid">
          <label>
            <span>服务名称</span>
            <input
              ref={nameRef}
              required
              readOnly={!!original}
              maxLength={128}
              pattern="[A-Za-z0-9][A-Za-z0-9._:\-]*"
              value={draft.name}
              onChange={(event) => patch("name", event.target.value)}
              placeholder="例如 workspace-tools"
            />
          </label>
          <label>
            <span>连接方式</span>
            <select
              aria-label="连接方式"
              value={draft.transport}
              onChange={(event) => patch("transport", event.target.value)}
            >
              <option value="stdio">本地命令（stdio）</option>
              <option value="streamable-http">HTTP（Streamable HTTP）</option>
              {original?.transport === "sse" && <option value="sse">HTTP（已有 SSE 配置）</option>}
            </select>
          </label>
          {stdio ? (
            <>
              <label className="config-full-width">
                <span>启动命令</span>
                <input
                  ref={commandRef}
                  required
                  aria-label="启动命令"
                  value={draft.command}
                  onChange={(event) => patch("command", event.target.value)}
                  placeholder="例如 node、uvx 或可执行文件路径"
                />
                <small>在当前工作区执行。命令与参数分别填写。</small>
              </label>
              <label className="config-full-width">
                <span>命令参数</span>
                <textarea
                  aria-label="命令参数"
                  rows={3}
                  disabled={draft.clearArgs}
                  value={draft.args}
                  onChange={(event) => patch("args", event.target.value)}
                  placeholder={
                    original?.argsCount
                      ? `已有 ${original.argsCount} 个参数，留空保留。填写后将完整替换。`
                      : "每行一个参数，不需要额外添加引号"
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
                <small>参数可能含密钥，因此不会读回已有值。每一行会作为一个完整参数。</small>
              </label>
              {!!original?.argsCount && (
                <label className="hub-mcp-check config-full-width">
                  <input
                    type="checkbox"
                    checked={draft.clearArgs}
                    onChange={(event) => patch("clearArgs", event.target.checked)}
                  />
                  <span>清空已保存的所有参数</span>
                </label>
              )}
            </>
          ) : (
            <label className="config-full-width">
              <span>MCP 接口地址</span>
              <input
                ref={urlRef}
                type="url"
                aria-label="MCP 接口地址"
                required
                value={draft.url}
                onChange={(event) => patch("url", event.target.value)}
                placeholder="https://example.com/mcp"
              />
              {original?.urlHasHiddenParts && (
                <small>已有地址的查询参数已隐藏；不修改地址时会保留。</small>
              )}
            </label>
          )}
        </div>
        {stdio ? (
          <KeyRows title="环境变量" rows={draft.env} onChange={(rows) => patch("env", rows)} />
        ) : (
          <KeyRows
            title="请求头"
            rows={draft.headers}
            onChange={(rows) => patch("headers", rows)}
          />
        )}
        <details className="hub-mcp-advanced">
          <summary>高级配置</summary>
          <div className="config-form-grid">
            {stdio ? (
              <label className="config-full-width">
                <span>转发运行环境变量</span>
                <textarea
                  aria-label="转发运行环境变量"
                  rows={2}
                  value={draft.envVars}
                  onChange={(event) => patch("envVars", event.target.value)}
                  placeholder="每行一个环境变量名称，例如 GITHUB_TOKEN"
                />
                <small>只填写名称，实际值在连接时从CodeShell 的启动环境读取。</small>
              </label>
            ) : (
              <>
                <label>
                  <span>Bearer Token 环境变量</span>
                  <input
                    aria-label="Bearer Token 环境变量"
                    value={draft.bearerTokenEnvVar}
                    onChange={(event) => patch("bearerTokenEnvVar", event.target.value)}
                    placeholder="例如 MCP_ACCESS_TOKEN"
                    autoComplete="off"
                  />
                  <small>填写运行环境中的变量名称。</small>
                </label>
                <label>
                  <span>已存储的凭据 ID</span>
                  <input
                    aria-label="已存储的凭据 ID"
                    value={draft.credentialRef}
                    onChange={(event) => patch("credentialRef", event.target.value)}
                    placeholder="可选"
                    autoComplete="off"
                  />
                  <small>引用已有凭据；优先于 Bearer 环境变量。</small>
                </label>
              </>
            )}
          </div>
          {!stdio && (
            <KeyRows
              title="环境变量请求头"
              rows={draft.envHeaders}
              onChange={(rows) => patch("envHeaders", rows)}
              visibleValues
            />
          )}
          <label className="hub-mcp-check">
            <input
              type="checkbox"
              checked={draft.restrictTools}
              onChange={(event) => patch("restrictTools", event.target.checked)}
            />
            <span>只允许指定工具</span>
          </label>
          <div className="config-form-grid">
            {draft.restrictTools && (
              <label className="config-full-width">
                <span>允许的工具名称</span>
                <textarea
                  rows={2}
                  value={draft.allowedTools}
                  onChange={(event) => patch("allowedTools", event.target.value)}
                  placeholder="每行一个精确工具名称；留空则不开放任何工具"
                />
              </label>
            )}
            <label className="config-full-width">
              <span>停用的工具名称</span>
              <textarea
                rows={2}
                value={draft.disabledTools}
                onChange={(event) => patch("disabledTools", event.target.value)}
                placeholder="每行一个精确工具名称，可留空"
              />
            </label>
          </div>
        </details>
        <label className="hub-mcp-check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => patch("enabled", event.target.checked)}
          />
          <span>启用服务，让任务可以使用这些工具</span>
        </label>
        {reuse && (
          <label className="hub-mcp-check hub-mcp-reuse">
            <input
              type="checkbox"
              required
              checked={draft.reuseStoredSecrets}
              onChange={(event) => patch("reuseStoredSecrets", event.target.checked)}
            />
            <span>允许新的启动方式或服务地址使用已保存的参数、环境变量和认证配置。</span>
          </label>
        )}
        {error && (
          <p
            ref={errorRef}
            className="config-error config-message hub-mcp-operation-error"
            role="alert"
            tabIndex={0}
            aria-label="保存 MCP 配置失败"
          >
            {error}
          </p>
        )}
        <div className="config-form-actions">
          <button
            type="button"
            className="config-button config-button-quiet"
            onClick={() => onDone(focus.capture(formRef.current))}
          >
            取消
          </button>
          <button type="submit" data-probe="true" className="config-button">
            保存并测试
          </button>
          <button type="submit" className="config-button config-button-primary">
            保存配置
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function KeyRows({
  title,
  rows,
  onChange,
  visibleValues = false,
}: {
  title: string;
  rows: McpKeyRow[];
  onChange: (rows: McpKeyRow[]) => void;
  visibleValues?: boolean;
}) {
  const patch = (id: string, update: Partial<McpKeyRow>) =>
    onChange(rows.map((row) => (row.id === id ? { ...row, ...update } : row)));
  return (
    <div className="hub-mcp-keys">
      <div className="hub-mcp-key-heading">
        <h3>{title}</h3>
        <button
          className="config-text-button"
          type="button"
          onClick={() =>
            onChange([
              ...rows,
              { id: browserId(), name: "", value: "", stored: false, removed: false },
            ])
          }
        >
          ＋ 添加{title}
        </button>
      </div>
      {!rows.length && (
        <p className="config-help">
          {visibleValues ? "可按请求头名称引用运行环境变量。" : "无需此项时可以留空。"}
        </p>
      )}
      {rows.map((row) => (
        <div className={`hub-mcp-key-row${row.removed ? " hub-mcp-key-removed" : ""}`} key={row.id}>
          <label>
            <span className="config-sr-only">{title}名称</span>
            <input
              aria-label={`${title}名称`}
              value={row.name}
              readOnly={row.stored}
              disabled={row.removed}
              onChange={(event) => patch(row.id, { name: event.target.value })}
              placeholder={title === "环境变量" ? "例如 API_KEY" : "例如 Authorization"}
              autoComplete="off"
            />
          </label>
          <label>
            <span className="config-sr-only">{title}值</span>
            <input
              aria-label={`${title} ${row.name || "新条目"} 的值`}
              type={visibleValues ? "text" : "password"}
              value={row.value}
              disabled={row.removed}
              onChange={(event) => patch(row.id, { value: event.target.value })}
              placeholder={
                row.removed
                  ? "保存时移除"
                  : visibleValues
                    ? "运行环境变量名称"
                    : row.stored
                      ? "已配置 · 留空保留"
                      : "输入值"
              }
              autoComplete={visibleValues ? "off" : "new-password"}
              spellCheck={false}
            />
          </label>
          <button
            className="config-button config-button-quiet"
            type="button"
            onClick={() =>
              row.stored
                ? patch(row.id, { removed: !row.removed })
                : onChange(rows.filter((item) => item.id !== row.id))
            }
          >
            {row.removed ? "撤销移除" : "移除"}
          </button>
        </div>
      ))}
      {!!rows.length && !visibleValues && (
        <p className="config-help">
          已有值保留在运行 CodeShell 的设备上；留空保留，填写新值替换，点击“移除”后保存才能删除。
        </p>
      )}
    </div>
  );
}

function ProbeResult({ result }: { result: McpProbeResult }) {
  return (
    <div className={`hub-mcp-probe-result hub-mcp-probe-${result.status}`} role="status">
      <div className="hub-mcp-probe-summary">
        <strong>
          {result.status === "ok"
            ? "测试连接成功"
            : result.status === "cancelled"
              ? "测试已取消"
              : "连接测试失败"}
        </strong>
        <span>
          {new Date(result.checkedAt).toLocaleTimeString()} ·{" "}
          {result.durationMs < 1000
            ? `${result.durationMs} ms`
            : `${(result.durationMs / 1000).toFixed(1)} 秒`}
        </span>
      </div>
      {result.error && <p>{result.error.message}</p>}
      {result.status === "ok" && (
        <>
          <p>
            发现 {result.toolCount ?? 0} 个工具{result.truncated ? "（列表已截取）" : ""}
            。测试连接现已关闭。
          </p>
          {!!result.tools?.length && (
            <details>
              <summary>查看工具列表</summary>
              <ul>
                {result.tools.map((tool, index) => (
                  <li key={`${tool.name}-${index}`}>
                    <div>
                      <code>{tool.name}</code>
                      {!tool.allowed && <span className="config-badge">被工具策略停用</span>}
                    </div>
                    {tool.description && <p>{tool.description}</p>}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
