import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, RefreshCw, Settings2, X } from "lucide-react";
import { SimpleSelect as Select } from "@/components/ui/simple-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { ReasoningControl, ReasoningSetting } from "@cjhyy/code-shell-core";
import { useConfirm } from "../ui/ConfirmDialog";
import { useToast } from "../ui/ToastProvider";
import {
  ConnCard,
  ConnCardFooter,
  ConnCardGrid,
  ConnField,
  ConnFooterRight,
  SecretKeyInput,
} from "./connUi";
import { cacheGet, cacheSet } from "./settingsCache";

interface ModelEntry {
  key: string;
  label: string;
  providerKey: string;
  modelId: string;
  protocol: string;
  providerKind: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

interface ProviderEntry {
  key: string;
  label?: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey?: string;
}

interface ProviderGroup {
  provider: ProviderEntry;
  models: ModelEntry[];
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

interface EditModelForm {
  originalKey: string;
  key: string;
  label: string;
  providerKey: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxContextTokens: string;
  maxOutputTokens: string;
}

interface EditProviderForm {
  originalKey: string;
  key: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  originalApiKey: string;
}

interface Props {
  scope: "user" | "project";
  activeRepoPath: string | null;
}

const NEW_PROVIDER = "__new__";
const ORPHAN_PROVIDER = "__models_without_provider__";

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

export function ModelSection({ scope, activeRepoPath }: Props) {
  const cwd = scope === "project" ? activeRepoPath ?? undefined : undefined;
  const cacheKey = `model-settings:${scope}:${cwd ?? ""}`;
  const [cur, setCur] = useState<Record<string, unknown> | null>(
    () => cacheGet<Record<string, unknown>>(cacheKey) ?? null,
  );
  const [savingId, setSavingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [aliasTouched, setAliasTouched] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [fetchLoading, setFetchLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [fetchedModels, setFetchedModels] = useState<FetchedModel[]>([]);
  const [showAddKey, setShowAddKey] = useState(false);
  const [form, setForm] = useState<AddModelForm>(() => initialForm());
  const [editingModel, setEditingModel] = useState<EditModelForm | null>(null);
  const [editingProvider, setEditingProvider] = useState<EditProviderForm | null>(null);
  const [showEditModelKey, setShowEditModelKey] = useState(false);
  const [showEditProviderKey, setShowEditProviderKey] = useState(false);
  const [controls, setControls] = useState<Record<string, ReasoningControl | null>>({});
  const confirm = useConfirm();
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const s = (await window.codeshell.getSettings(scope, cwd)) ?? {};
      setCur(s);
      setLoadError(null);
      cacheSet(cacheKey, s);
    } catch (e) {
      setLoadError(String(e instanceof Error ? e.message : e));
    }
  }, [scope, cwd, cacheKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const providers = useMemo(() => providersFrom(cur ?? {}), [cur]);
  const rawProviders = useMemo(() => rawProvidersFrom(cur ?? {}), [cur]);
  const rawModels = useMemo(() => rawModelsFrom(cur ?? {}), [cur]);
  const candidates = useMemo(() => candidatesFrom(cur ?? {}, providers), [cur, providers]);
  const modelKeys = useMemo(() => new Set(candidates.map((m) => m.key)), [candidates]);

  const providerGroups = useMemo(
    () => providerGroupsFrom(providers, candidates),
    [providers, candidates],
  );

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

  useEffect(() => {
    let cancelled = false;
    const targets = reasoningTargets;
    void (async () => {
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

  const activeKey =
    typeof cur?.activeKey === "string" ? (cur.activeKey as string) :
    cur?.model && typeof (cur.model as Record<string, unknown>).name === "string"
      ? ((cur.model as Record<string, unknown>).name as string)
      : "";

  const auxModelKey =
    typeof cur?.auxModelKey === "string" ? (cur.auxModelKey as string) : "";

  const activeModel = candidates.find((m) => m.key === activeKey);
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

  const setReasoning = async (key: string, reasoning: ReasoningSetting) => {
    setSavingId(`reasoning:${key}`);
    try {
      const nextModels = rawModels.map((m) =>
        m.key === key || (typeof m.key !== "string" && m.model === key)
          ? { ...m, reasoning }
          : m,
      );
      await window.codeshell.updateSettings(scope, { models: nextModels }, cwd);
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      toast({ message: "思考设置已保存", variant: "success" });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const setAuxModel = async (key: string) => {
    setSavingId("aux");
    try {
      await window.codeshell.updateSettings(
        scope,
        { auxModelKey: key || null },
        cwd,
      );
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      toast({
        message: key ? `后台任务模型已设为 ${key}` : "后台任务模型已跟随当前模型",
        variant: "success",
      });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const setActive = async (entry: ModelEntry) => {
    setSavingId(`active:${entry.key}`);
    try {
      const raw = rawModels.find((m) => m.key === entry.key);
      const modelId = typeof raw?.model === "string" ? raw.model : entry.modelId;
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
            apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : provider?.apiKey ?? null,
            baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl : provider?.baseUrl ?? null,
          },
        },
        cwd,
      );
      void window.codeshell.configure({ model: entry.key });
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      toast({ message: `当前模型已切换到 ${entry.key}`, variant: "success" });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const removeModel = async (entry: ModelEntry) => {
    const ok = await confirm({
      message: `删除模型「${entry.label}」？`,
      detail: `本地别名 #${entry.key} 会从当前 scope 的 models[] 中移除。`,
      destructive: true,
    });
    if (!ok) return;

    setSavingId(`delete:${entry.key}`);
    try {
      const nextRawModels = rawModels.filter((m) => modelKeyOf(m) !== entry.key);
      const remaining = candidates.filter((m) => m.key !== entry.key);
      const patch: Record<string, unknown> = { models: nextRawModels };
      let nextActive: ModelEntry | undefined;

      if (auxModelKey === entry.key) patch.auxModelKey = null;
      if (activeKey === entry.key) {
        nextActive = remaining[0];
        if (nextActive) {
          patch.activeKey = nextActive.key;
          patch.model = legacyModelPatch(nextActive, rawModels, providers);
        } else {
          patch.activeKey = null;
          patch.model = null;
        }
      }

      await window.codeshell.updateSettings(scope, patch, cwd);
      if (activeKey === entry.key) {
        if (nextActive) void window.codeshell.configure({ model: nextActive.key });
        else void window.codeshell.configure({ reloadModels: true });
      }
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      toast({ message: `已删除 ${entry.key}`, variant: "success" });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const clearProviderKey = async (provider: ProviderEntry) => {
    const ok = await confirm({
      message: `清除「${provider.label ?? KIND_META[provider.kind].label}」的 API key？`,
      detail: "会同时移除该 provider 下模型副本里的 apiKey；Base URL 和模型列表会保留。",
      destructive: true,
    });
    if (!ok) return;

    setSavingId(`clear-key:${provider.key}`);
    try {
      const nextProviders = rawProviders.map((p) =>
        p.key === provider.key ? withoutKey(p, "apiKey") : p,
      );
      const nextModels = rawModels.map((m) =>
        modelProviderKeyOf(m) === provider.key ? withoutKey(m, "apiKey") : m,
      );
      const patch: Record<string, unknown> = {
        providers: nextProviders,
        models: nextModels,
      };
      if (activeModel?.providerKey === provider.key) {
        patch.model = { apiKey: null };
      }
      await window.codeshell.updateSettings(scope, patch, cwd);
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      toast({ message: "API key 已清除", variant: "success" });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const saveEditedModel = async () => {
    if (!editingModel) return;
    const originalKey = editingModel.originalKey;
    const nextKey = normalizeAlias(editingModel.key);
    const nextModelId = editingModel.model.trim();
    const nextProviderKey = editingModel.providerKey.trim();
    const provider = providers.find((p) => p.key === nextProviderKey);
    const existingKeys = new Set(candidates.filter((m) => m.key !== originalKey).map((m) => m.key));

    setSavingId(`edit-model:${originalKey}`);
    try {
      if (!nextKey) throw new Error("先填写本地别名。");
      if (existingKeys.has(nextKey)) throw new Error(`本地别名已存在：${nextKey}`);
      if (!nextModelId) throw new Error("先填写 Model ID。");
      if (!provider) throw new Error("先选择有效 provider。");

      const protocol = provider.kind === "anthropic" ? "anthropic" : "openai";
      const contextTokens = parseOptionalPositiveInt(editingModel.maxContextTokens, "Context tokens");
      const outputTokens = parseOptionalPositiveInt(editingModel.maxOutputTokens, "Output tokens");
      const nextModels = rawModels.map((m) => {
        if (modelKeyOf(m) !== originalKey) return m;
        const next: Record<string, unknown> = {
          ...m,
          key: nextKey,
          label: editingModel.label.trim() || nextModelId,
          providerKey: provider.key,
          protocol,
          provider: protocol,
          model: nextModelId,
        };
        assignOptionalString(next, "baseUrl", editingModel.baseUrl.trim());
        assignOptionalString(next, "apiKey", editingModel.apiKey.trim());
        assignOptionalNumber(next, "maxContextTokens", contextTokens);
        assignOptionalNumber(next, "maxOutputTokens", outputTokens);
        return next;
      });

      const patch: Record<string, unknown> = { models: nextModels };
      const activeWasEdited = activeKey === originalKey;
      if (activeWasEdited) {
        patch.activeKey = nextKey;
        patch.model = legacyModelPatchByKey(nextKey, nextModels, providers);
      }
      if (auxModelKey === originalKey) patch.auxModelKey = nextKey;

      await window.codeshell.updateSettings(scope, patch, cwd);
      if (activeWasEdited) void window.codeshell.configure({ model: nextKey });
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      setEditingModel(null);
      setShowEditModelKey(false);
      toast({ message: `已保存 ${nextKey}`, variant: "success" });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const saveEditedProvider = async () => {
    if (!editingProvider) return;
    const originalKey = editingProvider.originalKey;
    const nextKey = normalizeAlias(editingProvider.key);
    const nextBaseUrl = editingProvider.baseUrl.trim();
    const nextKind = editingProvider.kind;
    const existingKeys = new Set(providers.filter((p) => p.key !== originalKey).map((p) => p.key));

    setSavingId(`edit-provider:${originalKey}`);
    try {
      if (!nextKey) throw new Error("先填写 provider key。");
      if (existingKeys.has(nextKey)) throw new Error(`Provider key 已存在：${nextKey}`);
      if (!nextBaseUrl) throw new Error("先填写 Base URL。");

      const nextProviderRecords = rawProviders.map((p) => {
        if (p.key !== originalKey) return p;
        const next: Record<string, unknown> = {
          ...p,
          key: nextKey,
          label: editingProvider.label.trim() || KIND_META[nextKind].label,
          kind: nextKind,
          baseUrl: nextBaseUrl,
        };
        assignOptionalString(next, "apiKey", editingProvider.apiKey.trim());
        return next;
      });
      const nextProviders = providersFrom({ providers: nextProviderRecords });
      const protocol = nextKind === "anthropic" ? "anthropic" : "openai";
      // Only propagate the provider's apiKey down to its models when it actually
      // changed in this edit. Otherwise an unrelated edit (e.g. just Base URL)
      // would clobber a model's own distinct apiKey override with the provider
      // key (or delete it when the provider field is blank).
      const apiKeyChanged = editingProvider.apiKey.trim() !== editingProvider.originalApiKey.trim();
      const nextModels = rawModels.map((m) => {
        if (modelProviderKeyOf(m) !== originalKey) return m;
        const next: Record<string, unknown> = {
          ...m,
          providerKey: nextKey,
          protocol,
          provider: protocol,
          baseUrl: nextBaseUrl,
        };
        if (apiKeyChanged) assignOptionalString(next, "apiKey", editingProvider.apiKey.trim());
        return next;
      });

      const patch: Record<string, unknown> = {
        providers: nextProviderRecords,
        models: nextModels,
      };
      if (activeModel?.providerKey === originalKey) {
        patch.model = legacyModelPatchByKey(activeModel.key, nextModels, nextProviders);
      }

      await window.codeshell.updateSettings(scope, patch, cwd);
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      setEditingProvider(null);
      setShowEditProviderKey(false);
      toast({ message: `已保存 provider #${nextKey}`, variant: "success" });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const removeProvider = async (provider: ProviderEntry, modelsForProvider: ModelEntry[]) => {
    if (provider.key === ORPHAN_PROVIDER) return;
    const ok = await confirm({
      message: `删除 provider「${provider.label ?? KIND_META[provider.kind].label}」？`,
      detail: modelsForProvider.length > 0
        ? `会同时删除它下面的 ${modelsForProvider.length} 个模型实例。`
        : "会从当前 scope 的 providers[] 中移除这个 provider 配置。",
      destructive: true,
    });
    if (!ok) return;

    setSavingId(`delete-provider:${provider.key}`);
    try {
      const removedKeys = new Set(modelsForProvider.map((m) => m.key));
      const nextProviders = rawProviders.filter((p) => p.key !== provider.key);
      const nextModels = rawModels.filter((m) => !removedKeys.has(modelKeyOf(m)));
      const remaining = candidates.filter((m) => !removedKeys.has(m.key));
      const nextProviderEntries = providersFrom({ providers: nextProviders });
      const patch: Record<string, unknown> = {
        providers: nextProviders,
        models: nextModels,
      };
      let nextActive: ModelEntry | undefined;

      if (removedKeys.has(auxModelKey)) patch.auxModelKey = null;
      if (removedKeys.has(activeKey)) {
        nextActive = remaining[0];
        if (nextActive) {
          patch.activeKey = nextActive.key;
          patch.model = legacyModelPatchByKey(nextActive.key, nextModels, nextProviderEntries);
        } else {
          patch.activeKey = null;
          patch.model = null;
        }
      }

      await window.codeshell.updateSettings(scope, patch, cwd);
      if (removedKeys.has(activeKey)) {
        if (nextActive) void window.codeshell.configure({ model: nextActive.key });
        else void window.codeshell.configure({ reloadModels: true });
      }
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      toast({ message: `已删除 provider #${provider.key}`, variant: "success" });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
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
    setShowAddKey(false);
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
    setSavingId("new");
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
      if (activate) void window.codeshell.configure({ model: alias });
      window.dispatchEvent(new Event("codeshell:settings-changed"));
      await load();
      setAddOpen(false);
      setFetchedModels([]);
      setFetchError(null);
      setAliasTouched(false);
      setShowAddKey(false);
      setForm((f) => ({
        ...initialForm(f.kind),
        providerRef: selectedProvider?.key ?? providerKey ?? NEW_PROVIDER,
      }));
      toast({
        message: activate ? `已添加并切换到 ${alias}` : `已添加 ${alias}`,
        variant: "success",
      });
    } catch (e) {
      toast({
        message: String(e instanceof Error ? e.message : e),
        variant: "error",
      });
    } finally {
      setSavingId(null);
    }
  };

  const canFetch =
    Boolean(effectiveBaseUrl) &&
    (!kindMeta.needsKey || Boolean(effectiveApiKey) || form.kind === "openrouter");

  const openAddDialog = () => {
    const firstKind = providers[0]?.kind ?? "openrouter";
    chooseKind(firstKind);
    setAddOpen(true);
  };

  return (
    <section className="mb-6 flex flex-col gap-3">
      <header className="mb-3 flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h3 className="m-0 text-[0.95rem] font-semibold text-foreground">Active model</h3>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>当前</span>
              <code className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {activeKey || "(none)"}
              </code>
              {activeModel && (
                <Badge variant="secondary" className="font-mono">
                  {activeModel.providerKey}
                </Badge>
              )}
            </div>
          </div>
          <Button onClick={openAddDialog}>
            <Plus />
            添加模型
          </Button>
        </div>

        {candidates.length > 0 && (
          <div className="grid gap-2 rounded-lg border border-border bg-card p-3 sm:grid-cols-[minmax(220px,320px)_1fr] sm:items-center">
            <ConnField label="后台任务模型" hint="记忆提取、自动 dream 等后台调用使用此模型。">
              <Select
                value={auxModelKey}
                disabled={savingId === "aux"}
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
            </ConnField>
            <p className="text-xs leading-relaxed text-muted-foreground">
              选个便宜快的模型处理后台任务，默认会跟随当前聊天模型。
            </p>
          </div>
        )}
      </header>

      {loadError && (
        <div className="mb-3 rounded-md border border-status-err/25 bg-status-err/5 px-3 py-2 text-sm text-status-err">
          {loadError}
        </div>
      )}

      {providerGroups.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border bg-card p-6 text-sm text-muted-foreground">
          还没有模型。点「添加模型」后选择 provider、填 API Key 和 model id。
        </div>
      ) : (
        <ConnCardGrid>
          {providerGroups.map((group) => (
            <ProviderModelCard
              key={group.provider.key}
              group={group}
              activeKey={activeKey}
              savingId={savingId}
              controls={controls}
              reasoningTargets={reasoningTargets}
              onSetActive={(entry) => void setActive(entry)}
              onSetReasoning={(key, next) => void setReasoning(key, next)}
              onRemoveModel={(entry) => void removeModel(entry)}
              onClearProviderKey={(provider) => void clearProviderKey(provider)}
              onEditModel={(entry) => {
                setEditingModel(editModelFormFromEntry(entry));
                setShowEditModelKey(false);
              }}
              onEditProvider={(provider) => {
                setEditingProvider(editProviderFormFromEntry(provider));
                setShowEditProviderKey(false);
              }}
              onRemoveProvider={(provider, modelsForProvider) => void removeProvider(provider, modelsForProvider)}
            />
          ))}
        </ConnCardGrid>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>添加模型</DialogTitle>
            <DialogDescription>
              选择 provider、凭证和模型 ID；保存后会写入当前 scope 的 providers[] 与 models[]。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <ConnField label="Provider">
              <Select<ProviderKind>
                value={form.kind}
                onChange={(v) => chooseKind(v)}
                options={KIND_ORDER.map((kind) => ({
                  value: kind,
                  label: KIND_META[kind].label,
                }))}
              />
            </ConnField>

            {matchingProviders.length > 0 && (
              <ConnField label="凭证">
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
              </ConnField>
            )}

            {!selectedProvider && (
              <ConnField label="Base URL">
                <Input
                  value={form.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  className="font-mono text-sm"
                />
              </ConnField>
            )}

            {!selectedProvider && kindMeta.needsKey && (
              <ConnField label="API Key" hint="保存于当前 settings scope。">
                <SecretKeyInput
                  value={form.apiKey}
                  show={showAddKey}
                  placeholder={kindMeta.keyUrl ? "粘贴 API Key" : "API Key"}
                  onChange={(value) => setForm((f) => ({ ...f, apiKey: value }))}
                  onToggleShow={() => setShowAddKey((show) => !show)}
                />
              </ConnField>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!canFetch || fetchLoading}
              onClick={() => void refreshProviderModels()}
              title={canFetch ? "从 provider 拉取可用模型" : "先补齐 Base URL/API Key"}
            >
              <RefreshCw className={cn(fetchLoading && "animate-spin")} />
              {fetchLoading ? "拉取中…" : "拉取模型列表"}
            </Button>
            {kindMeta.keyUrl && !selectedProvider && (
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => { void window.codeshell.openExternal(kindMeta.keyUrl!); }}
              >
                获取 key
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setManualModel((v) => !v);
                if (!manualModel) setFetchedModels([]);
              }}
            >
              <Settings2 />
              {manualModel ? "使用推荐列表" : "手动填写 ID"}
            </Button>
          </div>

          {fetchError && (
            <div className="break-all rounded-md border border-status-err/25 bg-status-err/5 px-3 py-2 text-sm text-status-err">
              {fetchError}
            </div>
          )}

          {!manualModel && (
            <ConnField label="模型">
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
            </ConnField>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {manualModel && (
              <ConnField label="Model ID">
                <Input
                  value={form.model}
                  placeholder="例如 anthropic/claude-sonnet-4.6 或 gpt-5"
                  onChange={(e) => setModelId(e.target.value)}
                  className="font-mono text-sm"
                />
              </ConnField>
            )}
            <ConnField label="本地别名" hint="用于模型切换；保存后不可在此处改名。">
              <Input
                value={displayedAlias}
                placeholder="例如 openrouter-claude-sonnet"
                onChange={(e) => {
                  setAliasTouched(true);
                  setForm((f) => ({ ...f, alias: normalizeAlias(e.target.value) }));
                }}
                className="font-mono text-sm"
              />
            </ConnField>
            <ConnField label="显示名称">
              <Input
                value={form.label}
                placeholder="留空则使用 Model ID"
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
            </ConnField>
          </div>

          {selectedFetched && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>模型信息</span>
              <Badge variant="secondary">{formatTok(selectedFetched.contextLength)} ctx</Badge>
              {selectedFetched.maxOutputTokens > 0 && (
                <Badge variant="secondary">{formatTok(selectedFetched.maxOutputTokens)} output</Badge>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch
              checked={form.makeActive}
              onCheckedChange={(checked) => setForm((f) => ({ ...f, makeActive: checked }))}
            />
            <span>添加后设为当前模型</span>
          </label>

          <DialogFooter>
            <Button
              variant="ghost"
              disabled={savingId === "new"}
              onClick={() => setAddOpen(false)}
            >
              <X />
              取消
            </Button>
            <Button
              variant="solid"
              disabled={savingId === "new"}
              onClick={() => void saveNewModel()}
            >
              <Plus />
              {savingId === "new" ? "保存中…" : "保存模型"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingModel}
        onOpenChange={(open) => {
          if (!open) setEditingModel(null);
        }}
      >
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑模型</DialogTitle>
            <DialogDescription>
              修改本地别名、显示名、Model ID、归属 provider 和模型级覆盖项。
            </DialogDescription>
          </DialogHeader>
          {editingModel && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <ConnField label="本地别名">
                  <Input
                    value={editingModel.key}
                    onChange={(e) => setEditingModel((f) => f && { ...f, key: normalizeAlias(e.target.value) })}
                    className="font-mono text-sm"
                  />
                </ConnField>
                <ConnField label="显示名称">
                  <Input
                    value={editingModel.label}
                    onChange={(e) => setEditingModel((f) => f && { ...f, label: e.target.value })}
                    placeholder="留空则使用 Model ID"
                  />
                </ConnField>
                <ConnField label="Model ID">
                  <Input
                    value={editingModel.model}
                    onChange={(e) => setEditingModel((f) => f && { ...f, model: e.target.value })}
                    className="font-mono text-sm"
                  />
                </ConnField>
                <ConnField label="Provider">
                  <Select
                    value={editingModel.providerKey}
                    onChange={(providerKey) => setEditingModel((f) => f && { ...f, providerKey })}
                    options={providers.map((p) => ({
                      value: p.key,
                      label: `${p.label ?? KIND_META[p.kind].label} #${p.key}`,
                    }))}
                  />
                </ConnField>
                <ConnField label="Base URL override" hint="留空则使用 provider 的 Base URL。">
                  <Input
                    value={editingModel.baseUrl}
                    onChange={(e) => setEditingModel((f) => f && { ...f, baseUrl: e.target.value })}
                    className="font-mono text-sm"
                  />
                </ConnField>
                <ConnField label="API Key override" hint="留空则使用 provider 的 API key。">
                  <SecretKeyInput
                    value={editingModel.apiKey}
                    show={showEditModelKey}
                    onChange={(apiKey) => setEditingModel((f) => f && { ...f, apiKey })}
                    onToggleShow={() => setShowEditModelKey((show) => !show)}
                  />
                </ConnField>
                <ConnField label="Context tokens">
                  <Input
                    type="number"
                    min={1}
                    value={editingModel.maxContextTokens}
                    onChange={(e) => setEditingModel((f) => f && { ...f, maxContextTokens: e.target.value })}
                    placeholder="留空自动推断"
                  />
                </ConnField>
                <ConnField label="Output tokens">
                  <Input
                    type="number"
                    min={1}
                    value={editingModel.maxOutputTokens}
                    onChange={(e) => setEditingModel((f) => f && { ...f, maxOutputTokens: e.target.value })}
                    placeholder="留空使用 provider 默认"
                  />
                </ConnField>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setEditingModel(null)}>
                  <X />
                  取消
                </Button>
                <Button
                  variant="solid"
                  disabled={savingId === `edit-model:${editingModel.originalKey}`}
                  onClick={() => void saveEditedModel()}
                >
                  {savingId === `edit-model:${editingModel.originalKey}` ? "保存中…" : "保存模型"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingProvider}
        onOpenChange={(open) => {
          if (!open) setEditingProvider(null);
        }}
      >
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>编辑 provider</DialogTitle>
            <DialogDescription>
              修改 provider key 会同步更新引用它的模型实例。
            </DialogDescription>
          </DialogHeader>
          {editingProvider && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <ConnField label="Provider key">
                  <Input
                    value={editingProvider.key}
                    onChange={(e) => setEditingProvider((f) => f && { ...f, key: normalizeAlias(e.target.value) })}
                    className="font-mono text-sm"
                  />
                </ConnField>
                <ConnField label="显示名称">
                  <Input
                    value={editingProvider.label}
                    onChange={(e) => setEditingProvider((f) => f && { ...f, label: e.target.value })}
                    placeholder="留空则使用 provider 类型名称"
                  />
                </ConnField>
                <ConnField label="Kind">
                  <Select<ProviderKind>
                    value={editingProvider.kind}
                    onChange={(kind) => setEditingProvider((f) => f && { ...f, kind })}
                    options={KIND_ORDER.map((kind) => ({
                      value: kind,
                      label: KIND_META[kind].label,
                    }))}
                  />
                </ConnField>
                <ConnField label="Base URL">
                  <Input
                    value={editingProvider.baseUrl}
                    onChange={(e) => setEditingProvider((f) => f && { ...f, baseUrl: e.target.value })}
                    className="font-mono text-sm"
                  />
                </ConnField>
                <ConnField label="API Key">
                  <SecretKeyInput
                    value={editingProvider.apiKey}
                    show={showEditProviderKey}
                    onChange={(apiKey) => setEditingProvider((f) => f && { ...f, apiKey })}
                    onToggleShow={() => setShowEditProviderKey((show) => !show)}
                  />
                </ConnField>
              </div>
              <DialogFooter>
                <Button variant="ghost" onClick={() => setEditingProvider(null)}>
                  <X />
                  取消
                </Button>
                <Button
                  variant="solid"
                  disabled={savingId === `edit-provider:${editingProvider.originalKey}`}
                  onClick={() => void saveEditedProvider()}
                >
                  {savingId === `edit-provider:${editingProvider.originalKey}` ? "保存中…" : "保存 provider"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ProviderModelCard({
  group,
  activeKey,
  savingId,
  controls,
  reasoningTargets,
  onSetActive,
  onSetReasoning,
  onRemoveModel,
  onClearProviderKey,
  onEditModel,
  onEditProvider,
  onRemoveProvider,
}: {
  group: ProviderGroup;
  activeKey: string;
  savingId: string | null;
  controls: Record<string, ReasoningControl | null>;
  reasoningTargets: Record<string, { kind: string; modelId: string; reasoning?: ReasoningSetting }>;
  onSetActive: (entry: ModelEntry) => void;
  onSetReasoning: (key: string, next: ReasoningSetting) => void;
  onRemoveModel: (entry: ModelEntry) => void;
  onClearProviderKey: (provider: ProviderEntry) => void;
  onEditModel: (entry: ModelEntry) => void;
  onEditProvider: (provider: ProviderEntry) => void;
  onRemoveProvider: (provider: ProviderEntry, models: ModelEntry[]) => void;
}) {
  const { provider, models } = group;
  const isActiveProvider = models.some((m) => m.key === activeKey);
  const meta = KIND_META[provider.kind];
  const hasStoredKey = Boolean(provider.apiKey) || models.some((m) => Boolean(m.apiKey));
  const configured = provider.kind === "ollama" || !meta.needsKey || hasStoredKey;
  const canClearKey = provider.key !== ORPHAN_PROVIDER && meta.needsKey && hasStoredKey;

  return (
    <ConnCard isDefault={isActiveProvider}>
      <header className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <strong className="text-sm font-medium text-foreground">
            {provider.label || meta.label}
          </strong>
          <span className="font-mono text-xs text-muted-foreground">#{provider.key}</span>
          {isActiveProvider && <Badge variant="accent">当前 provider</Badge>}
          <Badge variant={configured ? "secondary" : "warning"}>
            {configured ? "已配置" : "缺少 key"}
          </Badge>
        </div>
        {meta.keyUrl && (
          <Button
            variant="link"
            size="sm"
            className="h-auto shrink-0 p-0 text-xs"
            onClick={() => void window.codeshell.openExternal(meta.keyUrl!)}
          >
            获取 key
          </Button>
        )}
      </header>

      <div className="flex flex-col gap-2 text-xs text-muted-foreground">
        <div className="break-all font-mono">{provider.baseUrl || "No base URL"}</div>
        <div>{models.length > 0 ? `${models.length} 个模型实例` : "还没有模型实例"}</div>
      </div>

      <div className="flex flex-col gap-2">
        {models.length === 0 && (
          <div className="rounded-md border border-dashed border-border bg-background p-3 text-sm text-muted-foreground">
            这个 provider 没有模型。可以继续保留凭证，或直接删除 provider。
          </div>
        )}
        {models.map((model) => {
          const active = model.key === activeKey;
          const control = controls[model.key];
          const reasoning = reasoningTargets[model.key]?.reasoning;
          return (
            <div
              key={model.key}
              className={cn(
                "rounded-md border border-border bg-background p-3",
                active && "border-primary/50 ring-1 ring-primary/25",
              )}
            >
              <div className="flex flex-col gap-2">
                <div className="flex min-w-0 flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {model.label}
                      </span>
                      {active && <Badge variant="accent">active</Badge>}
                      {model.maxContextTokens && (
                        <Badge variant="secondary">{formatTok(model.maxContextTokens)} ctx</Badge>
                      )}
                      {model.maxOutputTokens && (
                        <Badge variant="secondary">{formatTok(model.maxOutputTokens)} out</Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <code className="font-mono">{model.key}</code>
                      <span>·</span>
                      <code className="break-all font-mono">{model.modelId}</code>
                    </div>
                  </div>
                  <Button
                    variant={active ? "secondary" : "default"}
                    size="sm"
                    disabled={
                      active ||
                      savingId === `active:${model.key}` ||
                      savingId === `delete:${model.key}`
                    }
                    onClick={() => onSetActive(model)}
                  >
                    {savingId === `active:${model.key}` ? "切换中…" : active ? "当前" : "设为当前"}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={savingId === `edit-model:${model.key}`}
                    onClick={() => onEditModel(model)}
                  >
                    编辑
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-status-err"
                    disabled={savingId === `delete:${model.key}`}
                    onClick={() => onRemoveModel(model)}
                  >
                    {savingId === `delete:${model.key}` ? "删除中…" : "删除"}
                  </Button>
                </div>

                {control && control.kind !== "none" && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2">
                    <span className="text-xs font-medium text-muted-foreground">思考</span>
                    {renderReasoningControl(
                      control,
                      reasoning,
                      savingId === `reasoning:${model.key}`,
                      (next) => onSetReasoning(model.key, next),
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ConnCardFooter>
        <Badge variant="secondary">{KIND_META[provider.kind].label}</Badge>
        <ConnFooterRight>
          {isActiveProvider && <Badge variant="accent">包含当前模型</Badge>}
          {provider.key !== ORPHAN_PROVIDER && (
            <Button
              variant="ghost"
              size="sm"
              disabled={savingId === `edit-provider:${provider.key}`}
              onClick={() => onEditProvider(provider)}
            >
              编辑
            </Button>
          )}
          {canClearKey && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-status-err"
              disabled={savingId === `clear-key:${provider.key}`}
              onClick={() => onClearProviderKey(provider)}
            >
              {savingId === `clear-key:${provider.key}` ? "清除中…" : "清除 key"}
            </Button>
          )}
          {provider.key !== ORPHAN_PROVIDER && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-status-err"
              disabled={savingId === `delete-provider:${provider.key}`}
              onClick={() => onRemoveProvider(provider, models)}
            >
              {savingId === `delete-provider:${provider.key}` ? "删除中…" : "删除 provider"}
            </Button>
          )}
        </ConnFooterRight>
      </ConnCardFooter>
    </ConnCard>
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

function editModelFormFromEntry(entry: ModelEntry): EditModelForm {
  return {
    originalKey: entry.key,
    key: entry.key,
    label: entry.label,
    providerKey: entry.providerKey,
    model: entry.modelId,
    baseUrl: entry.baseUrl ?? "",
    apiKey: entry.apiKey ?? "",
    maxContextTokens: entry.maxContextTokens != null ? String(entry.maxContextTokens) : "",
    maxOutputTokens: entry.maxOutputTokens != null ? String(entry.maxOutputTokens) : "",
  };
}

function editProviderFormFromEntry(provider: ProviderEntry): EditProviderForm {
  return {
    originalKey: provider.key,
    key: provider.key,
    label: provider.label ?? "",
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey ?? "",
    originalApiKey: provider.apiKey ?? "",
  };
}

function candidatesFrom(
  s: Record<string, unknown>,
  providers: ProviderEntry[],
): ModelEntry[] {
  const models = s.models;
  if (!Array.isArray(models)) return [];
  const out: ModelEntry[] = [];
  for (const m of models) {
    if (!m || typeof m !== "object") continue;
    const obj = m as Record<string, unknown>;
    const key = typeof obj.key === "string" ? obj.key :
                typeof obj.model === "string" ? obj.model : "";
    if (!key) continue;
    const providerKey = typeof obj.providerKey === "string" ? obj.providerKey :
                        typeof obj.provider === "string" ? obj.provider : "";
    const provider = providers.find((p) => p.key === providerKey);
    const modelId = typeof obj.model === "string" ? obj.model : key;
    out.push({
      key,
      label: typeof obj.label === "string" ? obj.label : modelId,
      providerKey,
      modelId,
      protocol: typeof obj.provider === "string"
        ? obj.provider
        : typeof obj.protocol === "string" ? obj.protocol : "",
      providerKind: provider?.kind ?? (obj.provider === "anthropic" ? "anthropic" : "custom"),
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : provider?.baseUrl,
      apiKey: typeof obj.apiKey === "string" ? obj.apiKey : provider?.apiKey,
      maxContextTokens: typeof obj.maxContextTokens === "number" ? obj.maxContextTokens : undefined,
      maxOutputTokens: typeof obj.maxOutputTokens === "number" ? obj.maxOutputTokens : undefined,
    });
  }
  return out;
}

function providerGroupsFrom(
  providers: ProviderEntry[],
  models: ModelEntry[],
): ProviderGroup[] {
  const grouped = providers.map((provider) => ({
    provider,
    models: models.filter((m) => m.providerKey === provider.key),
  }));
  const known = new Set(providers.map((p) => p.key));
  const orphans = models.filter((m) => !known.has(m.providerKey));
  if (orphans.length > 0) {
    grouped.push({
      provider: {
        key: ORPHAN_PROVIDER,
        label: "Unlinked models",
        kind: "custom",
        baseUrl: "",
      },
      models: orphans,
    });
  }
  return grouped;
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

function modelKeyOf(model: Record<string, unknown>): string {
  return typeof model.key === "string" ? model.key :
         typeof model.model === "string" ? model.model : "";
}

function modelProviderKeyOf(model: Record<string, unknown>): string {
  return typeof model.providerKey === "string" ? model.providerKey :
         typeof model.provider === "string" ? model.provider : "";
}

function withoutKey<T extends Record<string, unknown>>(obj: T, key: string): Record<string, unknown> {
  const { [key]: _removed, ...rest } = obj;
  void _removed;
  return rest;
}

function assignOptionalString(target: Record<string, unknown>, key: string, value: string): void {
  if (value) target[key] = value;
  else delete target[key];
}

function assignOptionalNumber(target: Record<string, unknown>, key: string, value: number | undefined): void {
  if (value != null) target[key] = value;
  else delete target[key];
}

function parseOptionalPositiveInt(value: string, label: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Math.floor(Number(trimmed));
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} 必须是正整数。`);
  return n;
}

function legacyModelPatch(
  entry: ModelEntry,
  rawModels: Array<Record<string, unknown>>,
  providers: ProviderEntry[],
): Record<string, unknown> {
  const raw = rawModels.find((m) => modelKeyOf(m) === entry.key);
  const provider = providers.find((p) => p.key === entry.providerKey);
  const protocol = typeof raw?.provider === "string"
    ? raw.provider
    : provider?.kind === "anthropic"
      ? "anthropic"
      : "openai";
  return {
    provider: protocol,
    name: typeof raw?.model === "string" ? raw.model : entry.modelId,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : provider?.apiKey ?? null,
    baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl : provider?.baseUrl ?? null,
  };
}

function legacyModelPatchByKey(
  key: string,
  rawModels: Array<Record<string, unknown>>,
  providers: ProviderEntry[],
): Record<string, unknown> {
  const raw = rawModels.find((m) => modelKeyOf(m) === key);
  const providerKey = raw ? modelProviderKeyOf(raw) : "";
  const provider = providers.find((p) => p.key === providerKey);
  const protocol = typeof raw?.provider === "string"
    ? raw.provider
    : provider?.kind === "anthropic"
      ? "anthropic"
      : "openai";
  return {
    provider: protocol,
    name: typeof raw?.model === "string" ? raw.model : key,
    apiKey: typeof raw?.apiKey === "string" ? raw.apiKey : provider?.apiKey ?? null,
    baseUrl: typeof raw?.baseUrl === "string" ? raw.baseUrl : provider?.baseUrl ?? null,
  };
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
      return (
        <Badge variant="secondary" className="whitespace-nowrap">
          自动思考(不可调)
        </Badge>
      );
    case "toggle": {
      const on = value ? value.mode !== "off" : control.default;
      return (
        <label className="flex items-center gap-2 text-xs text-foreground" title="思考">
          <Switch
            checked={on}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(checked ? { mode: "on" } : { mode: "off" })}
          />
          <span>思考</span>
        </label>
      );
    }
    case "effort": {
      type EffortValue = Extract<ReasoningSetting, { mode: "effort" }>["effort"];
      const current = value && value.mode === "effort" ? value.effort : control.default;
      return (
        <Select
          value={current}
          disabled={disabled}
          size="sm"
          className="w-[130px]"
          onChange={(v) => onChange({ mode: "effort", effort: v as EffortValue })}
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
        <label className="flex items-center gap-2 text-xs text-foreground" title="思考预算(tokens)">
          <span>预算</span>
          <Input
            type="number"
            min={control.min}
            step={1024}
            value={current}
            disabled={disabled}
            onChange={(e) => {
              const n = Math.max(control.min, Math.floor(Number(e.target.value) || control.min));
              onChange({ mode: "budget", budgetTokens: n });
            }}
            className="h-8 w-28"
          />
        </label>
      );
    }
  }
}
