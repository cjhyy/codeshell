import type { LLMConfig, ToolDefinition } from "../types.js";

type DiscoveryConfig = Pick<
  LLMConfig,
  "provider" | "providerKind" | "model" | "baseUrl" | "reasoning" | "extraBody"
>;

/** Only reviewed Messages routes; protocol selection never follows a model name. */
export function anthropicMessagesEndpoint(
  config: Pick<DiscoveryConfig, "provider" | "providerKind" | "baseUrl">,
): { kind: "anthropic" | "openrouter"; baseURL: string } | undefined {
  if (config.provider !== "anthropic") return undefined;
  const kind = config.providerKind ?? "anthropic";
  if (kind !== "anthropic" && kind !== "openrouter") return undefined;
  if (!config.baseUrl && kind === "openrouter") return undefined;
  let url: URL;
  try {
    url = new URL(config.baseUrl ?? "https://api.anthropic.com");
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    return undefined;
  const path = url.pathname.replace(/\/+$/, "");
  if (
    kind === "anthropic" &&
    url.origin === "https://api.anthropic.com" &&
    (path === "" || path === "/v1")
  )
    return { kind, baseURL: "https://api.anthropic.com" };
  if (
    kind === "openrouter" &&
    url.origin === "https://openrouter.ai" &&
    (path === "/api" || path === "/api/v1")
  )
    return { kind, baseURL: "https://openrouter.ai/api" };
  return undefined;
}

/** Exact models validated for this bounded, thinking-disabled implementation. */
export function supportsNativeToolDiscoveryModel(config: DiscoveryConfig): boolean {
  const endpoint = anthropicMessagesEndpoint(config);
  return (
    (endpoint?.kind === "anthropic" && config.model === "claude-sonnet-5") ||
    (endpoint?.kind === "openrouter" && config.model === "anthropic/claude-sonnet-5")
  );
}

export function nativeToolDiscoveryEnabled(config: DiscoveryConfig): boolean {
  if (!supportsNativeToolDiscoveryModel(config) || config.reasoning?.mode !== "off") return false;
  const thinking = config.extraBody?.thinking;
  // extraBody is not generally forwarded by AnthropicClient. Do not accidentally
  // override an explicit incompatible thinking preference while enabling native tools.
  return (
    thinking === undefined ||
    (thinking !== null &&
      typeof thinking === "object" &&
      !Array.isArray(thinking) &&
      Object.keys(thinking).length === 1 &&
      (thinking as { type?: unknown }).type === "disabled")
  );
}

/** Unsupported declarations stay available through portable schema text + CallTool.
 * https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
 */
export function canExposeNativeToolDefinition(definition: ToolDefinition): boolean {
  return (
    typeof definition.name === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(definition.name) &&
    definition.inputSchema?.type === "object"
  );
}
