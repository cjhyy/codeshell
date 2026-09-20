/** Host-generated, per-run facts. Never include server output or connection secrets. */
export function formatMcpConnectionFailures(
  failures: ReadonlyMap<string, string> | undefined,
): string {
  if (!failures?.size) return "";
  return [
    "MCP connection status for this run:",
    ...[...failures].map(([server, error]) => `- ${JSON.stringify(server)}: ${error}`),
    "These servers did not initialize, so their tools are unavailable in this run. Reading a skill does not reconnect its server. Do not invent results or repeat tool searches to recover it. Use another available capability only if it provides the evidence the task requires; otherwise report the capability failure and unfinished work.",
  ].join("\n");
}
