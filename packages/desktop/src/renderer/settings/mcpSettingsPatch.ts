/** Fields that the MCP editor can author; server identity is the enclosing map key. */
export interface McpSettingsPatchInput {
  transport?: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  envVars?: string[];
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  credentialRef?: string;
  envHeaders?: Record<string, string>;
  enabled?: boolean;
  allowedTools?: string[];
  disabledTools?: string[];
}

type McpSettingsField = keyof McpSettingsPatchInput;

const MCP_SERVER_SETTINGS_FIELDS = [
  "transport",
  "command",
  "args",
  "url",
  "env",
  "envVars",
  "headers",
  "bearerTokenEnvVar",
  "credentialRef",
  "envHeaders",
  "enabled",
  "allowedTools",
  "disabledTools",
] as const satisfies readonly McpSettingsField[];

/**
 * Settings patches recursively merge records. Explicit nulls are necessary to
 * remove omitted fields and deleted map entries, including across JSON hosts
 * where undefined disappears before the patch reaches the settings service.
 * Override editors pass their narrower field list so plugin-owned identity is
 * never included in the resulting patch.
 */
export function buildMcpSettingsPatch(
  next: McpSettingsPatchInput,
  previous: McpSettingsPatchInput = {},
  fields: readonly McpSettingsField[] = MCP_SERVER_SETTINGS_FIELDS,
): Record<string, unknown> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = next[field];
      if (value === undefined) return [field, null];
      if (field === "env" || field === "headers" || field === "envHeaders") {
        const incoming = next[field]!;
        const removed = Object.keys(previous[field] ?? {})
          .filter((key) => !Object.hasOwn(incoming, key))
          .map((key) => [key, null]);
        return [field, Object.fromEntries([...removed, ...Object.entries(incoming)])];
      }
      return [field, Array.isArray(value) ? [...value] : value];
    }),
  );
}
