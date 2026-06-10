import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageProbeResult } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { Button } from "@/components/ui/button";

/** Probe result shape (reused from image probe; video has no probe → unused). */
export type ProbeResult = ImageProbeResult;

export interface ProviderMeta {
  /** Instance id stored in <settingsKey>.providers[].id. v1: one instance per kind. */
  id: string;
  kind: string;
  displayName: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  signupUrl?: string;
  /** Suggested model ids for the "默认模型" field (datalist — still free-type). */
  modelPresets?: Array<{ value: string; label?: string }>;
  /** Placeholder card: rendered greyed-out, all inputs/buttons disabled. */
  disabled?: boolean;
  /** Coming-soon note shown on a disabled card. */
  comingSoonNote?: string;
}

export interface GenPanelConfig {
  /** settings.<settingsKey>.providers[] */
  settingsKey: "imageGen" | "videoGen";
  providers: ProviderMeta[];
  /** Render the "test" button + probe UI (image) vs not (video). */
  showTest: boolean;
  /** Probe function used when showTest; required if showTest. */
  testFn?: (input: { kind: string; apiKey?: string; baseUrl?: string; model?: string }) => Promise<ProbeResult>;
  labels: {
    testIdle: string;   // e.g. "测试生图"
    testBusy: string;   // e.g. "生成中…"
    testTitleConfigured: string; // tooltip when configured
    keyHint: string;    // field hint under API key
  };
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
  config: GenPanelConfig;
}

interface ProviderState {
  apiKey: string;
  baseUrl: string;
  model: string;
  probe?: ProbeResult;
  testing: boolean;
  saving: boolean;
  showKey: boolean;
  dirty: boolean;
}

const initialState = (meta: ProviderMeta): ProviderState => ({
  apiKey: "",
  baseUrl: meta.defaultBaseUrl,
  model: meta.defaultModel,
  testing: false,
  saving: false,
  showKey: false,
  dirty: false,
});

function isProbeResult(value: unknown): value is ProbeResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.status === "ok" || rec.status === "error" || rec.status === "unconfigured") &&
    typeof rec.lastProbedAt === "string"
  );
}

export function GenConnectionsPanel({ scope, activeRepoPath, config }: Props) {
  const { settingsKey, providers, showTest, testFn, labels } = config;
  const firstConfigurable = providers.find((p) => !p.disabled) ?? providers[0];
  const [defaultProvider, setDefaultProvider] = useState<string>(firstConfigurable?.id ?? "");
  const buildInitial = useCallback((): Record<string, ProviderState> => {
    const m: Record<string, ProviderState> = {};
    for (const meta of providers) m[meta.id] = initialState(meta);
    return m;
  }, [providers]);
  const [byProvider, setByProvider] = useState<Record<string, ProviderState>>(buildInitial);
  const [loaded, setLoaded] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = useCallback(async () => {
    const s = ((await window.codeshell.getSettings(scope, cwd)) ?? {}) as Record<string, unknown>;
    const gen = (s[settingsKey] && typeof s[settingsKey] === "object") ? (s[settingsKey] as Record<string, unknown>) : {};
    const list = Array.isArray(gen.providers) ? (gen.providers as Array<Record<string, unknown>>) : [];

    const next = buildInitial();
    for (const meta of providers) {
      if (meta.disabled) continue;
      const entry = list.find((p) => p.id === meta.id || (p.kind === meta.kind && !p.id));
      if (entry) {
        next[meta.id] = {
          ...next[meta.id],
          apiKey: typeof entry.apiKey === "string" ? entry.apiKey : "",
          baseUrl: typeof entry.baseUrl === "string" && entry.baseUrl ? entry.baseUrl : meta.defaultBaseUrl,
          model: typeof entry.defaultModel === "string" && entry.defaultModel ? entry.defaultModel : meta.defaultModel,
          probe: isProbeResult(entry.lastProbe) ? entry.lastProbe : undefined,
        };
      }
    }
    const dp = typeof gen.defaultProvider === "string" ? gen.defaultProvider : undefined;
    if (dp && providers.some((p) => p.id === dp && !p.disabled)) setDefaultProvider(dp);

    setByProvider(next);
    setLoaded(true);
  }, [scope, cwd, settingsKey, providers, buildInitial]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (id: string, patch: Partial<ProviderState>) => {
    setByProvider((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  };

  const writeBack = useCallback(
    async (next: Record<string, ProviderState>, nextDefault: string) => {
      const providersOut: Array<Record<string, unknown>> = [];
      for (const meta of providers) {
        if (meta.disabled) continue;
        const st = next[meta.id];
        if (!st.apiKey) continue;
        const entry: Record<string, unknown> = {
          id: meta.id,
          kind: meta.kind,
          baseUrl: st.baseUrl || meta.defaultBaseUrl,
          apiKey: st.apiKey,
          defaultModel: st.model || meta.defaultModel,
        };
        if (st.probe) entry.lastProbe = st.probe;
        providersOut.push(entry);
      }
      await writeSettings(scope, { [settingsKey]: { defaultProvider: nextDefault, providers: providersOut } }, cwd);
    },
    [scope, cwd, settingsKey, providers],
  );

  const save = async (id: string) => {
    update(id, { saving: true });
    try {
      const next = { ...byProvider, [id]: { ...byProvider[id], saving: false, dirty: false } };
      await writeBack(next, defaultProvider);
      setByProvider(next);
    } catch (err) {
      console.error(`${settingsKey} save failed`, err);
      update(id, { saving: false });
    }
  };

  const clear = async (id: string) => {
    const meta = providers.find((p) => p.id === id)!;
    const next = { ...byProvider, [id]: initialState(meta) };
    setByProvider(next);
    try {
      await writeBack(next, defaultProvider);
    } catch (err) {
      console.error(`${settingsKey} clear failed`, err);
      void load();
    }
  };

  const test = async (id: string) => {
    if (!showTest || !testFn) return;
    const meta = providers.find((p) => p.id === id)!;
    const st = byProvider[id];
    update(id, { testing: true });
    try {
      const result = await testFn({
        kind: meta.kind,
        apiKey: st.apiKey || undefined,
        baseUrl: st.baseUrl || undefined,
        model: st.model || undefined,
      });
      const next = { ...byProvider, [id]: { ...byProvider[id], probe: result, testing: false } };
      setByProvider(next);
      if (result.status === "ok") await writeBack(next, defaultProvider);
    } catch (e) {
      update(id, {
        probe: {
          status: "error",
          errorMessage: String(e instanceof Error ? e.message : e),
          lastProbedAt: new Date().toISOString(),
        },
        testing: false,
      });
    }
  };

  const setDefault = async (id: string) => {
    setDefaultProvider(id);
    await writeBack(byProvider, id);
  };

  if (!loaded) {
    return <div className="connections-card-grid"><div className="view-loading">加载中…</div></div>;
  }

  return (
    <div className="connections-card-grid">
      {providers.map((meta) => {
        const st = byProvider[meta.id];
        const isDefault = defaultProvider === meta.id;
        const isConfigured = !!st.apiKey;
        return (
          <GenCard
            key={meta.id}
            meta={meta}
            state={st}
            isDefault={isDefault}
            isConfigured={isConfigured}
            showTest={showTest}
            labels={labels}
            onConfigChange={(patch) => update(meta.id, { ...patch, dirty: true, probe: undefined })}
            onUiChange={(patch) => update(meta.id, patch)}
            onSave={() => void save(meta.id)}
            onTest={() => void test(meta.id)}
            onClear={() => void clear(meta.id)}
            onSetDefault={() => void setDefault(meta.id)}
          />
        );
      })}
    </div>
  );
}

interface CardProps {
  meta: ProviderMeta;
  state: ProviderState;
  isDefault: boolean;
  isConfigured: boolean;
  showTest: boolean;
  labels: GenPanelConfig["labels"];
  onConfigChange: (patch: Partial<ProviderState>) => void;
  onUiChange: (patch: Partial<ProviderState>) => void;
  onSave: () => void;
  onTest: () => void;
  onClear: () => void;
  onSetDefault: () => void;
}

function GenCard({
  meta, state, isDefault, isConfigured, showTest, labels,
  onConfigChange, onUiChange, onSave, onTest, onClear, onSetDefault,
}: CardProps) {
  const disabled = !!meta.disabled;
  const statusPill = useMemo(() => {
    if (disabled) return <span className="conn-pill unknown">即将支持</span>;
    if (showTest && state.testing) return <span className="conn-pill probing">生成测试中…</span>;
    if (showTest && state.probe?.status === "ok") return <span className="conn-pill ok">可用</span>;
    if (showTest && state.probe?.status === "error") return <span className="conn-pill err">生成失败</span>;
    if (!isConfigured) return <span className="conn-pill unknown">未配置</span>;
    return <span className="conn-pill unknown">已配置</span>;
  }, [disabled, showTest, state.testing, state.probe, isConfigured]);

  if (disabled) {
    return (
      <article className="conn-card" style={{ opacity: 0.6 }}>
        <header className="conn-card-head">
          <div className="conn-card-title">
            <strong>{meta.displayName}</strong>
            {statusPill}
          </div>
        </header>
        <p className="conn-card-desc">{meta.comingSoonNote ?? meta.description}</p>
      </article>
    );
  }

  return (
    <article className={`conn-card${isDefault ? " is-default" : ""}`}>
      <header className="conn-card-head">
        <div className="conn-card-title">
          <strong>{meta.displayName}</strong>
          {isDefault && <span className="conn-default-pill">默认</span>}
          {statusPill}
        </div>
        <div className="conn-card-head-actions">
          {meta.signupUrl && (
            <button className="conn-link-btn" onClick={() => void window.codeshell.openExternal(meta.signupUrl!)}>
              获取 key
            </button>
          )}
        </div>
      </header>

      <p className="conn-card-desc">{meta.description}</p>

      <div className="settings-form-grid">
        <label className="settings-field">
          <span>API Key</span>
          <div className="conn-secret-row">
            <input
              type={state.showKey ? "text" : "password"}
              value={state.apiKey}
              onChange={(e) => onConfigChange({ apiKey: e.target.value.trim() })}
              placeholder="粘贴 API key"
            />
            <button className="conn-secret-toggle" type="button" onClick={() => onUiChange({ showKey: !state.showKey })}>
              {state.showKey ? "隐藏" : "显示"}
            </button>
          </div>
          <span className="conn-field-hint">{labels.keyHint}</span>
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input
            value={state.baseUrl}
            onChange={(e) => onConfigChange({ baseUrl: e.target.value.trim() })}
            placeholder={meta.defaultBaseUrl}
          />
        </label>
        <label className="settings-field">
          <span>默认模型</span>
          <input
            value={state.model}
            onChange={(e) => onConfigChange({ model: e.target.value.trim() })}
            placeholder={meta.defaultModel}
            list={meta.modelPresets?.length ? `${meta.id}-model-presets` : undefined}
          />
          {meta.modelPresets?.length ? (
            <datalist id={`${meta.id}-model-presets`}>
              {meta.modelPresets.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label ?? p.value}
                </option>
              ))}
            </datalist>
          ) : null}
        </label>
      </div>

      {showTest && state.probe?.status === "ok" && state.probe.previewDataUrl && (
        <div className="conn-probe-image">
          <div className="conn-probe-title">测试生成成功</div>
          <img src={state.probe.previewDataUrl} alt="probe preview" />
        </div>
      )}
      {showTest && state.probe?.status === "error" && <div className="conn-probe-err">{state.probe.errorMessage}</div>}

      <footer className="conn-card-footer">
        {showTest && (
          <Button variant="default" onClick={onTest} disabled={state.testing || !isConfigured} title={isConfigured ? labels.testTitleConfigured : "请先填写 API key"}>
            {state.testing ? labels.testBusy : labels.testIdle}
          </Button>
        )}
        <Button variant="solid" onClick={onSave} disabled={state.saving || !state.dirty}>
          {state.saving ? "保存中…" : "保存"}
        </Button>
        {isConfigured && !isDefault && (
          <Button variant="default" onClick={onSetDefault}>
            设为默认
          </Button>
        )}
        {isConfigured && (
          <Button variant="destructive" onClick={onClear}>
            清除
          </Button>
        )}
      </footer>
    </article>
  );
}
