/** Bounds shared by settings, plugin normalization and direct SDK callers. */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 30_000;
export const MAX_MCP_CONNECT_TIMEOUT_MS = 120_000;
export const DEFAULT_MCP_CONNECT_RETRIES = 1;
export const MAX_MCP_CONNECT_RETRIES = 2;

export function validMcpConnectTimeout(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_MCP_CONNECT_TIMEOUT_MS
  );
}

export function validMcpConnectRetries(value: unknown): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_MCP_CONNECT_RETRIES
  );
}
