/**
 * AddModelWizard — pick a model from a provider's cached/fetched list.
 *
 * Flow: choose provider (or jump to AddProviderWizard) → list models from
 * cache (auto-refresh if cache is stale, manual `r` to force-refresh) →
 * pick a model → set alias → save. Falls back to manual ID entry if the
 * fetch fails and no cache exists.
 */

import { useEffect, useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import { fetchModelList, type FetchResult } from "../../llm/model-fetcher.js";
import { defaultCacheDir } from "../../llm/model-cache.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";

interface Props {
  providers: ProviderConfig[];
  existingModelKeys: string[];
  onSave: (entry: {
    key: string;
    providerKey: string;
    model: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
  }) => void;
  onCancel: () => void;
  onAddProvider: () => void;
}

type Step = "provider" | "list" | "alias" | "manualId";

export function AddModelWizard({
  providers,
  existingModelKeys,
  onSave,
  onCancel,
  onAddProvider,
}: Props) {
  const [step, setStep] = useState<Step>("provider");
  const [providerIdx, setProviderIdx] = useState(0);
  const [modelIdx, setModelIdx] = useState(0);
  const [list, setList] = useState<FetchResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [alias, setAlias] = useState("");
  const [manualId, setManualId] = useState("");

  const provider = providers[providerIdx];

  async function refresh(force = false): Promise<void> {
    if (!provider) return;
    setLoading(true);
    const res = await fetchModelList(
      {
        key: provider.key,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        ...(provider.modelsPath ? { modelsPath: provider.modelsPath } : {}),
      },
      {
        cacheDir: defaultCacheDir(),
        refresh: force,
      },
    );
    setList(res);
    setLoading(false);
  }

  useEffect(() => {
    if (step === "list") void refresh(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, providerIdx]);

  useInput((input, key) => {
    if (key.escape) return onCancel();

    if (step === "provider") {
      if (key.upArrow) setProviderIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setProviderIdx((i) => Math.min(providers.length, i + 1));
      else if (key.return) {
        if (providerIdx === providers.length) onAddProvider();
        else setStep("list");
      }
      return;
    }
    if (step === "list") {
      if (input === "r") void refresh(true);
      else if (input === "m") setStep("manualId");
      else if (list && list.models.length) {
        if (key.upArrow) setModelIdx((i) => Math.max(0, i - 1));
        else if (key.downArrow)
          setModelIdx((i) => Math.min(list.models.length - 1, i + 1));
        else if (key.return) {
          const picked = list.models[modelIdx]!;
          setAlias(deriveAlias(picked.id, existingModelKeys));
          setStep("alias");
        }
      }
      return;
    }
    if (step === "alias") {
      if (key.backspace || key.delete) setAlias((s) => s.slice(0, -1));
      else if (key.return && alias && !existingModelKeys.includes(alias)) {
        const picked = list?.models[modelIdx];
        onSave({
          key: alias,
          providerKey: provider!.key,
          model: picked?.id ?? manualId,
          maxContextTokens: picked?.contextLength || undefined,
          maxOutputTokens: picked?.maxOutputTokens || undefined,
        });
      } else if (input && !key.ctrl) setAlias((s) => s + input);
      return;
    }
    if (step === "manualId") {
      if (key.backspace || key.delete) setManualId((s) => s.slice(0, -1));
      else if (key.return && manualId) {
        setAlias(deriveAlias(manualId, existingModelKeys));
        setStep("alias");
      } else if (input && !key.ctrl) setManualId((s) => s + input);
      return;
    }
  });

  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Text bold>Add model</Text>
      <Text dimColor>Esc to cancel.</Text>

      {step === "provider" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Pick a provider:</Text>
          {providers.map((p, i) => (
            <Text key={p.key} color={i === providerIdx ? "cyan" : undefined}>
              {i === providerIdx ? "› " : "  "}
              {p.label ?? p.key} <Text dimColor>({p.kind})</Text>
            </Text>
          ))}
          <Text color={providerIdx === providers.length ? "cyan" : undefined}>
            {providerIdx === providers.length ? "› " : "  "}+ Add a new provider
          </Text>
        </Box>
      )}

      {step === "list" && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {loading ? "Loading…" : `Models from ${provider?.label ?? provider?.key}`}
          </Text>
          {list?.error && <Text color="red">Error: {list.error}</Text>}
          {list?.fromCache && (
            <Text dimColor>
              Cached at {new Date(list.fetchedAt).toLocaleString()} · press r to refresh
            </Text>
          )}
          {list && !list.models.length && !loading && (
            <Text dimColor>No models. Press m to enter a model id manually.</Text>
          )}
          {list?.models
            .slice(Math.max(0, modelIdx - 8), modelIdx + 9)
            .map((m, i) => {
              const realIdx = Math.max(0, modelIdx - 8) + i;
              return (
                <Text key={m.id} color={realIdx === modelIdx ? "cyan" : undefined}>
                  {realIdx === modelIdx ? "› " : "  "}
                  {m.id}
                  {m.contextLength ? (
                    <Text dimColor>  ({m.contextLength.toLocaleString()} ctx)</Text>
                  ) : null}
                </Text>
              );
            })}
        </Box>
      )}

      {step === "manualId" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Model id:</Text>
          <Text color="cyan">{manualId}</Text>
          <Text dimColor>Enter when done.</Text>
        </Box>
      )}

      {step === "alias" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Local alias for this model:</Text>
          <Text color="cyan">{alias}</Text>
          {existingModelKeys.includes(alias) && (
            <Text color="red">Alias already used.</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function deriveAlias(modelId: string, used: string[]): string {
  // "deepseek/deepseek-v4-flash" → "v4-flash"
  let base = modelId.split("/").pop() ?? modelId;
  base = base.replace(/^deepseek-/, "");
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}
