import {
  resolveLLMConfigForTag,
  type LLMConfig,
  type SettingsManager,
} from "@cjhyy/code-shell-core/extension";
import type { ConnectionIdentity } from "../contracts/experiment.js";
import { canonicalJson, sha256Hex } from "../contracts/canonical-json.js";

export type LabSettings = ReturnType<SettingsManager["get"]>;
export interface ResolvedConnection {
  identity: ConnectionIdentity;
  config: LLMConfig;
  temperature: number;
  /** Exact effective non-content parameters. Compatibility fallbacks cannot drop these. */
  wireParameters: Record<string, unknown>;
}

export const SUPPORTED_ADAPTERS = ["openai", "openrouter", "anthropic"] as const;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,255}$/;

function endpointFor(config: LLMConfig): string {
  const fallback =
    config.provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
  let url: URL;
  try {
    url = new URL(config.baseUrl ?? fallback);
  } catch {
    throw new Error("selected connection has an invalid endpoint");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "selected connection endpoint contains unsupported credentials or query parameters",
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/+$/u, "");
}

/** Core's resolver may fall back; filtering to exactly one selected instance prevents it. */
export function resolveSelectedConnection(
  settings: LabSettings,
  connectionId: string,
): ResolvedConnection {
  const selected = settings.modelConnections.filter(
    (item) => item.id === connectionId && item.tag === "text",
  );
  if (selected.length !== 1) throw new Error("selected text connection is missing or ambiguous");
  const instance = selected[0]!;
  // Catalog parameters not covered by this adapter cannot silently disappear in Core.
  const allowedParams = new Set(["temperature", "top_p"]);
  if (Object.keys(instance.paramValues ?? {}).some((key) => !allowedParams.has(key))) {
    throw new Error(
      "selected connection has unsupported parameters; P1a supports non-reasoning text sampling only",
    );
  }
  const config = resolveLLMConfigForTag(
    {
      ...settings,
      modelConnections: selected,
      defaults: { ...settings.defaults, text: connectionId },
    },
    "text",
    connectionId,
  );
  if (!config) throw new Error("selected connection cannot resolve its catalog or credential");
  const kind = config.providerKind ?? config.provider;
  if (
    !SUPPORTED_ADAPTERS.includes(kind as (typeof SUPPORTED_ADAPTERS)[number]) ||
    !["openai", "anthropic"].includes(config.provider)
  ) {
    throw new Error("selected provider adapter is unsupported in P1a");
  }
  if (!SAFE_ID.test(config.model) || !SAFE_ID.test(instance.catalogId))
    throw new Error("selected model identity is unsupported");
  if (
    config.authCommand ||
    Object.keys(config.httpHeaders ?? {}).length ||
    config.serviceTier ||
    config.reasoningSummary ||
    config.reasoning
  ) {
    throw new Error(
      "selected connection contains unsupported transport or reasoning configuration",
    );
  }
  // These families have provider-translated reasoning/default sampling rules; they need a later reviewed adapter.
  if (config.provider === "openai" && /(?:^|\/)(?:gpt-5|o[1-9](?:-|$))/iu.test(config.model)) {
    throw new Error("reasoning model request policy is not supported by the P1a adapter");
  }
  const extra: Record<string, number> = {};
  for (const [key, value] of Object.entries(config.extraBody ?? {})) {
    if (!allowedParams.has(key) || typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("selected connection has unsupported extra request parameters");
    }
    if (
      (key === "temperature" && (value < 0 || value > 2)) ||
      (key === "top_p" && (value < 0 || value > 1))
    ) {
      throw new Error("selected sampling parameter is outside supported bounds");
    }
    extra[key] = value;
  }
  if (Object.keys(instance.paramValues ?? {}).some((key) => !Object.hasOwn(extra, key)))
    throw new Error("selected catalog does not expose the requested sampling parameter");
  if (config.provider === "anthropic" && Object.hasOwn(extra, "top_p"))
    throw new Error(
      "Anthropic top_p is not forwarded by the current Core client; select temperature only",
    );
  const configuredDefault = (settings as unknown as { model?: { temperature?: number } }).model
    ?.temperature;
  if (
    configuredDefault !== undefined &&
    (!Number.isFinite(configuredDefault) || configuredDefault < 0 || configuredDefault > 2)
  )
    throw new Error("default sampling temperature is unsupported");
  const temperature = extra.temperature ?? configuredDefault ?? 0.3;
  const endpoint = endpointFor(config);
  const wireParameters = { temperature, ...extra };
  const projection = {
    connectionId,
    catalogId: instance.catalogId,
    provider: config.provider,
    providerKind: kind,
    model: config.model,
    endpoint,
    wireParameters,
    maxTokens: config.maxTokens ?? null,
    maxContextTokens: config.maxContextTokens ?? null,
    adapterVersion: "strict_text_http_v1",
  };
  return {
    config: { ...config, baseUrl: endpoint },
    temperature,
    wireParameters,
    identity: {
      connectionId,
      providerKind: kind,
      modelId: config.model,
      endpoint,
      configHash: sha256Hex(canonicalJson(projection)),
      credentialRevision: null, // Store has no non-secret credential revision; auth-only rotation is allowed.
      // Arbitrary compatible endpoints/model aliases do not establish reasoning bounds.
      outputCapCoversReasoning:
        config.provider === "anthropic" && endpoint === "https://api.anthropic.com"
          ? true
          : "unknown",
      pricing: {
        inputPerMillion: null,
        outputPerMillion: null,
        cachedInputPerMillion: null,
        source: null,
        date: null,
      },
    },
  };
}

export function assertSameConnection(
  actual: ResolvedConnection,
  expected: ConnectionIdentity,
): void {
  if (canonicalJson(actual.identity) !== canonicalJson(expected))
    throw new Error("selected connection changed; prepare and authorize a new plan");
}

export function discoverConnections(settings: LabSettings) {
  return settings.modelConnections
    .filter((item) => item.tag === "text")
    .map((item) => {
      try {
        const resolved = resolveSelectedConnection(settings, item.id);
        return {
          id: item.id,
          label: item.id,
          model: resolved.identity.modelId,
          provider: resolved.identity.providerKind,
          eligible: true,
        };
      } catch {
        // Never serialize resolver errors: providers may include endpoint or credential text.
        return {
          id: item.id,
          label: item.id,
          model: item.model,
          provider: "unsupported",
          eligible: false,
          reason: "连接无法解析，或包含 P1a 尚不支持的参数、模型、传输配置",
        };
      }
    });
}
