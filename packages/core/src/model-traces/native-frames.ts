const MAX_FRAME_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 192;
const MAX_INFLIGHT = 64;
const MAX_PARTIAL_BYTES = 8 * 1024 * 1024;
const MAX_AGE_MS = 30_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

/** Atomic FD 3 fragments are reassembled separately for each opaque message id. */
export function createNativeModelTraceFrameDecoder(options: { now?: () => number } = {}) {
  const partials = new Map<
    string,
    { part: number; startedAt: number; bytes: number; chunks: Buffer[] }
  >();
  let partialBytes = 0;
  const remove = (id: string) => {
    const partial = partials.get(id);
    if (partial) partialBytes -= partial.bytes;
    partials.delete(id);
  };
  const invalid = (): never => {
    throw new Error("Invalid native model observation fragment");
  };
  return {
    read(line: string): string | undefined {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) invalid();
      const value = JSON.parse(line);
      if (value?.type !== "model_trace_chunk") return line;
      const now = (options.now ?? Date.now)();
      for (const [id, partial] of partials) if (now - partial.startedAt > MAX_AGE_MS) remove(id);
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some(
          (key) => !["version", "type", "messageId", "part", "data", "final"].includes(key),
        ) ||
        value.version !== 1 ||
        typeof value.messageId !== "string" ||
        !UUID.test(value.messageId) ||
        !Number.isSafeInteger(value.part) ||
        value.part < 0 ||
        value.part > Math.ceil(MAX_FRAME_BYTES / MAX_CHUNK_BYTES) ||
        typeof value.final !== "boolean" ||
        typeof value.data !== "string" ||
        !value.data ||
        value.data.length > 256 ||
        Buffer.byteLength(line) + 1 > 512 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
      )
        invalid();
      const bytes = Buffer.from(value.data, "base64");
      if (
        !bytes.length ||
        bytes.length > MAX_CHUNK_BYTES ||
        bytes.toString("base64") !== value.data
      )
        invalid();
      let partial = partials.get(value.messageId);
      if (!partial) {
        if (value.part !== 0 || partials.size >= MAX_INFLIGHT) invalid();
        partial = { part: 0, startedAt: now, bytes: 0, chunks: [] };
        partials.set(value.messageId, partial);
      }
      if (
        value.part !== partial.part ||
        partial.bytes + bytes.length > MAX_FRAME_BYTES ||
        partialBytes + bytes.length > MAX_PARTIAL_BYTES
      )
        invalid();
      partial.part++;
      partial.bytes += bytes.length;
      partialBytes += bytes.length;
      partial.chunks.push(bytes);
      if (!value.final) return undefined;
      remove(value.messageId);
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(partial.chunks),
      );
      if (decoded.includes("\n") || decoded.includes("\r")) invalid();
      // Validate before returning, so a nested fragment cannot bypass parser limits.
      const message = JSON.parse(decoded);
      if (message?.type !== "model_trace") invalid();
      return decoded;
    },
    clear() {
      partials.clear();
      partialBytes = 0;
    },
  };
}
