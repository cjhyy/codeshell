import type { ProviderQuota, QuotaResult } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { UsageProviderDescriptor } from "../shared/usage-providers.js";

export interface QuotaApi {
  listProviders(): Promise<UsageProviderDescriptor[]>;
  query(providerId: string): Promise<ProviderQuota>;
  /** Compatibility for room views. Codex is free; Claude sends a minimal usage probe. */
  get(provider?: "claude" | "codex" | "both"): Promise<QuotaResult>;
}

export function createQuotaApi(ipc: {
  invoke: (channel: string, input?: unknown) => Promise<any>;
}): QuotaApi {
  return {
    listProviders: () => ipc.invoke("quota:listProviders"),
    query: (providerId) => ipc.invoke("quota:query", providerId),
    get: (provider) => ipc.invoke("quota:get", provider),
  };
}
