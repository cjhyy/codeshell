/** Each preload instance shares a worker with other windows and remote/host clients. */
export function createPreloadRpcIdFactory(): () => string {
  const namespace = crypto.randomUUID();
  let sequence = 0;
  return () => `desktop-rpc-${namespace}-${++sequence}`;
}

/** Worker replies are broadcast; only an exact string identity owns a pending request. */
export function takePreloadRpcResponse<T>(pending: Map<string, T>, id: unknown): T | undefined {
  if (typeof id !== "string") return undefined;
  const entry = pending.get(id);
  if (entry !== undefined) pending.delete(id);
  return entry;
}
