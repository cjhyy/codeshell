/**
 * Unwrap a JSON-RPC reply: `rpc()` resolves with the whole `{id, result|error}`
 * envelope, so data-returning callers must reach into `.result` (and surface
 * `.error`). Older bindings that ignore the payload can skip this.
 */
export function rpcResult<T = unknown>(msg: unknown): T {
  const m = (msg ?? {}) as { result?: unknown; error?: { message?: string } };
  if (m.error) throw new Error(m.error.message ?? "RPC error");
  return m.result as T;
}
