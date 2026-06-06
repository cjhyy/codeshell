import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { ImageProbeResult } from "../../preload/types";
import { writeSettings } from "../settingsBus";
import { Button } from "@/components/ui/button";

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

type Kind = "openai" | "google";

interface ProviderMeta {
  /** Instance id stored in imageGen.providers[].id. v1: one instance per kind. */
  id: Kind;
  kind: Kind;
  displayName: string;
  description: string;
  defaultBaseUrl: string;
  defaultModel: string;
  signupUrl?: string;
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: "openai",
    kind: "openai",
    displayName: "OpenAI Images (gpt-image)",
    description: "OpenAI 图像 API。需要 OpenAI key；baseUrl 默认官方端点。",
    defaultBaseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-image-2",
    signupUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    kind: "google",
    displayName: "Gemini Images (Nano Banana)",
    description:
      "Gemini 图像生成。可直接用你已有的 Google key；OpenAI 兼容 baseUrl（/v1beta/openai）也会被自动规范到原生端点。",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash-image",
    signupUrl: "https://aistudio.google.com/apikey",
  },
];

interface ProviderState {
  apiKey: string;
  baseUrl: string;
  model: string;
  probe?: ImageProbeResult;
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

function isProbeResult(value: unknown): value is ImageProbeResult {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    (rec.status === "ok" || rec.status === "error" || rec.status === "unconfigured") &&
    typeof rec.lastProbedAt === "string"
  );
}

export function ImageGenConnectionsPanel({ scope, activeRepoPath }: Props) {
  const [defaultProvider, setDefaultProvider] = useState<Kind>("openai");
  const [byProvider, setByProvider] = useState<Record<Kind, ProviderState>>(() => ({
    openai: initialState(PROVIDERS[0]),
    google: initialState(PROVIDERS[1]),
  }));
  const [loaded, setLoaded] = useState(false);
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = useCallback(async () => {
    const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
    const imageGen = (s.imageGen && typeof s.imageGen === "object") ? (s.imageGen as Record<string, unknown>) : {};
    const list = Array.isArray(imageGen.providers) ? (imageGen.providers as Array<Record<string, unknown>>) : [];

    const next: Record<Kind, ProviderState> = {
      openai: initialState(PROVIDERS[0]),
      google: initialState(PROVIDERS[1]),
    };
    for (const meta of PROVIDERS) {
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
    const dp = typeof imageGen.defaultProvider === "string" ? imageGen.defaultProvider : undefined;
    if (dp === "openai" || dp === "google") setDefaultProvider(dp);

    setByProvider(next);
    setLoaded(true);
  }, [scope, cwd]);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (id: Kind, patch: Partial<ProviderState>) => {
    setByProvider((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  };

  const writeBack = useCallback(
    async (next: Record<Kind, ProviderState>, nextDefault: Kind) => {
      const providersOut: Array<Record<string, unknown>> = [];
      for (const meta of PROVIDERS) {
        const st = next[meta.id];
        // Only persist an entry once it has a key (the thing that makes it usable).
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
      await writeSettings(
        scope,
        { imageGen: { defaultProvider: nextDefault, providers: providersOut } },
        cwd,
      );
    },
    [scope, cwd],
  );

  const save = async (id: Kind) => {
    update(id, { saving: true });
    try {
      const next = { ...byProvider, [id]: { ...byProvider[id], saving: false, dirty: false } };
      await writeBack(next, defaultProvider);
      setByProvider(next);
    } catch (err) {
      console.error("imageGen save failed", err);
      update(id, { saving: false });
    }
  };

  const clear = async (id: Kind) => {
    const meta = PROVIDERS.find((p) => p.id === id)!;
    const next = { ...byProvider, [id]: initialState(meta) };
    setByProvider(next);
    try {
      await writeBack(next, defaultProvider);
    } catch (err) {
      console.error("imageGen clear failed", err);
      void load();
    }
  };

  const test = async (id: Kind) => {
    const meta = PROVIDERS.find((p) => p.id === id)!;
    const st = byProvider[id];
    update(id, { testing: true });
    try {
      const result = await window.codeshell.probeImage({
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

  const setDefault = async (id: Kind) => {
    setDefaultProvider(id);
    await writeBack(byProvider, id);
  };

  if (!loaded) {
    return <div className="connections-card-grid"><div className="view-loading">加载中…</div></div>;
  }

  return (
    <div className="connections-card-grid">
      {PROVIDERS.map((meta) => {
        const st = byProvider[meta.id];
        const isDefault = defaultProvider === meta.id;
        const isConfigured = !!st.apiKey;
        return (
          <ImageGenCard
            key={meta.id}
            meta={meta}
            state={st}
            isDefault={isDefault}
            isConfigured={isConfigured}
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
  onConfigChange: (patch: Partial<ProviderState>) => void;
  onUiChange: (patch: Partial<ProviderState>) => void;
  onSave: () => void;
  onTest: () => void;
  onClear: () => void;
  onSetDefault: () => void;
}

function ImageGenCard({
  meta,
  state,
  isDefault,
  isConfigured,
  onConfigChange,
  onUiChange,
  onSave,
  onTest,
  onClear,
  onSetDefault,
}: CardProps) {
  const statusPill = useMemo(() => {
    if (state.testing) return <span className="conn-pill probing">生成测试中…</span>;
    if (state.probe?.status === "ok") return <span className="conn-pill ok">可用</span>;
    if (state.probe?.status === "error") return <span className="conn-pill err">生成失败</span>;
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
          <span className="conn-field-hint">保存于 ~/.code-shell/settings.json，按 scope 隔离。</span>
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
          />
        </label>
      </div>

      {state.probe?.status === "ok" && state.probe.previewDataUrl && (
        <div className="conn-probe-image">
          <div className="conn-probe-title">测试生成成功</div>
          <img src={state.probe.previewDataUrl} alt="probe preview" />
        </div>
      )}
      {state.probe?.status === "error" && <div className="conn-probe-err">{state.probe.errorMessage}</div>}

      <footer className="conn-card-footer">
        <Button variant="default" onClick={onTest} disabled={state.testing || !isConfigured} title={isConfigured ? "用当前配置真生成一张测试图" : "请先填写 API key"}>
          {state.testing ? "生成中…" : "测试生图"}
        </Button>
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
