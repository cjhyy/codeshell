import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

/** Compatibility for Chrome DevTools' optional output/context selectors.
 * A blank selector is not an output filename or an intentional isolated context.
 * Match the server implementation AND its declared tool shape; an unrelated
 * tool's empty text, input path, or required parameter must remain untouched. */
function optionalChromeSelectors(implementation: string | undefined, tool: McpTool): string[] {
  if (implementation !== "chrome_devtools") return [];
  const properties = tool.inputSchema.properties as
    | Record<string, Record<string, unknown>>
    | undefined;
  const required = new Set(tool.inputSchema.required ?? []);
  if (!properties) return [];
  const expected: Record<string, { selectors: string[]; signature: Record<string, string> }> = {
    take_snapshot: { selectors: ["filePath"], signature: { verbose: "boolean" } },
    take_screenshot: { selectors: ["filePath"], signature: { format: "string" } },
    evaluate_script: { selectors: ["filePath"], signature: { function: "string" } },
    get_network_request: {
      selectors: ["requestFilePath", "responseFilePath"],
      signature: { reqid: "number" },
    },
    new_page: { selectors: ["isolatedContext"], signature: { url: "string" } },
  };
  const contract = expected[tool.name];
  if (
    !contract ||
    Object.entries(contract.signature).some(([key, type]) => properties[key]?.type !== type)
  )
    return [];
  return contract.selectors.filter(
    (key) => properties[key]?.type === "string" && !required.has(key),
  );
}

export function adaptMcpToolSchema(
  implementation: string | undefined,
  tool: McpTool,
): McpTool["inputSchema"] {
  const selectors = optionalChromeSelectors(implementation, tool);
  if (!selectors.length) return tool.inputSchema;
  const properties = { ...tool.inputSchema.properties };
  for (const key of selectors) {
    const property = properties[key] as Record<string, unknown>;
    properties[key] = {
      ...property,
      minLength: Math.max(typeof property.minLength === "number" ? property.minLength : 0, 1),
      description: `${property.description ?? ""} Omit this optional field when unused; do not send an empty string.`,
    };
  }
  return { ...tool.inputSchema, properties };
}

export function normalizeMcpToolArgs(
  implementation: string | undefined,
  tool: McpTool | undefined,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };
  if (tool)
    for (const key of optionalChromeSelectors(implementation, tool)) {
      if (normalized[key] === "") delete normalized[key];
    }
  return normalized;
}
