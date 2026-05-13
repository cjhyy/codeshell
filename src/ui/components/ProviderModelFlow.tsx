/**
 * ProviderModelFlow — shared 4-step add-provider-and-models flow.
 *
 * Used by /login (OnboardingPrompt) and by ModelManager's a/A keys.
 * Both invocations are APPEND-ONLY. /logout is the way to clear.
 *
 * Steps: kind → key → fetch+pick → alias+(active?) → onFinish.
 */
import { Box, Text } from "../../render/index.js";
import type { ProviderConfig } from "../../llm/provider-catalog.js";
import type { ProviderKindName } from "../../llm/provider-kinds.js";

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

// ─── Component placeholder ────────────────────────────────────────

export function ProviderModelFlow(_props: ProviderModelFlowProps) {
  // Full state machine implemented in Task 2.
  return (
    <Box flexDirection="column" padding={1} borderStyle="round">
      <Text>ProviderModelFlow (skeleton)</Text>
    </Box>
  );
}
