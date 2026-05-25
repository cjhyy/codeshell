import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { SearchProbeInput, SearchProbeResult } from "../../preload/types";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

type Provider = "serper" | "tavily" | "searxng";

interface ProviderMeta {
  id: Provider;
  displayName: string;
  description: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  signupUrl?: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "serper",
    displayName: "Google Web Search (Serper)",
    description: "Google 搜索结果代理，最常用。需要在 serper.dev 申请 API key。",
    needsKey: true,
    needsBaseUrl: false,
    signupUrl: "https://serper.dev",
  },
  {
    id: "tavily",
    displayName: "Tavily AI Search",
    description: "针对 AI 工作流优化的搜索接口，免费额度较友好。",
    needsKey: true,
    needsBaseUrl: false,
    signupUrl: "https://tavily.com",
  },
  {
    id: "searxng",
    displayName: "SearXNG（自建）",
    description: "开源元搜索引擎，自部署。提供 Base URL 即可，不需要 API key。",
    needsKey: false,
    needsBaseUrl: true,
  },
];

interface ProviderState {
  apiKey: string;
  baseUrl: string;
  probe?: SearchProbeResult;
  testing: boolean;
  saving: boolean;
  showKey: boolean;
  dirty: boolean;
}

const initialProviderState = (): ProviderState => ({
  apiKey: "",
  baseUrl: "",
  testing: false,
  saving: false,
  showKey: false,
  dirty: false,
});

export function SearchConnectionsPanel({ scope, activeRepoPath }: Props) {
  const [defaultProvider, setDefaultProvider] = useState<Provider>("serper");
  const [byProvider, setByProvider] = useState<Record<Provider, ProviderState>>(() => ({
    serper: initialProviderState(),
    tavily: initialProviderState(),
    searxng: initialProviderState(),
  }));
  const [loaded, setLoaded] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = useCallback(async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const search = (s.search && typeof s.search === "object") ? (s.search as Record<string, unknown>) : {};
    // Legacy schema stored a single { provider, apiKey, baseUrl }. We migrate
    // by stamping its values onto the matching provider card; nothing is lost.
    const legacyProvider = typeof search.provider === "string" ? search.provider : "serper";
    const legacyKey = typeof search.apiKey === "string" ? search.apiKey : "";
    const legacyBaseUrl = typeof search.baseUrl === "string" ? search.baseUrl : "";

    const providersBag = (search.providers && typeof search.providers === "object")
      ? (search.providers as Record<string, Record<string, unknown>>)
      : {};

    const next: Record<Provider, ProviderState> = {
      serper: initialProviderState(),
      tavily: initialProviderState(),
      searxng: initialProviderState(),
    };
    for (const p of PROVIDERS) {
      const bag = providersBag[p.id] ?? {};
      next[p.id] = {
        ...next[p.id],
        apiKey: typeof bag.apiKey === "string" ? bag.apiKey : "",
        baseUrl: typeof bag.baseUrl === "string" ? bag.baseUrl : "",
      };
    }

    // Apply legacy fallback to whatever provider the legacy slot named.
    if (legacyProvider === "serper" || legacyProvider === "tavily" || legacyProvider === "searxng") {
      const cur = next[legacyProvider];
      if (!cur.apiKey && legacyKey) cur.apiKey = legacyKey;
      if (!cur.baseUrl && legacyBaseUrl) cur.baseUrl = legacyBaseUrl;
      setDefaultProvider(legacyProvider);
    }

    setByProvider(next);
    setLoaded(true);
  }, [scope, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateProvider = (id: Provider, patch: Partial<ProviderState>) => {
    setByProvider((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  };

  const writeBack = useCallback(
    async (nextProviders: Record<Provider, ProviderState>, nextDefault: Provider) => {
      const providersOut: Record<string, Record<string, string>> = {};
      for (const p of PROVIDERS) {
        const st = nextProviders[p.id];
        const bag: Record<string, string> = {};
        if (st.apiKey) bag.apiKey = st.apiKey;
        if (st.baseUrl) bag.baseUrl = st.baseUrl;
        if (Object.keys(bag).length > 0) providersOut[p.id] = bag;
      }
      const active = nextProviders[nextDefault];
      await window.codeshell.updateSettings(
        scope,
        {
          search: {
            provider: nextDefault,
            apiKey: active.apiKey || undefined,
            baseUrl: active.baseUrl || undefined,
            providers: providersOut,
          },
        },
        cwd,
      );
    },
    [scope, cwd],
  );

  const saveProvider = async (id: Provider) => {
    updateProvider(id, { saving: true });
    try {
      const next = {
        ...byProvider,
        [id]: { ...byProvider[id], saving: false, dirty: false },
      };
      await writeBack(next, defaultProvider);
      setByProvider(next);
    } catch {
      updateProvider(id, { saving: false });
    }
  };

  const clearProvider = async (id: Provider) => {
    const next = {
      ...byProvider,
      [id]: { ...initialProviderState() },
    };
    setByProvider(next);
    await writeBack(next, defaultProvider);
  };

  const testProvider = async (id: Provider) => {
    const st = byProvider[id];
    updateProvider(id, { testing: true });
    const input: SearchProbeInput = {
      provider: id,
      apiKey: st.apiKey || undefined,
      baseUrl: st.baseUrl || undefined,
    };
    try {
      const result = await window.codeshell.probeSearch(input);
      updateProvider(id, { probe: result, testing: false });
    } catch (e) {
      updateProvider(id, {
        probe: {
          status: "error",
          errorMessage: String(e instanceof Error ? e.message : e),
          lastProbedAt: new Date().toISOString(),
        },
        testing: false,
      });
    }
  };

  const setDefault = async (id: Provider) => {
    setDefaultProvider(id);
    await writeBack(byProvider, id);
  };

  if (!loaded) {
    return (
      <section className="settings-section">
        <h3 className="settings-section-title">连接</h3>
        <div className="view-loading">加载中…</div>
      </section>
    );
  }

  return (
    <section className="settings-section">
      <header className="connections-head">
        <h3 className="settings-section-title">搜索连接</h3>
        <span className="connections-hint">
          这些连接让代理能调用 WebSearch 工具。默认 provider 决定调用哪一个。
        </span>
      </header>

      <div className="connections-card-list">
        {PROVIDERS.map((meta) => {
          const st = byProvider[meta.id];
          const isDefault = defaultProvider === meta.id;
          const isConfigured = meta.needsKey ? !!st.apiKey : !!st.baseUrl;
          return (
            <ConnectionCard
              key={meta.id}
              meta={meta}
              state={st}
              isDefault={isDefault}
              isConfigured={isConfigured}
              onChange={(patch) => updateProvider(meta.id, { ...patch, dirty: true })}
              onSave={() => void saveProvider(meta.id)}
              onTest={() => void testProvider(meta.id)}
              onClear={() => void clearProvider(meta.id)}
              onSetDefault={() => void setDefault(meta.id)}
            />
          );
        })}
      </div>
    </section>
  );
}

interface CardProps {
  meta: ProviderMeta;
  state: ProviderState;
  isDefault: boolean;
  isConfigured: boolean;
  onChange: (patch: Partial<ProviderState>) => void;
  onSave: () => void;
  onTest: () => void;
  onClear: () => void;
  onSetDefault: () => void;
}

function ConnectionCard({
  meta,
  state,
  isDefault,
  isConfigured,
  onChange,
  onSave,
  onTest,
  onClear,
  onSetDefault,
}: CardProps) {
  const statusPill = useMemo(() => {
    if (state.testing) return <span className="conn-pill probing">测试中…</span>;
    if (state.probe?.status === "ok") return <span className="conn-pill ok">可用</span>;
    if (state.probe?.status === "error") return <span className="conn-pill err">连接失败</span>;
    if (state.probe?.status === "unconfigured") return <span className="conn-pill unknown">未配置</span>;
    if (!isConfigured) return <span className="conn-pill unknown">未配置</span>;
    return <span className="conn-pill unknown">未测试</span>;
  }, [state.testing, state.probe, isConfigured]);

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
            <button
              className="conn-link-btn"
              onClick={() => void window.codeshell.openExternal(meta.signupUrl!)}
            >
              获取 key
            </button>
          )}
        </div>
      </header>

      <p className="conn-card-desc">{meta.description}</p>

      <div className="settings-form-grid">
        {meta.needsKey && (
          <label className="settings-field">
            <span>API Key</span>
            <div className="conn-secret-row">
              <input
                type={state.showKey ? "text" : "password"}
                value={state.apiKey}
                onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
                placeholder="粘贴 API key"
              />
              <button
                className="conn-secret-toggle"
                type="button"
                onClick={() => onChange({ showKey: !state.showKey })}
              >
                {state.showKey ? "隐藏" : "显示"}
              </button>
            </div>
            <span className="conn-field-hint">
              保存于 ~/.code-shell/settings.json，按 scope 隔离。
            </span>
          </label>
        )}
        {meta.needsBaseUrl && (
          <label className="settings-field">
            <span>Base URL</span>
            <input
              value={state.baseUrl}
              onChange={(e) => onChange({ baseUrl: e.target.value.trim() })}
              placeholder="https://searxng.example.com"
            />
            <span className="conn-field-hint">自部署 SearXNG 实例地址。</span>
          </label>
        )}
      </div>

      {state.probe?.status === "ok" && state.probe.sampleTitles?.length && (
        <div className="conn-probe-ok">
          <div className="conn-probe-title">测试返回 {state.probe.sampleTitles.length} 条结果：</div>
          <ul>
            {state.probe.sampleTitles.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {state.probe?.status === "error" && (
        <div className="conn-probe-err">{state.probe.errorMessage}</div>
      )}

      <footer className="conn-card-footer">
        <button
          className="approval-btn deny"
          onClick={onTest}
          disabled={state.testing || !isConfigured}
          title={isConfigured ? "测试搜索连接" : "请先填写凭证"}
        >
          {state.testing ? "测试中…" : "测试搜索"}
        </button>
        <button
          className="approval-btn approve"
          onClick={onSave}
          disabled={state.saving || !state.dirty}
        >
          {state.saving ? "保存中…" : "保存"}
        </button>
        {isConfigured && !isDefault && (
          <button className="approval-btn deny" onClick={onSetDefault}>
            设为默认
          </button>
        )}
        {isConfigured && (
          <button className="conn-clear-btn" onClick={onClear}>
            清除
          </button>
        )}
      </footer>
    </article>
  );
}
