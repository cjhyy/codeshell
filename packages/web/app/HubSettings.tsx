import React from "react";
import { ApiError } from "./auth.js";
import { HubSkills } from "./HubSkills.js";
import { HubMcp } from "./HubMcp.js";
import {
  connectionDraft,
  configurationErrorMessage,
  readConfiguration,
  saveConnection,
  saveDefaults,
  deleteConnection,
  probeConnection,
  type ModelProbeResult,
  type ConnectionDraft,
  type HubConfiguration,
  type HubConnection,
} from "./configuration.js";
import "./hub-settings.css";

export type HubSettingsSection = "overview" | "models" | "skills" | "mcp";

interface Props {
  host?: "hub" | "desktop";
  section: HubSettingsSection;
  onSectionChange?: (section: HubSettingsSection) => void;
  onAuthLost: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onConfigurationChange?: () => void;
  configurationVersion?: number;
}

type Save = (
  label: string,
  operation: (signal: AbortSignal) => Promise<HubConfiguration>,
) => Promise<boolean>;

const sectionCopy: Record<HubSettingsSection, { title: string; description: string }> = {
  overview: {
    title: "设置",
    description: "管理当前工作区的模型、Skills 和工具连接。",
  },
  models: {
    title: "模型与连接",
    description: "选择默认模型，管理工作区使用的服务商连接与凭据。",
  },
  skills: {
    title: "Skills",
    description: "让 CodeShell 按照你熟悉的工作方式完成任务。",
  },
  mcp: {
    title: "MCP 工具",
    description: "管理工具连接，测试连接并查看可用工具。",
  },
};

/** Browser shell over the same server-side settings and Skill discovery used by the worker. */
export function HubSettings(props: Props) {
  if (props.section === "skills")
    return (
      <HubSkills
        onAuthLost={props.onAuthLost}
        onDirtyChange={props.onDirtyChange}
        onChanged={props.onConfigurationChange}
        configurationVersion={props.configurationVersion}
      />
    );
  return <ConfigurationSettings {...props} />;
}

function ConfigurationSettings({
  host = "hub",
  section,
  onSectionChange,
  onAuthLost,
  onDirtyChange,
  onConfigurationChange,
  configurationVersion = 0,
}: Props) {
  const [configuration, setConfiguration] = React.useState<HubConfiguration | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [notice, setNotice] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [reload, setReload] = React.useState(0);
  const callbacks = React.useRef({ onAuthLost, onConfigurationChange });
  callbacks.current = { onAuthLost, onConfigurationChange };
  const mounted = React.useRef(false);
  const revision = React.useRef(0);
  const readController = React.useRef<AbortController | null>(null);
  const writeController = React.useRef<AbortController | null>(null);
  const refreshQueued = React.useRef(false);
  const previousVersion = React.useRef(configurationVersion);

  const report = React.useCallback((cause: unknown) => {
    if (cause instanceof ApiError && cause.status === 401) callbacks.current.onAuthLost();
    else setError(configurationErrorMessage(cause));
  }, []);

  React.useEffect(() => {
    if (configurationVersion === previousVersion.current) return;
    previousVersion.current = configurationVersion;
    if (writeController.current) refreshQueued.current = true;
    else setReload((value) => value + 1);
  }, [configurationVersion]);

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      writeController.current?.abort();
    };
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    readController.current = controller;
    const currentRevision = ++revision.current;
    setLoading(true);
    setError("");
    void readConfiguration(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted && currentRevision === revision.current) {
          setConfiguration(value);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted && currentRevision === revision.current) report(cause);
      })
      .finally(() => {
        if (!controller.signal.aborted && currentRevision === revision.current) setLoading(false);
      });
    return () => controller.abort();
  }, [reload, report]);

  const save: Save = async (label, operation) => {
    // Fence in-flight refreshes so their old snapshot cannot replace a successful write.
    if (writeController.current) return false;
    readController.current?.abort();
    const currentRevision = ++revision.current;
    const controller = new AbortController();
    writeController.current = controller;
    setLoading(false);
    setBusy(label);
    setError("");
    setNotice("");
    try {
      const value = await operation(controller.signal);
      if (!mounted.current || controller.signal.aborted || currentRevision !== revision.current) {
        return false;
      }
      setConfiguration(value);
      setNotice(
        value.restartRequired ? "设置已保存，重启服务后生效。" : "设置已保存，下次运行任务时生效。",
      );
      callbacks.current.onConfigurationChange?.();
      return true;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) refreshQueued.current = true;
      if (mounted.current && !controller.signal.aborted) report(cause);
      return false;
    } finally {
      if (writeController.current === controller) writeController.current = null;
      if (mounted.current && !controller.signal.aborted) {
        setBusy(null);
        if (refreshQueued.current) {
          refreshQueued.current = false;
          setReload((value) => value + 1);
        }
      }
    }
  };

  const copy = sectionCopy[section];
  return (
    <section className="hub-settings" aria-labelledby="hub-settings-title">
      <div className="hub-settings-heading">
        <div>
          <span className="hub-settings-eyebrow">
            {host === "desktop" ? "桌面工作区" : "服务端工作区"}
          </span>
          <h1 id="hub-settings-title">{copy.title}</h1>
          <p>{copy.description}</p>
        </div>
        <button
          className="config-button config-button-quiet"
          disabled={loading || busy !== null}
          onClick={() => {
            setNotice("");
            setReload((value) => value + 1);
          }}
        >
          {loading ? "读取中…" : "刷新"}
        </button>
      </div>
      {error && (
        <div className="config-message config-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="config-message config-success" role="status">
          {notice}
        </div>
      )}
      {busy && (
        <p className="config-loading" role="status">
          正在保存{busy}…
        </p>
      )}
      {!configuration && loading ? (
        <p className="config-loading" role="status">
          正在读取工作区设置…
        </p>
      ) : null}
      {configuration && (
        <>
          {section === "overview" && (
            <Overview host={host} configuration={configuration} onSectionChange={onSectionChange} />
          )}
          {section === "models" && (
            <Models
              configuration={configuration}
              disabled={busy !== null || loading}
              saving={busy !== null}
              save={save}
              onDirtyChange={onDirtyChange}
              onAuthLost={onAuthLost}
            />
          )}
          {section === "mcp" && (
            <HubMcp
              onAuthLost={onAuthLost}
              onDirtyChange={onDirtyChange}
              onConfigurationChange={onConfigurationChange}
              configurationVersion={configurationVersion}
            />
          )}
          <p className="config-scope-note">配置作用于当前工作区，所有连接到这里的设备共用。</p>
        </>
      )}
    </section>
  );
}

function Overview({
  host,
  configuration,
  onSectionChange,
}: {
  host: "hub" | "desktop";
  configuration: HubConfiguration;
  onSectionChange?: Props["onSectionChange"];
}) {
  const current = configuration.connections.find((item) => item.id === configuration.defaults.text);
  const enabledSkills = configuration.skills.filter((skill) => skill.enabled).length;
  const rows: { section: HubSettingsSection; title: string; summary: string; icon: string }[] = [
    {
      section: "models",
      title: "模型与连接",
      summary: current ? `${current.id} · ${current.model}` : "尚未设置默认模型",
      icon: "◈",
    },
    {
      section: "skills",
      title: "Skills",
      summary: `${configuration.skills.length} 个可用 · ${enabledSkills} 个已启用`,
      icon: "✧",
    },
    {
      section: "mcp",
      title: "MCP 工具",
      summary: `${configuration.mcpServers.length} 个已配置的工具服务`,
      icon: "⌘",
    },
  ];
  return (
    <>
      <div className="config-workspace-card">
        <span className="config-workspace-icon" aria-hidden="true">
          ▱
        </span>
        <div>
          <strong>当前工作区</strong>
          <code>{configuration.workspace.path}</code>
          <p>
            {host === "desktop"
              ? "对话、文件操作和工具都由已连接的桌面端执行。"
              : "对话、文件操作和工具都在服务端运行。"}
          </p>
        </div>
        <span className="config-badge">{host === "desktop" ? "桌面工作区" : "服务端工作区"}</span>
      </div>
      <h2 className="config-section-title">工作区配置</h2>
      <div className="config-card config-overview-list">
        {rows.map((row) => {
          const content = (
            <>
              <span className="config-row-icon" aria-hidden="true">
                {row.icon}
              </span>
              <span className="config-row-copy">
                <strong>{row.title}</strong>
                <span>{row.summary}</span>
              </span>
              {onSectionChange && (
                <span className="config-chevron" aria-hidden="true">
                  ›
                </span>
              )}
            </>
          );
          return onSectionChange ? (
            <button
              className="config-overview-row"
              key={row.section}
              onClick={() => onSectionChange(row.section)}
            >
              {content}
            </button>
          ) : (
            <div className="config-overview-row" key={row.section}>
              {content}
            </div>
          );
        })}
      </div>
      <div className="config-explanation">
        <h2>工作区与执行位置</h2>
        <p>
          {host === "desktop"
            ? "这里直接使用桌面端的任务、模型、Skills 和工具连接。修改配置后，桌面窗口和已配对的网页共同使用。"
            : "这里使用服务端的任务、模型、Skills 和工具连接。修改配置后，连接到这个服务端的网页共同使用。"}
        </p>
        <p>
          {host === "desktop"
            ? "切换项目会切换对应的文件、历史和工作区设置；无需复制桌面配置。"
            : "独立部署使用自己的运行环境。部署到另一台机器时，需要迁移配置和数据，或在这里重新设置。"}
        </p>
      </div>
    </>
  );
}

function Models({
  configuration,
  disabled,
  saving,
  save,
  onDirtyChange,
  onAuthLost,
}: {
  configuration: HubConfiguration;
  disabled: boolean;
  saving: boolean;
  save: Save;
  onDirtyChange?: (dirty: boolean) => void;
  onAuthLost: () => void;
}) {
  const [editing, setEditing] = React.useState<HubConnection | "__new__" | null>(null);
  const [removing, setRemoving] = React.useState<HubConnection | null>(null);
  const [replacement, setReplacement] = React.useState("");
  const [editorDirty, setEditorDirty] = React.useState(false);
  const [defaultsDirty, setDefaultsDirty] = React.useState(false);
  const [probing, setProbing] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, ModelProbeResult | string>>({});
  const probe = React.useRef<AbortController | null>(null);
  const connections = configuration.connections.filter((item) => item.tag === "text");
  const otherCount = configuration.connections.length - connections.length;
  const blocked = disabled || !!probing;
  React.useEffect(() => {
    if (removing && !configuration.connections.some((item) => item.id === removing.id))
      setRemoving(null);
  }, [configuration.connections, removing]);
  React.useEffect(() => () => probe.current?.abort(), []);
  const previousConnections = React.useRef(new Map<string, string>());
  React.useEffect(() => {
    const next = new Map(
      configuration.connections.map((item) => [item.id, item.revision ?? JSON.stringify(item)]),
    );
    const changed = new Set(
      [...previousConnections.current]
        .filter(([id, revision]) => next.get(id) !== revision)
        .map(([id]) => id),
    );
    previousConnections.current = next;
    if (probing && changed.has(probing)) probe.current?.abort();
    if (changed.size)
      setResults((current) =>
        Object.fromEntries(Object.entries(current).filter(([id]) => !changed.has(id))),
      );
  }, [configuration, probing]);

  React.useEffect(() => {
    onDirtyChange?.(editorDirty || defaultsDirty || saving || !!probing);
    return () => onDirtyChange?.(false);
  }, [editorDirty, defaultsDirty, saving, probing, onDirtyChange]);
  const test = async (connection: HubConnection) => {
    if (probe.current) return;
    const controller = new AbortController();
    probe.current = controller;
    setProbing(connection.id);
    setResults((current) => ({ ...current, [connection.id]: "正在发送一条简短测试请求…" }));
    try {
      const result = await probeConnection(connection.id, controller.signal);
      if (!controller.signal.aborted)
        setResults((current) => ({ ...current, [connection.id]: result }));
    } catch (cause) {
      if (!controller.signal.aborted) {
        if (cause instanceof ApiError && cause.status === 401) onAuthLost();
        else
          setResults((current) => ({
            ...current,
            [connection.id]: configurationErrorMessage(cause),
          }));
      }
    } finally {
      if (probe.current === controller) {
        probe.current = null;
        setProbing(null);
      }
    }
  };
  return (
    <>
      <DefaultModels
        configuration={configuration}
        disabled={blocked}
        save={save}
        onDirtyChange={setDefaultsDirty}
      />
      <div className="config-section-heading">
        <h2>
          文字模型连接 <span className="config-count">{connections.length}</span>
        </h2>
        <button
          className="config-button"
          disabled={
            blocked || editing !== null || removing !== null || !configuration.catalog.length
          }
          onClick={() => setEditing("__new__")}
        >
          <span aria-hidden="true">＋</span> 添加连接
        </button>
      </div>
      {editing !== null && (
        <div className="config-card config-editor-card">
          <h3>{editing === "__new__" ? "添加模型连接" : `编辑 ${editing.id}`}</h3>
          <ConnectionEditor
            key={editing === "__new__" ? "new" : editing.id}
            connection={editing === "__new__" ? undefined : editing}
            configuration={configuration}
            disabled={blocked}
            save={save}
            onDone={() => setEditing(null)}
            onDirtyChange={setEditorDirty}
          />
        </div>
      )}
      {!connections.length && editing !== "__new__" && (
        <Empty
          title="还没有文字模型连接"
          description="添加服务商地址、模型名称和 API Key，再选择一个默认模型。"
        />
      )}
      <div className="config-connection-list">
        {connections.map((connection) => {
          const provider = configuration.catalog.find((item) => item.id === connection.catalogId);
          const isRemoving = removing?.id === connection.id;
          const removalChanged = isRemoving && removing?.revision !== connection.revision;
          const replacementNeeded =
            configuration.defaults.text === connection.id && connections.length > 1;
          const probeResult = results[connection.id];
          return (
            <article className="config-card config-connection-card" key={connection.id}>
              <div className="config-connection-head">
                <span className="config-model-icon" aria-hidden="true">
                  ◈
                </span>
                <div className="config-row-copy">
                  <strong>{connection.id}</strong>
                  <span>{provider?.displayName ?? connection.catalogId}</span>
                </div>
                {configuration.defaults.text === connection.id && (
                  <span className="config-badge config-badge-accent">默认</span>
                )}
                <button
                  className="config-button config-button-quiet"
                  disabled={blocked || editing !== null || removing !== null}
                  onClick={() => setEditing(connection)}
                >
                  编辑
                </button>
              </div>
              <dl className="config-connection-facts">
                <div>
                  <dt>模型</dt>
                  <dd>{connection.model || "未填写"}</dd>
                </div>
                <div>
                  <dt>服务地址</dt>
                  <dd>{connection.baseUrl || provider?.defaultBaseUrl || "服务商默认地址"}</dd>
                </div>
                <div>
                  <dt>API Key</dt>
                  <dd>
                    {connection.hasApiKey
                      ? "•••••••• · 已配置"
                      : connection.needsKey
                        ? "未配置"
                        : "无需 API Key"}
                  </dd>
                </div>
              </dl>
              <div className="config-model-actions">
                {probing === connection.id ? (
                  <button
                    className="config-button"
                    onClick={() => {
                      probe.current?.abort();
                      setResults((current) => ({
                        ...current,
                        [connection.id]: "已取消连接测试。",
                      }));
                    }}
                  >
                    取消测试
                  </button>
                ) : (
                  <button
                    className="config-button"
                    disabled={blocked || editing !== null || removing !== null}
                    onClick={() => void test(connection)}
                  >
                    测试连接
                  </button>
                )}
                <span className="config-help">发送一条简短请求，服务商可能计费。</span>
                <button
                  className="config-button config-button-quiet config-remove-connection"
                  disabled={blocked || editing !== null || removing !== null}
                  onClick={() => {
                    setRemoving(connection);
                    setReplacement("");
                  }}
                >
                  删除
                </button>
              </div>
              {probeResult && (
                <div
                  className={`config-probe-result ${typeof probeResult !== "string" && probeResult.ok ? "is-success" : ""}`}
                  role="status"
                >
                  <span>{typeof probeResult === "string" ? probeResult : probeResult.message}</span>
                  {typeof probeResult !== "string" && (
                    <small>
                      {Math.max(0.01, probeResult.latencyMs / 1000).toFixed(2)} 秒 ·{" "}
                      {new Date(probeResult.checkedAt).toLocaleTimeString()}
                    </small>
                  )}
                </div>
              )}
              {isRemoving && (
                <div className="config-remove-confirm">
                  <h3>删除连接 {connection.id}？</h3>
                  <p>连接会从当前工作区移除，已有对话记录会保留。</p>
                  {removalChanged && (
                    <p role="alert">连接已被其他设备更新，请取消后重新检查再删除。</p>
                  )}
                  {connections.length === 1 && (
                    <p>这是最后一个文字模型连接。删除后需重新添加连接才能继续对话。</p>
                  )}
                  {replacementNeeded && (
                    <label>
                      <span>替代默认模型</span>
                      <select
                        aria-label="替代默认模型"
                        value={replacement}
                        onChange={(event) => setReplacement(event.target.value)}
                        disabled={blocked}
                      >
                        <option value="">请选择其他连接</option>
                        {connections
                          .filter((item) => item.id !== connection.id)
                          .map((item) => (
                            <option value={item.id} key={item.id}>
                              {item.id} · {item.model}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <div className="config-form-actions">
                    <button
                      className="config-button"
                      disabled={blocked}
                      onClick={() => setRemoving(null)}
                    >
                      取消删除
                    </button>
                    <button
                      className="config-button config-button-danger"
                      disabled={blocked || removalChanged || (replacementNeeded && !replacement)}
                      onClick={() =>
                        void save("删除连接", (signal) =>
                          deleteConnection(
                            connection.id,
                            replacement || undefined,
                            signal,
                            removing?.revision,
                          ),
                        ).then((ok) => {
                          if (ok) setRemoving(null);
                        })
                      }
                    >
                      确认删除连接
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {otherCount > 0 && (
        <p className="config-help">
          另有 {otherCount} 个其他类型的模型连接，保留在工作区配置中。目前此处提供文字模型编辑。
        </p>
      )}
    </>
  );
}

function DefaultModels({
  configuration,
  disabled,
  save,
  onDirtyChange,
}: {
  configuration: HubConfiguration;
  disabled: boolean;
  save: Save;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [text, setText] = React.useState(configuration.defaults.text ?? "");
  const [auxText, setAuxText] = React.useState(configuration.defaults.auxText ?? "");
  const previousDefaults = React.useRef(configuration.defaults);
  React.useEffect(() => {
    const previous = previousDefaults.current;
    previousDefaults.current = configuration.defaults;
    // An external refresh updates saved values without discarding edits made in this form.
    setText((value) =>
      value === (previous.text ?? "") ? (configuration.defaults.text ?? "") : value,
    );
    setAuxText((value) =>
      value === (previous.auxText ?? "") ? (configuration.defaults.auxText ?? "") : value,
    );
  }, [configuration.defaults]);
  const connections = configuration.connections.filter((item) => item.tag === "text");
  const changed =
    text !== (configuration.defaults.text ?? "") ||
    auxText !== (configuration.defaults.auxText ?? "");
  React.useEffect(() => {
    onDirtyChange(changed);
    return () => onDirtyChange(false);
  }, [changed, onDirtyChange]);
  return (
    <form
      className="config-card config-defaults"
      onSubmit={(event) => {
        event.preventDefault();
        void save("默认模型", (signal) => saveDefaults({ text, auxText: auxText || null }, signal));
      }}
    >
      <fieldset disabled={disabled || !connections.length}>
        <legend>默认模型</legend>
        <div className="config-form-grid">
          <label>
            <span>对话模型</span>
            <select
              required
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-label="默认对话模型"
            >
              <option value="" disabled>
                选择模型连接
              </option>
              {text && !connections.some((item) => item.id === text) && (
                <option value={text} disabled>
                  {text}（连接不可用）
                </option>
              )}
              {connections.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.id} · {item.model}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>辅助模型</span>
            <select
              value={auxText}
              onChange={(event) => setAuxText(event.target.value)}
              aria-label="默认辅助模型"
            >
              <option value="">跟随对话模型</option>
              {auxText && !connections.some((item) => item.id === auxText) && (
                <option value={auxText} disabled>
                  {auxText}（连接不可用）
                </option>
              )}
              {connections.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.id} · {item.model}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="config-form-footer">
          <p className="config-help">辅助模型用于标题生成等轻量任务。</p>
          <button className="config-button" disabled={!changed || !text} type="submit">
            保存默认模型
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function ConnectionEditor({
  connection,
  configuration,
  disabled,
  save,
  onDone,
  onDirtyChange,
}: {
  connection?: HubConnection;
  configuration: HubConfiguration;
  disabled: boolean;
  save: Save;
  onDone: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = React.useState<ConnectionDraft>(() => {
    const value = connectionDraft(connection);
    if (!connection) value.catalogId = configuration.catalog[0]?.id ?? "";
    return value;
  });
  const initialDraft = React.useRef(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft.current);
  const [discardAsked, setDiscardAsked] = React.useState(false);
  const latest = connection
    ? configuration.connections.find((item) => item.id === connection.id)
    : undefined;
  const outdated = !!connection && (!latest || draft.expectedRevision !== latest.revision);
  React.useEffect(() => {
    if (!dirty && latest && draft.expectedRevision !== latest.revision) {
      const next = connectionDraft(latest);
      initialDraft.current = next;
      setDraft(next);
    }
  }, [dirty, latest, draft.expectedRevision]);
  const loadLatest = () => {
    if (!latest) return;
    const next = connectionDraft(latest);
    initialDraft.current = next;
    setDraft(next);
    setDiscardAsked(false);
  };
  React.useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const provider = configuration.catalog.find((item) => item.id === draft.catalogId);
  const duplicateId =
    !connection && configuration.connections.some((item) => item.id === draft.id.trim());
  const patch = (field: keyof ConnectionDraft, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));
  return (
    <form
      className="config-connection-editor"
      onSubmit={async (event) => {
        event.preventDefault();
        if (outdated) return;
        if (await save("模型连接", (signal) => saveConnection(draft, signal))) onDone();
      }}
    >
      <fieldset disabled={disabled}>
        <legend className="config-sr-only">
          {connection ? `编辑 ${connection.id}` : "新模型连接"}
        </legend>
        {outdated && (
          <div className="config-remove-confirm" role="alert">
            <p>
              {latest
                ? "其他设备已更新这个连接。你的草稿已保留，请检查最新设置后再保存。"
                : "这个连接已被其他设备删除。草稿仍保留，你可以复制内容后关闭编辑。"}
            </p>
            {latest && (
              <button className="config-button" type="button" onClick={loadLatest}>
                放弃草稿并载入最新设置
              </button>
            )}
          </div>
        )}
        <div className="config-form-grid">
          <label>
            <span>连接名称</span>
            <input
              required
              maxLength={120}
              value={draft.id}
              readOnly={!!connection}
              onChange={(event) => patch("id", event.target.value)}
              placeholder="例如 work-model"
              autoComplete="off"
            />
          </label>
          <label>
            <span>服务商</span>
            <select
              required
              disabled={!!connection}
              aria-label="服务商"
              value={draft.catalogId}
              onChange={(event) => patch("catalogId", event.target.value)}
            >
              {connection && !provider && (
                <option value={draft.catalogId}>{draft.catalogId}</option>
              )}
              {configuration.catalog.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="config-full-width">
            <span>模型名称</span>
            <input
              required
              maxLength={240}
              value={draft.model}
              onChange={(event) => patch("model", event.target.value)}
              placeholder="服务商提供的模型 ID"
              autoComplete="off"
            />
          </label>
          <label className="config-full-width">
            <span>服务地址</span>
            <input
              type="url"
              aria-label="服务地址"
              value={draft.baseUrl}
              onChange={(event) => patch("baseUrl", event.target.value)}
              placeholder={provider?.defaultBaseUrl || "使用服务商默认地址"}
              autoComplete="off"
            />
            <small>留空使用服务商默认地址，支持兼容接口。</small>
          </label>
          <label className="config-full-width">
            <span>
              API Key {connection?.hasApiKey && <span className="config-field-meta">已配置</span>}
            </span>
            <input
              type="password"
              aria-label="API Key"
              required={provider?.needsKey && !connection?.hasApiKey}
              value={draft.apiKey}
              onChange={(event) => patch("apiKey", event.target.value)}
              placeholder={
                connection?.hasApiKey
                  ? "留空保留现有 API Key"
                  : provider?.needsKey
                    ? "输入 API Key"
                    : "可选"
              }
              autoComplete="new-password"
              spellCheck={false}
            />
            <small>
              {connection?.hasApiKey
                ? "现有密钥保留在运行 CodeShell 的设备上，输入新值可替换。"
                : "密钥保存在当前工作区配置中。"}
            </small>
          </label>
        </div>
        {duplicateId && (
          <p className="config-error config-message" role="alert">
            连接名称已存在，请使用其他名称或编辑现有连接。
          </p>
        )}
        <p className="config-help">保存后可在连接卡片中测试实际连接。</p>
        {discardAsked && (
          <div className="config-remove-confirm" role="alert">
            <p>还有未保存的修改，确定放弃？</p>
            <div className="config-form-actions">
              <button
                type="button"
                className="config-button"
                onClick={() => setDiscardAsked(false)}
              >
                继续编辑
              </button>
              <button type="button" className="config-button config-button-danger" onClick={onDone}>
                放弃修改
              </button>
            </div>
          </div>
        )}
        <div className="config-form-actions">
          <button
            type="button"
            className="config-button config-button-quiet"
            onClick={() => (dirty ? setDiscardAsked(true) : onDone())}
          >
            取消
          </button>
          <button
            type="submit"
            className="config-button config-button-primary"
            disabled={duplicateId || outdated}
          >
            保存连接
          </button>
        </div>
      </fieldset>
    </form>
  );
}

function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="config-empty">
      <span aria-hidden="true">◇</span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
