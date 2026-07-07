import type { LLMConfig } from "@cjhyy/code-shell-core";

export function resolveMaxContextTokens(
  llm: Pick<LLMConfig, "maxContextTokens"> | null | undefined,
  settingsMaxTokens: number | null | undefined,
): number {
  return llm?.maxContextTokens ?? settingsMaxTokens ?? 200_000;
}
