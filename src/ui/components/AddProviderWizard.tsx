/**
 * AddProviderWizard — Ink wizard for adding a provider credential.
 *
 * Flow: choose kind → fill key (custom also fills baseUrl + protocol)
 * → test /v1/models call → save. Calls onSave with the validated config
 * (and the fetched model list, so the parent can persist the cache).
 */

import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import { PROVIDER_KINDS, type ProviderKindName } from "../../llm/provider-kinds.js";
import { fetchModelList } from "../../llm/model-fetcher.js";
import { defaultCacheDir } from "../../llm/model-cache.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";

interface Props {
  existingKeys: string[];
  onSave: (config: ProviderConfig) => void;
  onCancel: () => void;
}

type Step = "kind" | "key" | "baseUrl" | "test";

export function AddProviderWizard({ existingKeys, onSave, onCancel }: Props) {
  const kinds = Object.entries(PROVIDER_KINDS) as Array<
    [ProviderKindName, { label: string; defaultBaseUrl: string }]
  >;
  const [step, setStep] = useState<Step>("kind");
  const [kindIdx, setKindIdx] = useState(0);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [testing, setTesting] = useState(false);

  const [name, meta] = kinds[kindIdx]!;

  useInput((input, key) => {
    if (key.escape) return onCancel();

    if (step === "kind") {
      if (key.upArrow) setKindIdx((i) => Math.max(0, i - 1));
      else if (key.downArrow) setKindIdx((i) => Math.min(kinds.length - 1, i + 1));
      else if (key.return) {
        setBaseUrl(meta.defaultBaseUrl);
        // Ollama and custom skip API-key step
        if (name === "ollama") setStep("test");
        else setStep("key");
      }
      return;
    }
    if (step === "key") {
      if (key.backspace || key.delete) setApiKey((s) => s.slice(0, -1));
      else if (key.return) {
        if (name === "custom") setStep("baseUrl");
        else setStep("test");
      } else if (input && !key.ctrl) setApiKey((s) => s + input);
      return;
    }
    if (step === "baseUrl") {
      if (key.backspace || key.delete) setBaseUrl((s) => s.slice(0, -1));
      else if (key.return) setStep("test");
      else if (input && !key.ctrl) setBaseUrl((s) => s + input);
      return;
    }
    if (step === "test") {
      if (input === "s" || input === "S") {
        save();
      } else if (key.return) {
        void runTest();
      }
    }
  });

  async function runTest(): Promise<void> {
    setTesting(true);
    setStatus("Testing…");
    setError(undefined);
    const derivedKey =
      name === "custom"
        ? deriveKeyFromUrl(baseUrl, existingKeys)
        : uniqueKey(name, existingKeys);
    const res = await fetchModelList(
      { key: derivedKey, kind: name, baseUrl, apiKey },
      { cacheDir: defaultCacheDir() },
    );
    setTesting(false);
    if (res.error) {
      setStatus("");
      setError(res.error);
    } else {
      setStatus(`OK — fetched ${res.models.length} models`);
      save(derivedKey);
    }
  }

  function save(forcedKey?: string): void {
    const derivedKey =
      forcedKey ??
      (name === "custom"
        ? deriveKeyFromUrl(baseUrl, existingKeys)
        : uniqueKey(name, existingKeys));
    onSave({
      key: derivedKey,
      kind: name,
      baseUrl,
      apiKey: name === "ollama" ? undefined : apiKey,
      label: meta.label,
    });
  }

  // Auto-trigger the test once when we land on the test step.
  // This is a "fire-and-forget" — the useInput handler will let the
  // user retry or save-anyway on error.
  if (step === "test" && status === "" && error === undefined && !testing) {
    void runTest();
  }

  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Text bold>Add provider</Text>
      <Text dimColor>Esc to cancel.</Text>
      {step === "kind" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Pick provider kind:</Text>
          {kinds.map(([k, m], i) => (
            <Text key={k} color={i === kindIdx ? "cyan" : undefined}>
              {i === kindIdx ? "› " : "  "}
              {m.label}
            </Text>
          ))}
        </Box>
      )}
      {step === "key" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>API key for {meta.label}:</Text>
          <Text color="cyan">{apiKey.replace(/./g, "•")}</Text>
          <Text dimColor>Enter when done.</Text>
        </Box>
      )}
      {step === "baseUrl" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>Base URL (with /v1):</Text>
          <Text color="cyan">{baseUrl}</Text>
          <Text dimColor>Enter when done.</Text>
        </Box>
      )}
      {step === "test" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{status || (error ? "" : "Connecting…")}</Text>
          {error && <Text color="red">Error: {error}</Text>}
          {error && <Text dimColor>Enter to retry · S to save anyway</Text>}
        </Box>
      )}
    </Box>
  );
}

function uniqueKey(base: string, used: string[]): string {
  const set = new Set(used);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const k = `${base}-${i}`;
    if (!set.has(k)) return k;
  }
}

function deriveKeyFromUrl(url: string, used: string[]): string {
  const host = url.replace(/^https?:\/\//, "").split("/")[0] ?? "custom";
  return uniqueKey(host.replace(/[^a-z0-9]+/gi, "-").toLowerCase(), used);
}
