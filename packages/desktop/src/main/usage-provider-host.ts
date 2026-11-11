import { SettingsManager } from "@cjhyy/code-shell-core";
import { getMergedCatalog } from "@cjhyy/code-shell-core/internal";
import {
  checkQuota,
  resolveQuotaCredentials,
  type ProviderQuota,
} from "@cjhyy/code-shell-capability-coding/orchestration";
import { findOnPath } from "./external-runtime-availability.js";
import {
  createLegacyQuotaQuery,
  UsageProviderService,
  type LegacyQuotaProvider,
} from "./usage-provider-service.js";

/** Host-only wiring: adding a CLI adapter does not change the discovery DTO or UI. */
export function createDefaultUsageProviderService() {
  const queryProviders = async (providers: LegacyQuotaProvider[]) =>
    checkQuota({ creds: await resolveQuotaCredentials(providers), providers });
  const queryProvider = async (provider: LegacyQuotaProvider): Promise<ProviderQuota> => {
    const result = await queryProviders([provider]);
    return (
      result[provider] ?? {
        provider,
        errorCode: "request-failed",
        error: "Quota query returned no result",
      }
    );
  };
  const settings = new SettingsManager();
  const service = new UsageProviderService({
    // Startup has already merged the login-shell PATH used by external runtimes.
    findExecutable: (binary) => findOnPath(binary, process.env.PATH),
    modelConnections: () => settings.getForScope("user").modelConnections ?? [],
    catalog: getMergedCatalog,
    adapters: [
      {
        id: "cli:codex",
        displayName: "Codex",
        binary: "codex",
        quota: {
          supported: true,
          provider: "codex",
          queryCost: "none",
          query: () => queryProvider("codex"),
        },
      },
      {
        id: "cli:claude-code",
        displayName: "Claude Code",
        binary: "claude",
        quota: {
          supported: true,
          provider: "claude",
          queryCost: "minimal-usage",
          query: () => queryProvider("claude"),
        },
      },
    ],
  });
  return { service, getLegacyQuota: createLegacyQuotaQuery(queryProviders) };
}
