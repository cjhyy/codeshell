/**
 * ProviderModelFlow — shared 4-step add-provider-and-models flow.
 *
 * Used by /login (OnboardingPrompt) and by ModelManager's a/A keys.
 * Both invocations are APPEND-ONLY. /logout is the way to clear.
 *
 * Steps: kind → key → fetch+pick → alias+(active?) → onFinish.
 */
import { useEffect, useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import { PROVIDER_KINDS, type ProviderKindName } from "../../llm/provider-kinds.js";
import { fetchModelList, type FetchResult } from "../../llm/model-fetcher.js";
import { defaultCacheDir } from "../../llm/model-cache.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";
import type { CachedModel } from "../../llm/model-cache.js";

export interface EnvKeyHint {
  envKey: string;
  apiKey: string;
  kindHint: ProviderKindName;
}

export interface FlowResult {
  addedProvider?: ProviderConfig;
  addedModels: Array<{
    key: string;
    providerKey: string;
    model: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  }>;
  activeModelKey?: string;
}

export interface ProviderModelFlowProps {
  existingProviders: ProviderConfig[];
  existingModelKeys: string[];
  detectedEnvKeys?: EnvKeyHint[];
  switchToNewModelOnFinish: boolean;
  onFinish: (r: FlowResult) => void;
  onCancel: () => void;
}

// ─── Pure helpers (exported for testing) ──────────────────────────

export function deriveModelAlias(modelId: string, used: string[]): string {
  let base = modelId.split("/").pop() ?? modelId;
  base = base.replace(/^deepseek-/, "");
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}

export function deriveProviderKey(kindOrUrl: string, used: string[]): string {
  let base = kindOrUrl;
  // Treat URL-like input (contains :// or .) as custom — derive from host
  if (/^https?:\/\//.test(kindOrUrl) || kindOrUrl.includes(".")) {
    const host = kindOrUrl.replace(/^https?:\/\//, "").split("/")[0] ?? "custom";
    base = host
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .replace(/^-+|-+$/g, "");
  }
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}

export function validateAlias(alias: string, used: string[]): string | null {
  if (!alias) return "Alias cannot be empty";
  if (/\s/.test(alias)) return "Alias must not contain whitespace";
  if (used.includes(alias)) return "Alias already used";
  return null;
}

// ─── Component ────────────────────────────────────────────────────

type Step = "kind" | "key" | "baseUrl" | "fetch" | "alias";

interface KindEntry {
  type: "existing" | "env" | "kind";
  label: string;
  hint?: string;
  providerIdx?: number;
  envIdx?: number;
  kind?: ProviderKindName;
}

// Friendly labels + ordering. Mirrors the old onboarding's PROVIDERS array.
// OpenRouter first because it unlocks all models with one key.
const KIND_ORDER: ProviderKindName[] = [
  "openrouter",
  "anthropic",
  "openai",
  "deepseek",
  "xai",
  "google",
  "mistral",
  "groq",
  "ollama",
  "custom",
];
const KIND_LABEL_OVERRIDES: Partial<Record<ProviderKindName, string>> = {
  openrouter: "OpenRouter (推荐 — 支持所有模型)",
  anthropic: "Anthropic (直连 Claude API)",
  openai: "OpenAI",
  deepseek: "DeepSeek (官方直连)",
  xai: "xAI (Grok)",
  google: "Google Gemini",
  mistral: "Mistral",
  groq: "Groq",
  ollama: "Ollama (本地,无需 key)",
  custom: "自定义 (OpenAI-兼容)",
};
const KIND_KEY_URLS: Partial<Record<ProviderKindName, string>> = {
  openrouter: "https://openrouter.ai/keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
  deepseek: "https://platform.deepseek.com/api_keys",
  xai: "https://console.x.ai",
  google: "https://aistudio.google.com/apikey",
  mistral: "https://console.mistral.ai/api-keys",
  groq: "https://console.groq.com/keys",
};

function maskKey(k: string): string {
  if (k.length <= 8) return "••••";
  return `${k.slice(0, 4)}••••${k.slice(-4)}`;
}

export function ProviderModelFlow({
  existingProviders,
  existingModelKeys,
  detectedEnvKeys = [],
  switchToNewModelOnFinish,
  onFinish,
  onCancel,
}: ProviderModelFlowProps) {
  // Build the kind-step menu in the priority order from the legacy onboarding:
  //   1. Env-detected keys (one-click "use $OPENROUTER_API_KEY")
  //   2. Already-configured providers ("Use existing")
  //   3. All provider kinds, OpenRouter first
  const kindEntries: KindEntry[] = [
    ...detectedEnvKeys.map((d, i) => ({
      type: "env" as const,
      label: `使用环境变量 ${d.envKey} → ${KIND_LABEL_OVERRIDES[d.kindHint] ?? PROVIDER_KINDS[d.kindHint]?.label ?? d.kindHint}`,
      hint: `(${maskKey(d.apiKey)})`,
      envIdx: i,
    })),
    ...existingProviders.map((p, i) => ({
      type: "existing" as const,
      label: `使用已有: ${p.label ?? p.key}`,
      hint: `(${p.kind})`,
      providerIdx: i,
    })),
    ...KIND_ORDER.map((k) => ({
      type: "kind" as const,
      label: KIND_LABEL_OVERRIDES[k] ?? PROVIDER_KINDS[k]?.label ?? k,
      kind: k,
    })),
  ];

  const existingProviderKeys = existingProviders.map((p) => p.key);

  const [step, setStep] = useState<Step>("kind");
  const [kindIdx, setKindIdx] = useState(0);
  const [useExistingProvider, setUseExistingProvider] = useState<ProviderConfig | undefined>();
  const [selectedKind, setSelectedKind] = useState<ProviderKindName>("openai");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [keyMenuIdx, setKeyMenuIdx] = useState(0); // 0 = use env, 1 = paste new
  const [keyMenuDone, setKeyMenuDone] = useState(false);

  // fetch step
  const [fetchResult, setFetchResult] = useState<FetchResult | undefined>();
  const [fetchLoading, setFetchLoading] = useState(false);
  const [modelIdx, setModelIdx] = useState(0);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pickOrder, setPickOrder] = useState<string[]>([]);
  const [manualMode, setManualMode] = useState(false);
  const [manualId, setManualId] = useState("");

  // alias step
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasFocus, setAliasFocus] = useState(0);
  const [activeIdx, setActiveIdx] = useState(0);
  const [activePickerFocused, setActivePickerFocused] = useState(false);

  const envHintForKind = (kind: ProviderKindName): EnvKeyHint | undefined =>
    detectedEnvKeys.find((e) => e.kindHint === kind);

  // ─── fetch on step entry ────────────────────────────────────────
  useEffect(() => {
    if (step !== "fetch") return;
    if (fetchResult || fetchLoading) return;
    void runFetch(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  async function runFetch(refresh: boolean): Promise<void> {
    setFetchLoading(true);
    const provider = useExistingProvider
      ? {
          key: useExistingProvider.key,
          kind: useExistingProvider.kind,
          baseUrl: useExistingProvider.baseUrl,
          apiKey: useExistingProvider.apiKey,
          ...(useExistingProvider.modelsPath ? { modelsPath: useExistingProvider.modelsPath } : {}),
        }
      : {
          key: deriveProviderKey(
            selectedKind === "custom" ? baseUrl : selectedKind,
            existingProviderKeys,
          ),
          kind: selectedKind,
          baseUrl,
          apiKey,
        };
    const res = await fetchModelList(provider, {
      cacheDir: defaultCacheDir(),
      refresh,
    });
    setFetchResult(res);
    setFetchLoading(false);
  }

  // ─── transition into alias step (init alias values) ─────────────
  function enterAliasStep(pickedModels: CachedModel[]): void {
    const aliasesInit: string[] = [];
    const used = [...existingModelKeys];
    for (const m of pickedModels) {
      const a = deriveModelAlias(m.id, used);
      aliasesInit.push(a);
      used.push(a);
    }
    setAliases(aliasesInit);
    setAliasFocus(0);
    setActiveIdx(0);
    setActivePickerFocused(false);
    setStep("alias");
  }

  function getPickedModels(): CachedModel[] {
    if (!fetchResult) return [];
    const map = new Map(fetchResult.models.map((m) => [m.id, m]));
    return pickOrder
      .map((id) => map.get(id))
      .filter((m): m is CachedModel => m !== undefined);
  }

  function aliasUsedSet(excludeIdx: number): string[] {
    const others = aliases.filter((_, i) => i !== excludeIdx);
    return [...existingModelKeys, ...others];
  }

  function allAliasesValid(): boolean {
    return aliases.every((a, i) => validateAlias(a, aliasUsedSet(i)) === null);
  }

  function commitFinish(): void {
    const pickedModels = getPickedModels();
    if (pickedModels.length === 0) return;
    if (!allAliasesValid()) return;

    const newProvider: ProviderConfig | undefined = useExistingProvider
      ? undefined
      : {
          key: deriveProviderKey(
            selectedKind === "custom" ? baseUrl : selectedKind,
            existingProviderKeys,
          ),
          kind: selectedKind,
          baseUrl,
          apiKey: selectedKind === "ollama" ? undefined : apiKey,
          label: PROVIDER_KINDS[selectedKind].label,
        };
    const providerKey = useExistingProvider?.key ?? newProvider!.key;
    const addedModels = pickedModels.map((m, i) => ({
      key: aliases[i]!,
      providerKey,
      model: m.id,
      maxContextTokens: m.contextLength || undefined,
      maxOutputTokens: m.maxOutputTokens || undefined,
    }));
    onFinish({
      addedProvider: newProvider,
      addedModels,
      activeModelKey: switchToNewModelOnFinish ? aliases[activeIdx] : undefined,
    });
  }

  // ─── input handling ─────────────────────────────────────────────
  useInput((input, key) => {
    if (key.escape) return onCancel();

    if (step === "kind") {
      if (key.upArrow) setKindIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setKindIdx((i) => Math.min(kindEntries.length - 1, i + 1));
      else if (key.return) {
        const entry = kindEntries[kindIdx];
        if (!entry) return;
        if (entry.type === "existing") {
          const provider = existingProviders[entry.providerIdx!]!;
          setUseExistingProvider(provider);
          setStep("fetch");
        } else if (entry.type === "env") {
          const env = detectedEnvKeys[entry.envIdx!]!;
          setSelectedKind(env.kindHint);
          setApiKey(env.apiKey);
          setBaseUrl(PROVIDER_KINDS[env.kindHint].defaultBaseUrl);
          setStep("fetch");
        } else {
          const kind = entry.kind!;
          setSelectedKind(kind);
          setBaseUrl(PROVIDER_KINDS[kind].defaultBaseUrl);
          setKeyMenuDone(false);
          setKeyMenuIdx(0);
          if (kind === "ollama") {
            setApiKey("");
            setStep("fetch");
          } else {
            setStep("key");
          }
        }
      }
      return;
    }

    if (step === "key") {
      const hint = envHintForKind(selectedKind);
      // env-key picker first
      if (hint && !keyMenuDone) {
        if (key.upArrow) setKeyMenuIdx(0);
        else if (key.downArrow) setKeyMenuIdx(1);
        else if (key.return) {
          if (keyMenuIdx === 0) {
            setApiKey(hint.apiKey);
            // skip text input — go to next step
            if (selectedKind === "custom") setStep("baseUrl");
            else setStep("fetch");
          } else {
            setKeyMenuDone(true);
          }
        }
        return;
      }
      // text input
      if (key.backspace || key.delete) setApiKey((s) => s.slice(0, -1));
      else if (key.return) {
        if (selectedKind === "custom") setStep("baseUrl");
        else setStep("fetch");
      } else if (input && !key.ctrl) setApiKey((s) => s + input);
      return;
    }

    if (step === "baseUrl") {
      if (key.backspace || key.delete) setBaseUrl((s) => s.slice(0, -1));
      else if (key.return) setStep("fetch");
      else if (input && !key.ctrl) setBaseUrl((s) => s + input);
      return;
    }

    if (step === "fetch") {
      if (manualMode) {
        if (key.backspace || key.delete) setManualId((s) => s.slice(0, -1));
        else if (key.return && manualId) {
          // Synthesize a CachedModel and advance
          const fake: CachedModel = {
            id: manualId,
            contextLength: 0,
            maxOutputTokens: 0,
          };
          // inject into the fetchResult so getPickedModels works
          setFetchResult((prev) => ({
            fetchedAt: prev?.fetchedAt ?? new Date().toISOString(),
            providerKey: prev?.providerKey ?? "",
            models: [...(prev?.models ?? []), fake],
            ...(prev?.error ? { error: prev.error } : {}),
            ...(prev?.fromCache ? { fromCache: prev.fromCache } : {}),
          }));
          const newPicked = new Set(picked);
          newPicked.add(manualId);
          setPicked(newPicked);
          const newOrder = [...pickOrder, manualId];
          setPickOrder(newOrder);
          enterAliasStep([...getPickedModels(), fake]);
        } else if (input && !key.ctrl) setManualId((s) => s + input);
        return;
      }

      if (input === "r") {
        setFetchResult(undefined);
        void runFetch(true);
        return;
      }
      if (input === "m") {
        setManualMode(true);
        return;
      }
      if (!fetchResult || fetchLoading) return;
      if (fetchResult.models.length === 0) return;

      if (key.upArrow) setModelIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow)
        setModelIdx((i) => Math.min(fetchResult.models.length - 1, i + 1));
      else if (input === " ") {
        const m = fetchResult.models[modelIdx];
        if (!m) return;
        const next = new Set(picked);
        if (next.has(m.id)) {
          next.delete(m.id);
          setPickOrder((order) => order.filter((id) => id !== m.id));
        } else {
          next.add(m.id);
          setPickOrder((order) => [...order, m.id]);
        }
        setPicked(next);
      } else if (key.return && picked.size > 0) {
        enterAliasStep(getPickedModels());
      }
      return;
    }

    if (step === "alias") {
      const numFields = aliases.length;
      const activePickerVisible = switchToNewModelOnFinish && numFields > 0;
      const totalFocusable = numFields + (activePickerVisible ? 1 : 0);

      if (key.tab) {
        const next = (aliasFocus + 1) % totalFocusable;
        setAliasFocus(next);
        setActivePickerFocused(activePickerVisible && next === numFields);
        return;
      }
      if (key.downArrow) {
        if (activePickerFocused && activePickerVisible) {
          setActiveIdx((i) => Math.min(numFields - 1, i + 1));
        } else {
          const next = Math.min(totalFocusable - 1, aliasFocus + 1);
          setAliasFocus(next);
          setActivePickerFocused(activePickerVisible && next === numFields);
        }
        return;
      }
      if (key.upArrow) {
        if (activePickerFocused && activePickerVisible) {
          setActiveIdx((i) => Math.max(0, i - 1));
        } else {
          const next = Math.max(0, aliasFocus - 1);
          setAliasFocus(next);
          setActivePickerFocused(activePickerVisible && next === numFields);
        }
        return;
      }

      if (activePickerFocused) {
        if (key.return && allAliasesValid()) commitFinish();
        return;
      }

      // editing the focused alias
      if (key.backspace || key.delete) {
        setAliases((arr) => {
          const copy = [...arr];
          copy[aliasFocus] = (copy[aliasFocus] ?? "").slice(0, -1);
          return copy;
        });
      } else if (key.return) {
        if (allAliasesValid()) commitFinish();
      } else if (input && !key.ctrl) {
        setAliases((arr) => {
          const copy = [...arr];
          copy[aliasFocus] = (copy[aliasFocus] ?? "") + input;
          return copy;
        });
      }
      return;
    }
  });

  // ─── render ─────────────────────────────────────────────────────
  const title = useExistingProvider ? "✦ 添加模型" : "✦ 添加 provider + 模型";

  return (
    <Box flexDirection="column" marginLeft={1}>
      <Box>
        <Text color="cyan" bold>{title}</Text>
        <Text dimColor>  (Esc 取消)</Text>
      </Box>

      {step === "kind" && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>选择 API 提供商:</Text>
          {kindEntries.map((e, i) => (
            <Box key={`${e.type}-${i}`}>
              <Text color={i === kindIdx ? "cyan" : undefined} bold={i === kindIdx}>
                {i === kindIdx ? "❯ " : "  "}
                {e.label}
              </Text>
              {e.hint && <Text dimColor> {e.hint}</Text>}
            </Box>
          ))}
        </Box>
      )}

      {step === "key" &&
        (() => {
          const hint = envHintForKind(selectedKind);
          const showMenu = hint && !keyMenuDone;
          const friendlyName = KIND_LABEL_OVERRIDES[selectedKind] ?? PROVIDER_KINDS[selectedKind].label;
          const keyUrl = KIND_KEY_URLS[selectedKind];
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>{friendlyName}</Text>
              {keyUrl && <Text dimColor>获取 Key: {keyUrl}</Text>}
              {showMenu ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={keyMenuIdx === 0 ? "cyan" : undefined} bold={keyMenuIdx === 0}>
                    {keyMenuIdx === 0 ? "❯ " : "  "}
                    使用环境变量 ${hint!.envKey} ({maskKey(hint!.apiKey)})
                  </Text>
                  <Text color={keyMenuIdx === 1 ? "cyan" : undefined} bold={keyMenuIdx === 1}>
                    {keyMenuIdx === 1 ? "❯ " : "  "}
                    粘贴新 key
                  </Text>
                </Box>
              ) : (
                <Box flexDirection="column" marginTop={1}>
                  <Text>API Key: <Text color="cyan">{apiKey.replace(/./g, "•")}</Text></Text>
                  <Text dimColor>粘贴你的 API Key,Enter 确认</Text>
                </Box>
              )}
            </Box>
          );
        })()}

      {step === "baseUrl" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Base URL (with /v1):</Text>
          <Text color="cyan">{baseUrl}</Text>
          <Text dimColor>Enter when done.</Text>
        </Box>
      )}

      {step === "fetch" && (
        <Box flexDirection="column" marginTop={1}>
          {fetchLoading && <Text dimColor>Loading…</Text>}
          {!fetchLoading && fetchResult?.error && fetchResult.models.length === 0 && (
            <Box flexDirection="column">
              <Text color="red">Error: {fetchResult.error}</Text>
              <Text dimColor>Press r to retry · m for manual id · Esc to cancel</Text>
            </Box>
          )}
          {!fetchLoading && fetchResult && fetchResult.models.length > 0 && !manualMode && (
            <Box flexDirection="column">
              <Text dimColor>
                Pick models (Space to toggle, Enter when done) — {picked.size} selected
              </Text>
              {fetchResult.fromCache && (
                <Text dimColor>
                  Cached at {new Date(fetchResult.fetchedAt).toLocaleString()} · press r to refresh
                </Text>
              )}
              {fetchResult.models
                .slice(Math.max(0, modelIdx - 8), modelIdx + 9)
                .map((m, i) => {
                  const realIdx = Math.max(0, modelIdx - 8) + i;
                  const checked = picked.has(m.id);
                  return (
                    <Text key={m.id} color={realIdx === modelIdx ? "cyan" : undefined}>
                      {realIdx === modelIdx ? "› " : "  "}
                      [{checked ? "x" : " "}] {m.id}
                      {m.contextLength ? (
                        <Text dimColor>  ({m.contextLength.toLocaleString()} ctx)</Text>
                      ) : null}
                    </Text>
                  );
                })}
            </Box>
          )}
          {manualMode && (
            <Box flexDirection="column">
              <Text>Manual model id:</Text>
              <Text color="cyan">{manualId}</Text>
              <Text dimColor>Enter when done.</Text>
            </Box>
          )}
        </Box>
      )}

      {step === "alias" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Local alias for each model:</Text>
          {getPickedModels().map((m, i) => {
            const err = validateAlias(aliases[i] ?? "", aliasUsedSet(i));
            const focused = !activePickerFocused && i === aliasFocus;
            return (
              <Box key={m.id} flexDirection="column" marginTop={1}>
                <Text dimColor>{m.id}</Text>
                <Text color={focused ? "cyan" : undefined}>
                  {focused ? "› " : "  "}
                  {aliases[i] ?? ""}
                </Text>
                {focused && err && <Text color="red">{err}</Text>}
                {!focused && err && <Text color="red" dimColor>{err}</Text>}
              </Box>
            );
          })}
          {switchToNewModelOnFinish && aliases.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text>Which becomes active? ↑↓</Text>
              {aliases.map((a, i) => (
                <Text
                  key={`active-${i}`}
                  color={activePickerFocused && i === activeIdx ? "cyan" : undefined}
                >
                  {activePickerFocused && i === activeIdx ? "› " : "  "}
                  {i === activeIdx ? "(•) " : "( ) "}
                  {a}
                </Text>
              ))}
            </Box>
          )}
          <Text dimColor>Tab/↓ to next field · Enter to finish</Text>
        </Box>
      )}
    </Box>
  );
}
