import type { QuotaProvider } from "./types.js";

/** Validate before any credential access or request; an empty selection stays empty. */
export function selectedQuotaProviders(value: unknown): QuotaProvider[] {
  if (value === undefined) return ["claude", "codex"];
  if (!Array.isArray(value)) throw new Error("Invalid quota providers");
  const selected = new Set<QuotaProvider>();
  for (const provider of value) {
    if (provider !== "claude" && provider !== "codex") throw new Error("Invalid quota provider");
    selected.add(provider);
  }
  return [...selected];
}
