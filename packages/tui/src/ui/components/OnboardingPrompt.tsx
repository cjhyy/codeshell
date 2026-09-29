/**
 * OnboardingPrompt — first-run / /login wizard.
 *
 * Thin wrapper around ProviderModelFlow:
 *   1. <ProviderModelFlow switchToNewModelOnFinish={true} />  (Esc cancels)
 *   2. Append everything to settings.json and resolve via onComplete
 *
 * Append-only: re-running /login adds providers/models on top of what's
 * already there. To start over the user runs /logout first.
 */
import { useState } from "react";
import { Box, Text, useInput } from "../../render/index.js";
import { ProviderModelFlow, type FlowResult } from "./ProviderModelFlow.js";
import type { ProviderKindName } from "@cjhyy/code-shell-core/internal";
import {
  type OnboardingResult,
  detectEnvKeys,
  appendOnboardingResult,
} from "@cjhyy/code-shell-core/internal";
import type { ProviderConfig } from "@cjhyy/code-shell-core/internal";

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
  const [flowResult, setFlowResult] = useState<FlowResult | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ─── Save-error retry input ────────────────────────────────────────
  useInput((_input, key) => {
    if (!saveError) return;
    if (key.escape) {
      onCancel();
    } else if (key.return && flowResult) {
      finish(flowResult);
    }
  });

  // ─── Persist & resolve ─────────────────────────────────────────────
  function finish(result: FlowResult): void {
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

    try {
      setSaveError(null);
      appendOnboardingResult({
        models: result.addedModels.map((m) => ({
          instanceId: m.key,
          // provider kind → catalogId mapping happens in core; prefer the
          // explicit added-provider kind, fall back to the model's own provider.
          kind: result.addedProvider?.kind ?? m.provider,
          model: m.model,
          apiKey: m.apiKey,
          baseUrl: m.baseUrl,
        })),
        activeId: result.activeModelKey ?? result.addedModels[0]?.key ?? "",
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
      return;
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
    finish(r);
  }

  // ─── Render ────────────────────────────────────────────────────────

  if (saveError) {
    return (
      <Box flexDirection="column" marginLeft={1}>
        <Text color="ansi:red" bold>
          配置没有保存
        </Text>
        <Box marginTop={1} marginLeft={2}>
          <Text>{saveError}</Text>
        </Box>
        <Box marginLeft={2}>
          <Text dim>请修复 ~/.code-shell/settings.json 后按 Enter 重试，或按 Esc 取消。</Text>
        </Box>
      </Box>
    );
  }

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
