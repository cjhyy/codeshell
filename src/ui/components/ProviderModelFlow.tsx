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
  type: "existing" | "kind";
  label: string;
  providerIdx?: number;
  kind?: ProviderKindName;
}

export function ProviderModelFlow({
  existingProviders,
  existingModelKeys,
  detectedEnvKeys = [],
  switchToNewModelOnFinish,
  onFinish,
  onCancel,
}: ProviderModelFlowProps) {
  const kindList = Object.entries(PROVIDER_KINDS) as Array<
    [ProviderKindName, { label: string; defaultBaseUrl: string }]
  >;

  // Build the kind-step menu: existing providers first, then kinds.
  const kindEntries: KindEntry[] = [
    ...existingProviders.map((p, i) => ({
      type: "existing" as const,
      label: `Use existing: ${p.label ?? p.key} (${p.kind})`,
      providerIdx: i,
    })),
    ...kindList.map(([k, m]) => ({
      type: "kind" as const,
      label: m.label,
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
  const title = useExistingProvider ? "Add models" : "Add provider + models";

  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Text bold>{title}</Text>
      <Text dimColor>Esc to cancel.</Text>

      {step === "kind" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Pick a provider:</Text>
          {kindEntries.map((e, i) => (
            <Text key={`${e.type}-${i}`} color={i === kindIdx ? "cyan" : undefined}>
              {i === kindIdx ? "› " : "  "}
              {e.label}
            </Text>
          ))}
        </Box>
      )}

      {step === "key" &&
        (() => {
          const hint = envHintForKind(selectedKind);
          const showMenu = hint && !keyMenuDone;
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text>API key for {PROVIDER_KINDS[selectedKind].label}:</Text>
              {showMenu ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color={keyMenuIdx === 0 ? "cyan" : undefined}>
                    {keyMenuIdx === 0 ? "› " : "  "}
                    Use ${hint!.envKey} (••••{hint!.apiKey.slice(-4)})
                  </Text>
                  <Text color={keyMenuIdx === 1 ? "cyan" : undefined}>
                    {keyMenuIdx === 1 ? "› " : "  "}
                    Paste new key
                  </Text>
                </Box>
              ) : (
                <>
                  <Text color="cyan">{apiKey.replace(/./g, "•")}</Text>
                  <Text dimColor>Enter when done.</Text>
                </>
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
