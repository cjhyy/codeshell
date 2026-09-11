/** Each preload instance shares a worker with other windows and remote/host clients. */
export function createPreloadRpcIdFactory(): () => string {
  // randomUUID is only exposed in secure contexts. Electron also runs this
  // sandboxed preload for intermediate navigation documents; getRandomValues
  // remains available there without importing a forbidden Node crypto module.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  const namespace = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
