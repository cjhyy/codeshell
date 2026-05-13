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
  /** Model ids already in settings.models[] — used by the flow to disable
   *  rows for models the user has already added. */
  existingModelIds?: string[];
}

export function OnboardingPrompt({
  onComplete,
  onCancel,
  existingProviders = [],
  existingModelKeys = [],
  existingModelIds = [],
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
    // Wizard emits self-describing entries (already include baseUrl/apiKey/
    // provider) so we don't need to re-resolve credentials through the
    // existing-provider table — that path was the source of the v4-pro
    // selection silently falling back to v4-flash.
    const active =
      result.addedModels.find((m) => m.key === result.activeModelKey) ?? result.addedModels[0]!;

    const onboardingResult: OnboardingResult = {
      key: active.key,
      provider: active.provider,
      model: active.model,
      apiKey: active.apiKey ?? "",
      baseUrl: active.baseUrl,
    };

    appendOnboardingResult({
      activeKey: active.key,
      activeMirror: {
        provider: onboardingResult.provider,
        model: onboardingResult.model,
        apiKey: onboardingResult.apiKey,
        baseUrl: onboardingResult.baseUrl,
      },
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
      addedModels: result.addedModels,
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
        existingModelIds={existingModelIds}
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
