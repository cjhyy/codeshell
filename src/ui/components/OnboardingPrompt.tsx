/**
 * OnboardingPrompt — first-run / /login wizard.
 *
 * Thin wrapper around ProviderModelFlow:
 *   1. <ProviderModelFlow switchToNewModelOnFinish={true} />  (Esc cancels)
 *   2. Optional Arena participant multi-select over the newly-added aliases
 *      (skipped when only one model was added)
 *   3. Append everything to settings.json and resolve via onComplete
 *
 * Append-only: re-running /login adds providers/models on top of what's
 * already there. To start over the user runs /logout first.
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import { ProviderModelFlow, type FlowResult } from "./ProviderModelFlow.js";
import type { ProviderKindName } from "../../llm/provider-kinds.js";
import {
  type OnboardingResult,
  detectEnvKeys,
  appendOnboardingResult,
  saveArenaSettingsByKeys,
} from "../../cli/onboarding.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";

type Step = "flow" | "arena";

interface OnboardingPromptProps {
  onComplete: (result: OnboardingResult) => void;
  onCancel: () => void;
  /** Existing providers — surfaces "Use existing" in the flow's first step.
   *  Optional: empty by default (first-run case). */
  existingProviders?: ProviderConfig[];
  /** Existing model aliases — used by the flow to derive unique aliases. */
  existingModelKeys?: string[];
}

export function OnboardingPrompt({
  onComplete,
  onCancel,
  existingProviders = [],
  existingModelKeys = [],
}: OnboardingPromptProps) {
  const [step, setStep] = useState<Step>("flow");
  const [flowResult, setFlowResult] = useState<FlowResult | null>(null);
  // Arena: which newly-added model aliases participate.
  const [arenaPicks, setArenaPicks] = useState<Set<string>>(new Set());
  const [arenaIdx, setArenaIdx] = useState(0);

  // ─── Arena step input ──────────────────────────────────────────────
  useInput((input, key) => {
    if (step !== "arena" || !flowResult) return;
    const aliases = flowResult.addedModels.map((m) => m.key);
    if (key.escape) {
      finish(flowResult, new Set());
      return;
    }
    if (input === "s" || input === "S") {
      finish(flowResult, new Set());
      return;
    }
    if (key.upArrow) {
      setArenaIdx((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setArenaIdx((i) => Math.min(aliases.length - 1, i + 1));
    } else if (input === " ") {
      const k = aliases[arenaIdx];
      if (!k) return;
      setArenaPicks((prev) => {
        const next = new Set(prev);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        return next;
      });
    } else if (key.return) {
      finish(flowResult, arenaPicks);
    }
  });

  // ─── Persist & resolve ─────────────────────────────────────────────
  function finish(result: FlowResult, picks: Set<string>): void {
    if (result.addedModels.length === 0) {
      onCancel();
      return;
    }
    // Active model: prefer the user's pick from the flow; else the first added.
    const active =
      result.addedModels.find((m) => m.key === result.activeModelKey) ?? result.addedModels[0]!;

    // Resolve baseUrl + apiKey for the active model:
    //   - if a new provider was added, use its credentials
    //   - otherwise the model attached to an existing provider — find it
    let baseUrl = "";
    let apiKey = "";
    let providerKind = "openai";
    if (result.addedProvider) {
      baseUrl = result.addedProvider.baseUrl;
      apiKey = result.addedProvider.apiKey ?? "";
      providerKind = result.addedProvider.kind;
    } else {
      const existing = existingProviders.find((p) => p.key === active.providerKey);
      if (existing) {
        baseUrl = existing.baseUrl;
        apiKey = existing.apiKey ?? "";
        providerKind = existing.kind;
      }
    }

    // Legacy OnboardingResult.provider is one of "openai"/"anthropic" so the
    // engine can pick the right client. Map non-Anthropic kinds to "openai"
    // (everything else speaks OpenAI-compatible JSON).
    const legacyProvider = providerKind === "anthropic" ? "anthropic" : "openai";

    const onboardingResult: OnboardingResult = {
      provider: legacyProvider,
      model: active.model,
      apiKey,
      baseUrl,
    };

    appendOnboardingResult({
      active: onboardingResult,
      addedProvider: result.addedProvider
        ? {
            key: result.addedProvider.key,
            label: result.addedProvider.label,
            kind: result.addedProvider.kind,
            baseUrl: result.addedProvider.baseUrl,
            apiKey: result.addedProvider.apiKey,
            protocol: result.addedProvider.protocol,
            modelsPath: result.addedProvider.modelsPath,
          }
        : undefined,
      addedModels: result.addedModels.map((m) => ({
        key: m.key,
        providerKey: m.providerKey,
        model: m.model,
        maxContextTokens: m.maxContextTokens,
        maxOutputTokens: m.maxOutputTokens,
      })),
    });

    if (picks.size >= 2) {
      saveArenaSettingsByKeys([...picks]);
    }

    onComplete(onboardingResult);
  }

  // ─── Flow handoff ──────────────────────────────────────────────────
  function handleFlowFinish(r: FlowResult): void {
    setFlowResult(r);
    if (r.addedModels.length === 0) {
      // Flow short-circuited with nothing added — treat as cancel.
      onCancel();
      return;
    }
    if (r.addedModels.length === 1) {
      // Only one model — Arena needs ≥2, so skip the picker entirely.
      finish(r, new Set());
      return;
    }
    setStep("arena");
  }

  // ─── Render ────────────────────────────────────────────────────────

  if (step === "flow") {
    return (
      <ProviderModelFlow
        existingProviders={existingProviders}
        existingModelKeys={existingModelKeys}
        detectedEnvKeys={detectEnvKeys().map((d) => ({
          envKey: d.envKey,
          apiKey: d.apiKey,
          // ProviderDef.id matches ProviderKindName values for the known
          // kinds we surface; "openrouter"/"openai"/"anthropic"/etc. all line up.
          kindHint: (d.provider.id as ProviderKindName) ?? "openai",
        }))}
        switchToNewModelOnFinish={true}
        onFinish={handleFlowFinish}
        onCancel={onCancel}
      />
    );
  }

  if (step === "arena" && flowResult) {
    const aliases = flowResult.addedModels;
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Box>
          <Text color="ansi:cyan" bold>
            {"✦ Arena participants"}
          </Text>
        </Box>
        <Box marginTop={1} marginLeft={2}>
          <Text dim>Space toggles · Enter finishes · s skips · Esc cancels.</Text>
        </Box>
        <Box marginLeft={2}>
          <Text dim>Pick at least 2 to enable /arena, or skip.</Text>
        </Box>
        {aliases.map((m, i) => {
          const focused = i === arenaIdx;
          const checked = arenaPicks.has(m.key);
          return (
            <Box key={m.key} marginLeft={2}>
              <Text color={focused ? "ansi:cyan" : undefined} bold={focused}>
                {focused ? "❯ " : "  "}
                {`[${checked ? "x" : " "}] ${m.key}`}
              </Text>
              <Text dim>{"  "}{m.model}</Text>
            </Box>
          );
        })}
      </Box>
    );
  }

  return null;
}
