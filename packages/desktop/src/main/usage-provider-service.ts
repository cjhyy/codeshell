import type { ProviderQuota, QuotaResult } from "@cjhyy/code-shell-capability-coding/orchestration";
import type { UsageProviderDescriptor } from "../shared/usage-providers.js";

export interface CliUsageProviderAdapter {
  id: string;
  displayName: string;
  binary: string;
  quota:
    | { supported: false }
    | {
        supported: true;
        provider: string;
        queryCost: "none" | "minimal-usage";
        query: () => Promise<ProviderQuota>;
      };
}

export interface UsageProviderServiceDeps {
  adapters: readonly CliUsageProviderAdapter[];
  findExecutable: (binary: string) => string | null;
  modelConnections: () => readonly { catalogId: string }[];
  catalog: () => readonly { id: string; displayName: string }[];
}

/** Discovery never invokes an adapter's credential resolver or quota request. */
export class UsageProviderService {
  private readonly adapters: ReadonlyMap<string, CliUsageProviderAdapter>;

  constructor(private readonly deps: UsageProviderServiceDeps) {
    const adapters = new Map<string, CliUsageProviderAdapter>();
    for (const adapter of deps.adapters) {
      if (!adapter.id.startsWith("cli:") || adapter.id.length === 4 || adapters.has(adapter.id)) {
        throw new Error("Invalid or duplicate CLI usage provider id");
      }
      adapters.set(adapter.id, adapter);
    }
    this.adapters = adapters;
  }

  listProviders(): UsageProviderDescriptor[] {
    const providers: UsageProviderDescriptor[] = [];
    for (const adapter of this.adapters.values()) {
      if (!this.deps.findExecutable(adapter.binary)) continue;
      providers.push({
        id: adapter.id,
        displayName: adapter.displayName,
        source: "cli",
        quota: adapter.quota.supported
          ? { supported: true, queryCost: adapter.quota.queryCost }
          : { supported: false },
      });
    }
    const counts = new Map<string, number>();
    for (const connection of this.deps.modelConnections()) {
      if (!connection.catalogId) continue;
      counts.set(connection.catalogId, (counts.get(connection.catalogId) ?? 0) + 1);
    }
    if (counts.size) {
      const names = new Map(this.deps.catalog().map((entry) => [entry.id, entry.displayName]));
      for (const [catalogId, connectionCount] of counts) {
        providers.push({
          id: `model:${catalogId}`,
          displayName: names.get(catalogId) ?? catalogId,
          source: "model-connection",
          connectionCount,
          quota: { supported: false },
        });
      }
    }
    return providers;
  }

  async query(providerId: unknown): Promise<ProviderQuota> {
    if (typeof providerId !== "string" || !providerId) {
      throw new Error("Invalid usage provider id");
    }
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error("Unknown or unsupported quota provider");
    const quota = adapter.quota;
    if (!quota.supported) throw new Error("Provider does not support quota queries");
    // Re-probe before credentials: a provider can disappear after page discovery.
    if (!this.deps.findExecutable(adapter.binary)) {
      return {
        provider: quota.provider,
        errorCode: "unavailable",
        error: "The CLI is no longer available on this machine",
      };
    }
    try {
      return await quota.query();
    } catch {
      // An adapter exception may contain credentials or a local path. Keep it private.
      return {
        provider: quota.provider,
        errorCode: "request-failed",
        error: "Quota query failed",
      };
    }
  }
}

export type LegacyQuotaProvider = "claude" | "codex";

/** Preserve omitted=both for old room UI; every other value is validated before I/O. */
export function createLegacyQuotaQuery(
  query: (providers: LegacyQuotaProvider[]) => Promise<QuotaResult>,
): (provider: unknown) => Promise<QuotaResult> {
  return async (provider) => {
    if (provider === undefined || provider === "both") return query(["claude", "codex"]);
    if (provider === "claude" || provider === "codex") return query([provider]);
    throw new Error("Invalid quota provider");
  };
}
