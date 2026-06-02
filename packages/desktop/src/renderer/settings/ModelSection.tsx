import React, { useEffect, useMemo, useState } from "react";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Button } from "@/components/ui/button";
import type { ReasoningControl, ReasoningSetting } from "@cjhyy/code-shell-core";

interface ModelEntry {
  key: string;
  label: string;
  providerKey: string;
  maxContextTokens?: number;
}

interface ProviderEntry {
  key: string;
  label?: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
}

interface FetchedModel {
  id: string;
  contextLength: number;
  maxOutputTokens: number;
}

interface RecommendedModel {
  label: string;
  id: string;
}

type ProviderKind =
  | "openrouter"
  | "anthropic"
  | "openai"
  | "deepseek"
  | "zai"
  | "xai"
  | "google"
  | "mistral"
  | "groq"
  | "ollama"
  | "custom";

interface KindMeta {
  label: string;
  defaultBaseUrl: string;
  keyUrl?: string;
  needsKey: boolean;
}

interface AddModelForm {
  kind: ProviderKind;
  providerRef: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  alias: string;
  label: string;
  makeActive: boolean;
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

const NEW_PROVIDER = "__new__";

const KIND_ORDER: ProviderKind[] = [
  "openrouter",
  "anthropic",
  "openai",
  "deepseek",
  "zai",
  "xai",
  "google",
  "mistral",
  "groq",
  "ollama",
  "custom",
];

const KIND_META: Record<ProviderKind, KindMeta> = {
  openrouter: {
    label: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    needsKey: true,
  },
  anthropic: {
    label: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    keyUrl: "https://console.anthropic.com/settings/keys",
    needsKey: true,
  },
  openai: {
    label: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    needsKey: true,
  },
  deepseek: {
    label: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    needsKey: true,
  },
  zai: {
    label: "Z.AI",
    defaultBaseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    needsKey: true,
  },
  xai: {
    label: "xAI",
    defaultBaseUrl: "https://api.x.ai/v1",
    keyUrl: "https://console.x.ai",
    needsKey: true,
  },
  google: {
    label: "Google Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    needsKey: true,
  },
  mistral: {
    label: "Mistral",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    keyUrl: "https://console.mistral.ai/api-keys",
    needsKey: true,
  },
  groq: {
    label: "Groq",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    keyUrl: "https://console.groq.com/keys",
    needsKey: true,
  },
  ollama: {
    label: "Ollama",
    defaultBaseUrl: "http://localhost:11434/v1",
    needsKey: false,
  },
  custom: {
    label: "Custom",
    defaultBaseUrl: "",
    needsKey: true,
  },
};

const RECOMMENDED_MODELS: Partial<Record<ProviderKind, RecommendedModel[]>> = {
  openrouter: [
    { label: "Claude Sonnet", id: "anthropic/claude-sonnet-4.6" },
    { label: "Claude Opus", id: "anthropic/claude-opus-4.7" },
    { label: "GPT-5", id: "openai/gpt-5" },
    { label: "GPT-5 Mini", id: "openai/gpt-5-mini" },
    { label: "Gemini 2.5 Pro", id: "google/gemini-2.5-pro" },
    { label: "DeepSeek Chat", id: "deepseek/deepseek-chat" },
  ],
  anthropic: [
    { label: "Claude Sonnet", id: "claude-sonnet-4-6" },
    { label: "Claude Opus", id: "claude-opus-4-7" },
    { label: "Claude Haiku", id: "claude-haiku-4-5" },
  ],
  openai: [
    { label: "GPT-5", id: "gpt-5" },
    { label: "GPT-5 Mini", id: "gpt-5-mini" },
    { label: "GPT-5 Nano", id: "gpt-5-nano" },
    { label: "GPT-4o", id: "gpt-4o" },
    { label: "o4 Mini", id: "o4-mini" },
  ],
  deepseek: [
    { label: "DeepSeek V4 Pro", id: "deepseek-v4-pro" },
    { label: "DeepSeek V4 Flash", id: "deepseek-v4-flash" },
    { label: "DeepSeek Chat", id: "deepseek-chat" },
  ],
  zai: [
    { label: "GLM 5.1", id: "glm-5.1" },
    { label: "GLM 4.6", id: "glm-4.6" },
    { label: "GLM 4.5 Air", id: "glm-4.5-air" },
  ],
  xai: [
    { label: "Grok", id: "grok-4" },
    { label: "Grok Fast", id: "grok-4-fast" },
  ],
  google: [
    { label: "Gemini 2.5 Pro", id: "gemini-2.5-pro" },
    { label: "Gemini 2.5 Flash", id: "gemini-2.5-flash" },
    { label: "Gemini 2.0 Flash", id: "gemini-2.0-flash" },
  ],
  mistral: [
    { label: "Mistral Large", id: "mistral-large-latest" },
    { label: "Codestral", id: "codestral-latest" },
  ],
  groq: [
    { label: "Llama 3.3 70B", id: "llama-3.3-70b-versatile" },
    { label: "DeepSeek R1 Distill", id: "deepseek-r1-distill-llama-70b" },
  ],
  ollama: [
    { label: "Llama 3.1", id: "llama3.1" },
    { label: "Qwen Coder", id: "qwen2.5-coder" },
    { label: "DeepSeek R1", id: "deepseek-r1" },
    { label: "Mistral", id: "mistral" },
  ],
};

/**
 * Active model picker plus a small guided add-model form.
 *
 * Existing behavior stays intact: selecting a row writes settings.activeKey.
 * The add form writes the same settings shape the TUI onboarding flow uses:
 * providers[] + self-describing models[] + a legacy model.* mirror when the
 * new entry becomes active.
 */
export function ModelSection({ scope, activeRepoPath }: Props) {
  const [cur, setCur] = useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [aliasTouched, setAliasTouched] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [form, setForm] = useState<AddModelForm>(() => initialForm());
  // Per-model reasoning descriptor, keyed by model `key`. Fetched lazily from
  // core (reasoningControlFor) via the preload bridge — the renderer never
  // imports core at runtime. `null` while a fetch is in flight.
  const [controls, setControls] = useState<Record<string, ReasoningControl | null>>({});

  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;

  const load = async () => {
    try {
      const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
      setCur(s);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  useEffect(() => {
    void load();
  }, [scope, activeRepoPath]);

  const providers = useMemo(() => providersFrom(cur ?? {}), [cur]);
  const rawProviders = useMemo(() => rawProvidersFrom(cur ?? {}), [cur]);
  const rawModels = useMemo(() => rawModelsFrom(cur ?? {}), [cur]);
  const candidates = useMemo(() => candidatesFrom(cur ?? {}), [cur]);
  const modelKeys = useMemo(() => new Set(candidates.map((m) => m.key)), [candidates]);

  // Resolve {provider kind, model id, current reasoning setting} for each model
  // key. Kind comes from the matching provider (by providerKey/provider); model
  // id from the raw entry's `model`. Used both to fetch the descriptor and to
  // read the saved value.
  const reasoningTargets = useMemo(() => {
    const map: Record<string, { kind: string; modelId: string; reasoning?: ReasoningSetting }> = {};
    for (const raw of rawModels) {
      const key = typeof raw.key === "string" ? raw.key
        : typeof raw.model === "string" ? raw.model : "";
      if (!key) continue;
      const modelId = typeof raw.model === "string" ? raw.model : key;
      const providerKey = typeof raw.providerKey === "string" ? raw.providerKey
        : typeof raw.provider === "string" ? raw.provider : "";
      const provider = providers.find((p) => p.key === providerKey);
      const kind = provider?.kind
        ?? (raw.provider === "anthropic" ? "anthropic" : "custom");
      map[key] = {
        kind,
        modelId,
        reasoning: isReasoningSetting(raw.reasoning) ? raw.reasoning : undefined,
      };
    }
    return map;
  }, [rawModels, providers]);

  // Fetch the ReasoningControl descriptor for every model via the preload
  // bridge. Re-runs when the (kind, modelId) set changes.
  useEffect(() => {
    let cancelled = false;
    const targets = reasoningTargets;
    void (async () => {
      // Independent per-model lookups — fetch them concurrently rather than
      // awaiting each IPC round-trip in series (N models × ~one round-trip).
      const entries = await Promise.all(
        Object.entries(targets).map(async ([key, t]) => {
          try {
            return [key, await window.codeshell.reasoningControl(t.kind, t.modelId)] as const;
          } catch {
            return [key, { kind: "none" } as ReasoningControl] as const;
          }
        }),
      );
      if (!cancelled) setControls(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [reasoningTargets]);

  const setReasoning = async (key: string, reasoning: ReasoningSetting) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const nextModels = rawModels.map((m) =>
        m.key === key || (typeof m.key !== "string" && m.model === key)
          ? { ...m, reasoning }
          : m,
      );
      await window.codeshell.updateSettings(scope, { models: nextModels }, cwd);
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const matchingProviders = providers.filter((p) => p.kind === form.kind);
  const selectedProvider =
    form.providerRef === NEW_PROVIDER
      ? undefined
      : matchingProviders.find((p) => p.key === form.providerRef);
  const kindMeta = KIND_META[form.kind];
  const effectiveBaseUrl = selectedProvider?.baseUrl ?? form.baseUrl.trim();
  const effectiveApiKey = selectedProvider?.apiKey ?? form.apiKey.trim();
  const selectedFetched = fetchedModels.find((m) => m.id === form.model.trim());
  const recommendedModels = RECOMMENDED_MODELS[form.kind] ?? [];
  const fetchedPickList = fetchedModels
    .filter((m) => !recommendedModels.some((r) => r.id === m.id))
    .slice(0, 300);
  const displayedAlias = aliasTouched
    ? form.alias
    : form.model
      ? deriveModelAlias(form.kind, form.model, modelKeys)
      : "";

  const activeKey =
    typeof cur?.activeKey === "string" ? (cur.activeKey as string) :
    cur?.model && typeof (cur.model as Record<string, unknown>).name === "string"
      ? ((cur.model as Record<string, unknown>).name as string)
      : "";

  const auxModelKey =
    typeof cur?.auxModelKey === "string" ? (cur.auxModelKey as string) : "";

  const setAuxModel = async (key: string) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      // Empty string → clear the override (fall back to the active model).
      // deepMerge treats null as "delete this key"; undefined would be
      // dropped by JSON.stringify but null is the documented clear signal.
      await window.codeshell.updateSettings(
        scope,
        { auxModelKey: key || null },
        cwd,
      );
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      setNotice(key ? `后台任务模型已设为 ${key}` : "后台任务模型已跟随当前模型");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const setActive = async (entry: ModelEntry) => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const raw = rawModels.find((m) => m.key === entry.key);
      const modelId = typeof raw?.model === "string" ? raw.model : entry.key;
      const provider = providers.find((p) => p.key === entry.providerKey);
      const protocol = typeof raw?.provider === "string"
        ? raw.provider
        : provider?.kind === "anthropic"
          ? "anthropic"
          : "openai";
      await window.codeshell.updateSettings(
        scope,
        {
          activeKey: entry.key,
          model: {
            provider: protocol,
            name: modelId,
            apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : provider?.apiKey,
            baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl : provider?.baseUrl,
          },
        },
        cwd,
      );
      // Notify the running agent worker so the model switch takes effect
      // on the next turn without an Electron restart.
      void window.codeshell.configure({ model: entry.key });
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const chooseKind = (kind: ProviderKind) => {
    const existing = providers.find((p) => p.kind === kind);
    setForm({
      ...initialForm(kind),
      providerRef: existing?.key ?? NEW_PROVIDER,
    });
    setFetchedModels([]);
    setFetchError(null);
    setAliasTouched(false);
    setManualModel(kind === "custom");
    setNotice(null);
    setError(null);
  };

  const chooseProviderRef = (providerRef: string) => {
    setForm((f) => ({ ...f, providerRef }));
    setFetchedModels([]);
    setFetchError(null);
  };

  const setModelId = (model: string) => {
    setForm((f) => ({
      ...f,
      model,
      alias: aliasTouched ? f.alias : deriveModelAlias(f.kind, model, modelKeys),
    }));
  };

  const refreshProviderModels = async () => {
    setFetchLoading(true);
    setFetchError(null);
    setNotice(null);
    try {
      const res = await window.codeshell.listModels(
        {
          key: selectedProvider?.key ?? form.kind,
          kind: form.kind,
          baseUrl: effectiveBaseUrl,
          apiKey: effectiveApiKey,
        },
        true,
      );
      setFetchedModels(res.models);
      if (!form.model && res.models[0]) setModelId(res.models[0].id);
      if (res.error) setFetchError(res.error);
      if (!res.error && res.models.length === 0) setFetchError("没有拿到模型列表，可以手动填写 model id。");
    } catch (e) {
      setFetchError(String(e instanceof Error ? e.message : e));
    } finally {
      setFetchLoading(false);
    }
  };

  const saveNewModel = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const modelId = form.model.trim();
      if (!modelId) throw new Error("先填写 model id。");

      const creatingProvider = !selectedProvider;
      const baseUrl = effectiveBaseUrl;
      const apiKey = effectiveApiKey;
      if (!baseUrl) throw new Error("先填写 Base URL。");
      if (kindMeta.needsKey && !apiKey) throw new Error("先填写 API Key，或选择已有 provider。");

      const alias = normalizeAlias(displayedAlias);
      if (!alias) throw new Error("先填写本地别名。");
      if (modelKeys.has(alias)) throw new Error(`本地别名已存在：${alias}`);

      let providerKey = selectedProvider?.key;
      const nextProviders = [...rawProviders];
      if (creatingProvider) {
        providerKey = deriveUniqueKey(
          form.kind === "custom" ? slugFromBaseUrl(baseUrl) || "custom" : form.kind,
          new Set(providers.map((p) => p.key)),
        );
        nextProviders.push({
          key: providerKey,
          label: kindMeta.label,
          kind: form.kind,
          baseUrl,
          apiKey: kindMeta.needsKey ? apiKey : undefined,
        });
      }

      const protocol = form.kind === "anthropic" ? "anthropic" : "openai";
      const newModel: Record<string, unknown> = {
        key: alias,
        label: form.label.trim() || modelId,
        providerKey,
        protocol,
        provider: protocol,
        model: modelId,
        baseUrl,
        apiKey: kindMeta.needsKey ? apiKey : undefined,
      };
      if (selectedFetched?.contextLength && selectedFetched.contextLength > 0) {
        newModel.maxContextTokens = selectedFetched.contextLength;
      }
      if (selectedFetched?.maxOutputTokens && selectedFetched.maxOutputTokens > 0) {
        newModel.maxOutputTokens = selectedFetched.maxOutputTokens;
      }

      const activate = form.makeActive || candidates.length === 0;
      const patch: Record<string, unknown> = {
        providers: nextProviders,
        models: [...rawModels, newModel],
      };
      if (activate) {
        patch.activeKey = alias;
        patch.model = {
          provider: protocol,
          name: modelId,
          apiKey: kindMeta.needsKey ? apiKey : undefined,
          baseUrl,
        };
      }

      await window.codeshell.updateSettings(scope, patch, cwd);
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      setAdding(false);
      setFetchedModels([]);
      setFetchError(null);
      setAliasTouched(false);
      setForm((f) => ({
        ...initialForm(f.kind),
        providerRef: selectedProvider?.key ?? providerKey ?? NEW_PROVIDER,
      }));
      setNotice(activate ? `已添加并切换到 ${alias}` : `已添加 ${alias}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setSaving(false);
    }
  };

  const canFetch =
    Boolean(effectiveBaseUrl) &&
    (!kindMeta.needsKey || Boolean(effectiveApiKey) || form.kind === "openrouter");

  return (
    <section className="settings-section">
      <div className="model-section-head">
        <div>
          <h3 className="settings-section-title">Active model</h3>
          <div className="settings-section-current">
            <span className="settings-section-label">当前：</span>
            <code>{activeKey || "(none)"}</code>
          </div>
        </div>
        <button
          className="approval-btn approve"
          onClick={() => setAdding((v) => !v)}
        >
          {adding ? "收起" : "添加模型"}
        </button>
      </div>

      {notice && <div className="settings-section-help">{notice}</div>}
      {candidates.length === 0 ? (
        <div className="approvals-empty">
          还没有模型。点「添加模型」后选择 provider、填 API Key 和 model id。
        </div>
      ) : (
        <ul className="model-list">
          {candidates.map((m) => {
            const active = m.key === activeKey;
            const control = controls[m.key];
            const reasoning = reasoningTargets[m.key]?.reasoning;
            return (
              <li
                key={m.key}
                className={`model-row${active ? " active" : ""}`}
                onClick={() => void setActive(m)}
              >
                <span className="model-provider">{m.providerKey}</span>
                <span className="model-name">{m.label}</span>
                {m.maxContextTokens && (
                  <span className="model-ctx">{formatTok(m.maxContextTokens)} ctx</span>
                )}
                {active && <span className="model-active-badge">active</span>}
                {control && control.kind !== "none" && (
                  <span
                    className="model-reasoning"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {renderReasoningControl(control, reasoning, saving, (next) =>
                      void setReasoning(m.key, next),
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {candidates.length > 0 && (
        <div className="model-aux-block">
          <label className="settings-field">
            <span>后台任务模型</span>
            <Select
              value={auxModelKey}
              onChange={(v) => void setAuxModel(v)}
              placeholder="跟随当前模型"
              options={[
                { value: "", label: "跟随当前模型（默认）" },
                ...candidates.map((m) => ({
                  value: m.key,
                  label: m.label,
                  searchText: `${m.label} ${m.key} ${m.providerKey}`,
                })),
              ]}
              searchable={candidates.length > 8}
            />
          </label>
          <div className="settings-section-help">
            记忆提取、自动 dream 等后台调用使用此模型。选个便宜快的（如 Haiku / DeepSeek），
            避免每轮对话都占用主模型。默认跟随当前模型。
          </div>
        </div>
      )}

      {adding && (
        <div className="model-add-panel">
          <div className="model-add-grid">
            <label className="settings-field">
              <span>Provider</span>
              <Select<ProviderKind>
                value={form.kind}
                onChange={(v) => chooseKind(v)}
                options={KIND_ORDER.map((kind) => ({
                  value: kind,
                  label: KIND_META[kind].label,
                }))}
              />
            </label>

            {matchingProviders.length > 0 && (
              <label className="settings-field">
                <span>凭证</span>
                <Select
                  value={form.providerRef}
                  onChange={chooseProviderRef}
                  options={[
                    ...matchingProviders.map((p) => ({
                      value: p.key,
                      label: `使用已有：${p.label ?? p.key}`,
                    })),
                    { value: NEW_PROVIDER, label: `新增 ${kindMeta.label} 凭证` },
                  ]}
                />
              </label>
            )}

            {!selectedProvider && (
              <label className="settings-field">
                <span>Base URL</span>
                <input
                  value={form.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                />
              </label>
            )}

            {!selectedProvider && kindMeta.needsKey && (
              <label className="settings-field">
                <span>API Key</span>
                <input
                  type="password"
                  value={form.apiKey}
                  placeholder={kindMeta.keyUrl ? "粘贴 API Key" : "API Key"}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value.trim() }))}
                />
              </label>
            )}
          </div>

          <div className="settings-toolbar">
            <button
              className="approval-btn deny"
              disabled={!canFetch || fetchLoading}
              onClick={() => void refreshProviderModels()}
              title={canFetch ? "从 provider 拉取可用模型" : "先补齐 Base URL/API Key"}
            >
              {fetchLoading ? "拉取中…" : "拉取模型列表"}
            </button>
            {kindMeta.keyUrl && !selectedProvider && (
              <button
                className="approval-btn deny"
                onClick={() => { void window.codeshell.openExternal(kindMeta.keyUrl!); }}
              >
                获取 Key
              </button>
            )}
            {fetchError && <span className="view-error">{fetchError}</span>}
          </div>

          {!manualModel && (
            <label className="settings-field">
              <span>模型</span>
              <Select
                value={form.model}
                onChange={setModelId}
                placeholder={
                  recommendedModels.length + fetchedPickList.length === 0
                    ? "拉取后选择模型"
                    : "选择模型"
                }
                searchable={fetchedPickList.length > 8}
                emptyLabel="没有匹配的模型"
                options={[
                  ...(recommendedModels.length > 0
                    ? [
                        {
                          label: "推荐",
                          options: recommendedModels.map((m) => ({
                            value: m.id,
                            label: m.label,
                            searchText: `${m.label} ${m.id}`,
                          })),
                        },
                      ]
                    : []),
                  ...(fetchedPickList.length > 0
                    ? [
                        {
                          label: `完整列表${fetchedModels.length > fetchedPickList.length ? "（前 300 个）" : ""}`,
                          options: fetchedPickList.map((m) => ({
                            value: m.id,
                            label: m.id,
                          })),
                        },
                      ]
                    : []),
                ]}
              />
            </label>
          )}

          <div className="settings-toolbar">
            <button
              className="approval-btn deny"
              onClick={() => {
                setManualModel((v) => !v);
                if (!manualModel) setFetchedModels([]);
              }}
            >
              {manualModel ? "使用推荐列表" : "手动填写 ID"}
            </button>
          </div>

          <div className="model-add-grid">
            {manualModel && (
              <label className="settings-field">
                <span>Model ID</span>
                <input
                  value={form.model}
                  placeholder="例如 anthropic/claude-sonnet-4.6 或 gpt-5"
                  onChange={(e) => setModelId(e.target.value)}
                />
              </label>
            )}
            <label className="settings-field">
              <span>本地别名</span>
              <input
                value={displayedAlias}
                placeholder="用于切换模型，例如 openrouter-claude-sonnet"
                onChange={(e) => {
                  setAliasTouched(true);
                  setForm((f) => ({ ...f, alias: normalizeAlias(e.target.value) }));
                }}
              />
            </label>
            <label className="settings-field">
              <span>显示名称</span>
              <input
                value={form.label}
                placeholder="留空则使用 Model ID"
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
            </label>
          </div>

          {selectedFetched && (
            <div className="settings-section-current">
              <span className="settings-section-label">模型信息：</span>
              <code>{formatTok(selectedFetched.contextLength)} ctx</code>
              {selectedFetched.maxOutputTokens > 0 && (
                <code>{formatTok(selectedFetched.maxOutputTokens)} output</code>
              )}
            </div>
          )}

          <label className="settings-toggle-inline">
            <input
              type="checkbox"
              checked={form.makeActive}
              onChange={(e) => setForm((f) => ({ ...f, makeActive: e.target.checked }))}
            />
            <span>添加后设为当前模型</span>
          </label>

          <div className="settings-toolbar">
            <Button variant="default" disabled={saving} onClick={() => setAdding(false)}>
              取消
            </Button>
            <Button variant="solid" disabled={saving} onClick={() => void saveNewModel()}>
              {saving ? "保存中…" : "保存模型"}
            </Button>
          </div>
        </div>
      )}

      {error && <div className="view-error">{error}</div>}
      {saving && <div className="approvals-empty">保存中…</div>}
    </section>
  );
}

function initialForm(kind: ProviderKind = "openrouter"): AddModelForm {
  const firstModel = RECOMMENDED_MODELS[kind]?.[0]?.id ?? "";
  return {
    kind,
    providerRef: NEW_PROVIDER,
    baseUrl: KIND_META[kind].defaultBaseUrl,
    apiKey: "",
    model: firstModel,
    alias: "",
    label: "",
    makeActive: true,
  };
}

function candidatesFrom(s: Record<string, unknown>): ModelEntry[] {
  const models = s.models;
  if (!Array.isArray(models)) return [];
  const out: ModelEntry[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key :
                typeof obj.model === "string" ? obj.model : "";
    if (!key) continue;
    out.push({
      key,
      label: typeof obj.label === "string" ? obj.label :
             typeof obj.model === "string" ? obj.model : key,
      providerKey: typeof obj.providerKey === "string" ? obj.providerKey :
                   typeof obj.provider === "string" ? obj.provider : "",
      maxContextTokens: typeof obj.maxContextTokens === "number" ? obj.maxContextTokens : undefined,
    });
  }
  return out;
}

function rawModelsFrom(s: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(s.models)
    ? s.models.filter((m): m is Record<string, unknown> => Boolean(m && typeof m === "object"))
    : [];
}

function rawProvidersFrom(s: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(s.providers)
    ? s.providers.filter((p): p is Record<string, unknown> => Boolean(p && typeof p === "object"))
    : [];
}

function providersFrom(s: Record<string, unknown>): ProviderEntry[] {
  if (!Array.isArray(s.providers)) return [];
  const out: ProviderEntry[] = [];
  for (const p of s.providers) {
    if (!p || typeof p !== "object") continue;
    const obj = p as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key : "";
    const rawKind = typeof obj.kind === "string" ? obj.kind : "";
    const kind = isProviderKind(rawKind) ? rawKind : "custom";
    const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl : "";
    if (!key || !baseUrl) continue;
    out.push({
      key,
      kind,
      baseUrl,
      label: typeof obj.label === "string" ? obj.label : undefined,
      apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
    });
  }
  return out;
}

function isProviderKind(value: string): value is ProviderKind {
  return (KIND_ORDER as string[]).includes(value);
}

function deriveModelAlias(kind: ProviderKind, modelId: string, used: Set<string>): string {
  const slash = modelId.lastIndexOf("/");
  const base = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  const normalized = normalizeAlias(base);
  const prefix = kind === "custom" ? "" : kind;
  const candidate = prefix && !normalized.startsWith(`${prefix}-`)
    ? `${prefix}-${normalized}`
    : normalized;
  return deriveUniqueKey(candidate || kind, used);
}

function deriveUniqueKey(base: string, used: Set<string>): string {
  const normalized = normalizeAlias(base) || "model";
  if (!used.has(normalized)) return normalized;
  for (let i = 2; ; i++) {
    const candidate = `${normalized}-${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

function normalizeAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/[/-]{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function slugFromBaseUrl(value: string): string {
  try {
    const host = new URL(value).hostname.replace(/^api\./, "");
    return normalizeAlias(host.split(".")[0] ?? "custom");
  } catch {
    return normalizeAlias(value.split("/")[0] ?? "custom");
  }
}

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return `${n}`;
}

/** Narrow an unknown settings value to a ReasoningSetting. */
function isReasoningSetting(v: unknown): v is ReasoningSetting {
  if (!v || typeof v !== "object") return false;
  const mode = (v as { mode?: unknown }).mode;
  return mode === "off" || mode === "on" || mode === "effort" || mode === "budget";
}

const EFFORT_LABELS: Record<string, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

/**
 * Render the "思考" (reasoning) control a model's ReasoningControl describes.
 * Pure — given a control + the saved value, returns the right widget and calls
 * `onChange` with the ReasoningSetting to persist. `none` is filtered upstream.
 *
 *   toggle   → checkbox      → {mode:"on"} / {mode:"off"}
 *   effort   → dropdown      → {mode:"effort", effort}
 *   budget   → number input  → {mode:"budget", budgetTokens}
 *   adaptive → read-only tag  (no write)
 */
export function renderReasoningControl(
  control: ReasoningControl,
  value: ReasoningSetting | undefined,
  disabled: boolean,
  onChange: (next: ReasoningSetting) => void,
): React.ReactNode {
  switch (control.kind) {
    case "none":
      return null;
    case "adaptive":
      return <span className="model-reasoning-tag">自动思考(不可调)</span>;
    case "toggle": {
      const on = value ? value.mode !== "off" : control.default;
      return (
        <label className="model-reasoning-toggle" title="思考">
          <input
            type="checkbox"
            checked={on}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? { mode: "on" } : { mode: "off" })}
          />
          <span>思考</span>
        </label>
      );
    }
    case "effort": {
      const current = value && value.mode === "effort" ? value.effort : control.default;
      return (
        <Select
          value={current}
          disabled={disabled}
          onChange={(v) => onChange({ mode: "effort", effort: v as typeof control.options[number] })}
          options={control.options.map((opt) => ({
            value: opt,
            label: `思考:${EFFORT_LABELS[opt] ?? opt}`,
          }))}
        />
      );
    }
    case "budget": {
      const current = value && value.mode === "budget" ? value.budgetTokens : control.default;
      return (
        <label className="model-reasoning-budget" title="思考预算(tokens)">
          <span>思考预算</span>
          <input
            type="number"
            min={control.min}
            step={1024}
            value={current}
            disabled={disabled}
            onChange={(e) => {
              const n = Math.max(control.min, Math.floor(Number(e.target.value) || control.min));
              onChange({ mode: "budget", budgetTokens: n });
            }}
          />
        </label>
      );
    }
  }
}
