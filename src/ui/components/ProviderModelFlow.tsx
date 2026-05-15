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
import TextInput from "./TextInput.js";
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
  /**
   * Self-describing model entries — credentials are duplicated from the
   * provider on purpose. The engine reads these without a ProviderCatalog
   * round-trip; providers[] is kept only as a credential source for the
   * wizard's future "add model to existing provider" flow.
   */
  addedModels: Array<{
    key: string;
    label?: string;
    providerKey: string;
    /** LLM client/protocol ("openai"/"anthropic"). */
    protocol: string;
    /** Legacy mirror of `protocol` for downstream readers that still query it. */
    provider: string;
    model: string;
    baseUrl: string;
    apiKey?: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  }>;
  activeModelKey?: string;
}

export interface ProviderModelFlowProps {
  existingProviders: ProviderConfig[];
  existingModelKeys: string[];
  /**
   * Model ids (e.g. "deepseek-v4-pro") already present in settings.models[]
   * under SOME provider. The fetch step uses this to disable rows for
   * models the user has already added — keeps the menu informative (shows
   * the full catalog) without letting the user re-add duplicates that
   * appendOnboardingResult would silently drop.
   */
  existingModelIds?: string[];
  detectedEnvKeys?: EnvKeyHint[];
  switchToNewModelOnFinish: boolean;
  onFinish: (r: FlowResult) => void;
  onCancel: () => void;
}

// ─── Pure helpers (exported for testing) ──────────────────────────

/**
 * Pool-key generator for wizard-added models. Format is `provider-model` so
 * the alias self-identifies (e.g. "deepseek-v4-pro", not just "v4-pro" or
 * "deepseek"). Collisions get a numeric suffix.
 *
 * If the model id already starts with `<provider>-`, we don't duplicate.
 */
export function deriveModelAlias(
  modelId: string,
  used: string[],
  providerKind = "",
): string {
  const slash = modelId.lastIndexOf("/");
  const base = slash >= 0 ? modelId.slice(slash + 1) : modelId;
  const prefix = providerKind.toLowerCase();
  const candidate =
    prefix && !base.toLowerCase().startsWith(`${prefix}-`) ? `${prefix}-${base}` : base;
  const set = new Set(used);
  if (!set.has(candidate)) return candidate;
  for (let i = 2; ; i++) {
    const k = `${candidate}-${i}`;
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
  type: "kind";
  label: string;
  kind: ProviderKindName;
}

// Friendly labels + ordering. Mirrors the old onboarding's PROVIDERS array.
// OpenRouter first because it unlocks all models with one key.
const KIND_ORDER: ProviderKindName[] = [
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
const KIND_LABEL_OVERRIDES: Partial<Record<ProviderKindName, string>> = {
  openrouter: "OpenRouter (推荐 — 支持所有模型)",
  anthropic: "Anthropic (直连 Claude API)",
  openai: "OpenAI",
  deepseek: "DeepSeek (官方直连)",
  zai: "Z.AI (GLM 官方)",
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
  zai: "https://z.ai/manage-apikey/apikey-list",
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
  existingModelIds = [],
  detectedEnvKeys = [],
  switchToNewModelOnFinish,
  onFinish,
  onCancel,
}: ProviderModelFlowProps) {
  const existingModelIdSet = new Set(existingModelIds);
  // Kind step is now PURE category selection — no env-var or "use existing"
  // shortcuts at this level. Those are credential choices, not category
  // choices, and surface in the key step instead so the UX is:
  //   1. "Which kind of provider?"  (kind step)
  //   2. "Which credentials?"        (key step — existing provider / env / paste)
  const kindEntries: KindEntry[] = KIND_ORDER.map((k) => ({
    type: "kind" as const,
    label: KIND_LABEL_OVERRIDES[k] ?? PROVIDER_KINDS[k]?.label ?? k,
    kind: k,
  }));

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

  // Existing providers whose `kind` matches the just-selected category. These
  // become "Use existing" rows in the key step, so the user doesn't have to
  // re-enter credentials for a provider they already saved.
  const matchingExistingProviders = (kind: ProviderKindName): ProviderConfig[] =>
    existingProviders.filter((p) => p.kind === kind);

  // Credential-choice rows shown in the key step. Order:
  //   1. Use existing provider (one row per matching saved provider)
  //   2. Use detected env var (if any)
  //   3. Paste a new key (always available as a fallback)
  type KeyChoice =
    | { type: "existing"; provider: ProviderConfig }
    | { type: "env"; hint: EnvKeyHint }
    | { type: "paste" };
  const keyChoicesFor = (kind: ProviderKindName): KeyChoice[] => {
    const rows: KeyChoice[] = matchingExistingProviders(kind).map((p) => ({
      type: "existing",
      provider: p,
    }));
    const hint = envHintForKind(kind);
    if (hint) rows.push({ type: "env", hint });
    rows.push({ type: "paste" });
    return rows;
  };

  // ─── fetch on step entry ────────────────────────────────────────
  // Onboarding always fetches fresh: the user just configured an API key
  // and expects to see the live catalog (e.g. newly released models).
  // Caches are for `/model` browsing later, not for the first-look picker.
  useEffect(() => {
    if (step !== "fetch") return;
    if (fetchResult || fetchLoading) return;
    void runFetch(true);
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
    // For existing-provider branch, use that provider's kind; for new-provider,
    // use the kind the user picked. Custom defaults to empty prefix so the
    // user keeps full control over the alias (model id stays as-is).
    const kind = useExistingProvider?.kind ?? (selectedKind === "custom" ? "" : selectedKind);
    for (const m of pickedModels) {
      const a = deriveModelAlias(m.id, used, kind);
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
    // Resolve credentials to embed in each model entry. Self-describing
    // model entries mean the engine doesn't need a ProviderCatalog lookup
    // at runtime, and `cat settings.json` is enough to debug a config.
    // providers[] is still kept as a credential source for the wizard.
    const effectiveBaseUrl = useExistingProvider?.baseUrl ?? newProvider!.baseUrl;
    const effectiveApiKey = useExistingProvider?.apiKey ?? newProvider!.apiKey;
    const effectiveKind = useExistingProvider?.kind ?? selectedKind;
    // Pick the LLM client/protocol. Only anthropic uses its own SDK;
    // everything else (DeepSeek, OpenAI, OpenRouter, Mistral, ...) speaks
    // OpenAI-compatible JSON. Settings.json carries both `protocol` (new
    // canonical name) and `provider` (legacy mirror for engine readers).
    const protocol = effectiveKind === "anthropic" ? "anthropic" : "openai";

    const addedModels = pickedModels.map((m, i) => ({
      key: aliases[i]!,
      label: m.id,
      providerKey,
      protocol,
      provider: protocol, // legacy mirror — see schema transform
      model: m.id,
      baseUrl: effectiveBaseUrl,
      apiKey: effectiveApiKey,
      maxContextTokens: m.contextLength && m.contextLength > 0 ? m.contextLength : undefined,
      maxOutputTokens: m.maxOutputTokens && m.maxOutputTokens > 0 ? m.maxOutputTokens : undefined,
    }));
    onFinish({
      addedProvider: newProvider,
      addedModels,
      activeModelKey: switchToNewModelOnFinish ? aliases[activeIdx] : undefined,
    });
  }

  // ─── input handling ─────────────────────────────────────────────
  useInput((input, key) => {
    // Esc behaves as "back one step", not "exit the whole wizard". Only the
    // first step (kind) cancels outright. Inside multi-state steps (e.g. the
    // key step's text-input sub-state, or fetch's manual-id mode) Esc backs
    // out of that sub-state first.
    if (key.escape) {
      if (step === "kind") {
        onCancel();
        return;
      }
      if (step === "key") {
        // If we're in the paste-text sub-state, back to the credential menu.
        // Otherwise we're already on the menu — back to the kind step.
        if (keyMenuDone) {
          setKeyMenuDone(false);
          setApiKey("");
        } else {
          setStep("kind");
        }
        return;
      }
      if (step === "baseUrl") {
        setStep("key");
        return;
      }
      if (step === "fetch") {
        if (manualMode) {
          setManualMode(false);
          setManualId("");
          return;
        }
        // Reusing an existing provider skips the key step entirely, so the
        // natural "back" target is the kind step. Likewise for Ollama (no
        // credentials needed). Otherwise back to the credential menu.
        if (useExistingProvider || selectedKind === "ollama") {
          setUseExistingProvider(undefined);
          setStep("kind");
        } else {
          setKeyMenuDone(false);
          setStep("key");
        }
        return;
      }
      if (step === "alias") {
        setStep("fetch");
        return;
      }
      return;
    }

    if (step === "kind") {
      if (key.upArrow) setKindIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setKindIdx((i) => Math.min(kindEntries.length - 1, i + 1));
      else if (key.return) {
        const entry = kindEntries[kindIdx];
        if (!entry) return;
        const kind = entry.kind!;
        setSelectedKind(kind);
        setBaseUrl(PROVIDER_KINDS[kind].defaultBaseUrl);
        setKeyMenuIdx(0);
        if (kind === "ollama") {
          // Local Ollama needs no credentials at all — skip the key step.
          setApiKey("");
          setUseExistingProvider(undefined);
          setStep("fetch");
          return;
        }
        // If the only credential choice is "paste new key" (no existing
        // provider of this kind, no env hint), skip the one-item menu and
        // jump straight into the text input — saves one Enter press.
        const rows = keyChoicesFor(kind);
        const onlyPaste = rows.length === 1 && rows[0]?.type === "paste";
        setKeyMenuDone(onlyPaste);
        setStep("key");
      }
      return;
    }

    if (step === "key") {
      // Credential-choice menu first. The text-input branch is rendered with
      // <TextInput>, which owns its own keys, so we only handle navigation
      // for the menu itself.
      if (!keyMenuDone) {
        const rows = keyChoicesFor(selectedKind);
        if (rows.length === 0) return;
        if (key.upArrow) setKeyMenuIdx((i) => Math.max(0, i - 1));
        else if (key.downArrow) setKeyMenuIdx((i) => Math.min(rows.length - 1, i + 1));
        else if (key.return) {
          const chosen = rows[keyMenuIdx];
          if (!chosen) return;
          if (chosen.type === "existing") {
            // Reuse a saved provider's credentials directly — skip straight
            // to model fetch. baseUrl/apiKey come from the existing record.
            setUseExistingProvider(chosen.provider);
            setStep("fetch");
          } else if (chosen.type === "env") {
            setApiKey(chosen.hint.apiKey);
            if (selectedKind === "custom") setStep("baseUrl");
            else setStep("fetch");
          } else {
            // "Paste new key" — fall through to the TextInput on next render.
            setKeyMenuDone(true);
          }
        }
      }
      return;
    }

    if (step === "baseUrl") {
      // baseUrl text-input handled by <TextInput> in the render block.
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
        // Already in settings.models[] — silently ignore the toggle so the
        // user can't queue up duplicates that appendOnboardingResult would
        // discard later anyway.
        if (existingModelIdSet.has(m.id)) return;
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
        <Text color="ansi:cyan" bold>{title}</Text>
        <Text dim>{"  (Esc 取消)"}</Text>
      </Box>

      {step === "kind" && (
        <Box flexDirection="column" marginTop={1}>
          <Text dim>选择 API 提供商:</Text>
          {kindEntries.map((e, i) => (
            <Box key={e.kind}>
              <Text color={i === kindIdx ? "ansi:cyan" : undefined} bold={i === kindIdx}>
                {i === kindIdx ? "❯ " : "  "}
                {e.label}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {step === "key" &&
        (() => {
          const friendlyName = KIND_LABEL_OVERRIDES[selectedKind] ?? PROVIDER_KINDS[selectedKind].label;
          const keyUrl = KIND_KEY_URLS[selectedKind];
          const rows = keyChoicesFor(selectedKind);
          // If the user picked "Paste new key", we're in the text-input
          // sub-state — render the TextInput. Otherwise render the
          // credential-choice menu.
          const showMenu = !keyMenuDone;
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text dim>{friendlyName}</Text>
              {keyUrl && <Text dim>获取 Key: {keyUrl}</Text>}
              {showMenu ? (
                <Box flexDirection="column" marginTop={1}>
                  {rows.map((row, i) => {
                    const focused = i === keyMenuIdx;
                    const prefix = focused ? "❯ " : "  ";
                    if (row.type === "existing") {
                      return (
                        <Box key={`existing-${row.provider.key}`}>
                          <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                            {prefix}使用已有: {row.provider.label ?? row.provider.key}
                          </Text>
                          <Text dim>{`  (${row.provider.kind})`}</Text>
                        </Box>
                      );
                    }
                    if (row.type === "env") {
                      return (
                        <Box key={`env-${row.hint.envKey}`}>
                          <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                            {prefix}使用环境变量 ${row.hint.envKey}
                          </Text>
                          <Text dim>{`  (${maskKey(row.hint.apiKey)})`}</Text>
                        </Box>
                      );
                    }
                    return (
                      <Box key="paste">
                        <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                          {prefix}粘贴新 key
                        </Text>
                      </Box>
                    );
                  })}
                </Box>
              ) : (
                <Box marginTop={1}>
                  <Text color="ansi:cyan">API Key: </Text>
                  <TextInput
                    value={apiKey}
                    onChange={setApiKey}
                    onSubmit={() => {
                      if (selectedKind === "custom") setStep("baseUrl");
                      else setStep("fetch");
                    }}
                    placeholder="粘贴你的 API Key, Enter 确认"
                    focus
                  />
                </Box>
              )}
            </Box>
          );
        })()}

      {step === "baseUrl" && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text color="ansi:cyan">Base URL: </Text>
            <TextInput
              value={baseUrl}
              onChange={setBaseUrl}
              onSubmit={() => setStep("fetch")}
              placeholder="含 /v1, Enter 确认"
              focus
            />
          </Box>
        </Box>
      )}

      {step === "fetch" && (
        <Box flexDirection="column" marginTop={1}>
          {fetchLoading && <Text dim>Loading…</Text>}
          {!fetchLoading && fetchResult?.error && fetchResult.models.length === 0 && (
            <Box flexDirection="column">
              <Text color="red">Error: {fetchResult.error}</Text>
              <Text dim>Press r to retry · m for manual id · Esc to cancel</Text>
            </Box>
          )}
          {!fetchLoading && fetchResult && fetchResult.models.length > 0 && !manualMode && (
            <Box flexDirection="column">
              <Text dim>
                Pick models (Space to toggle, Enter when done) — {picked.size} selected
                {existingModelIds.length > 0
                  ? ` · ${existingModelIds.length} 已添加 (灰色不可选)`
                  : ""}
              </Text>
              {fetchResult.fromCache && (
                <Text dim>
                  Cached at {new Date(fetchResult.fetchedAt).toLocaleString()} · press r to refresh
                </Text>
              )}
              {fetchResult.models
                .slice(Math.max(0, modelIdx - 8), modelIdx + 9)
                .map((m, i) => {
                  const realIdx = Math.max(0, modelIdx - 8) + i;
                  const checked = picked.has(m.id);
                  const alreadyAdded = existingModelIdSet.has(m.id);
                  // Already in settings.models[]: dim, locked checkbox,
                  // "(已添加)" tag. Cursor can still land here so the user
                  // can see why the row isn't selectable.
                  if (alreadyAdded) {
                    return (
                      <Box key={m.id}>
                        <Text dim>
                          {realIdx === modelIdx ? "› " : "  "}
                          [✓] {m.id}
                          {m.contextLength ? `  (${m.contextLength.toLocaleString()} ctx)` : ""}
                          {"  (已添加)"}
                        </Text>
                      </Box>
                    );
                  }
                  return (
                    <Text key={m.id} color={realIdx === modelIdx ? "ansi:cyan" : undefined}>
                      {realIdx === modelIdx ? "› " : "  "}
                      [{checked ? "x" : " "}] {m.id}
                      {m.contextLength ? (
                        <Text dim>  ({m.contextLength.toLocaleString()} ctx)</Text>
                      ) : null}
                    </Text>
                  );
                })}
            </Box>
          )}
          {manualMode && (
            <Box flexDirection="column">
              <Text>Manual model id:</Text>
              <Text color="ansi:cyan">{manualId}</Text>
              <Text dim>Enter when done.</Text>
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
                <Text dim>{m.id}</Text>
                <Text color={focused ? "cyan" : undefined}>
                  {focused ? "› " : "  "}
                  {aliases[i] ?? ""}
                </Text>
                {focused && err && <Text color="red">{err}</Text>}
                {!focused && err && <Text color="red" dim>{err}</Text>}
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
          <Text dim>Tab/↓ to next field · Enter to finish</Text>
        </Box>
      )}
    </Box>
  );
}
