export const MAX_MCP_RESULT_BYTES = 8 * 1024 * 1024;
export const MAX_MCP_LIST_PAGES = 100;

export class McpResponseTooLargeError extends Error {
  readonly code = "response_too_large";
  constructor() {
    super(
      "MCP response exceeded the 8 MiB limit. Request fewer resources or a smaller selected scope; no partial result was returned.",
    );
    this.name = "McpResponseTooLargeError";
  }
}

export class McpCapabilityUnavailableError extends Error {
  readonly code = "unsupported";
  constructor(capability: string) {
    super(`This MCP server does not support ${capability}.`);
    this.name = "McpCapabilityUnavailableError";
  }
}

export function boundedMcpResult<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (!serialized || typeof value !== "object" || value === null)
    throw new Error("Invalid MCP response");
  if (Buffer.byteLength(serialized) > MAX_MCP_RESULT_BYTES) throw new McpResponseTooLargeError();
  return value;
}

export function validateMcpCursor(cursor: unknown): asserts cursor is string | undefined {
  if (cursor !== undefined && (typeof cursor !== "string" || !cursor || cursor.length > 4_096))
    throw new Error("Invalid MCP pagination cursor");
}

/** Bound individual JSON messages/SSE events rather than a long-lived stream's lifetime. */
export function boundMcpHttpResponse(response: Response, assertCurrent?: () => void): Response {
  const type = response.headers.get("content-type")?.split(";", 1)[0];
  if (!response.body || !["application/json", "text/event-stream"].includes(type ?? ""))
    return response;
  const reader = response.body.getReader();
  const events = type === "text/event-stream";
  let bytes = 0;
  let lineEmpty = true;
  let cancelled = false;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      reader.releaseLock();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        assertCurrent?.();
        const { done, value } = await reader.read();
        if (cancelled) return;
        assertCurrent?.();
        if (done) {
          controller.close();
          release();
          return;
        }
        if (!events) {
          bytes += value.byteLength;
          if (bytes > MAX_MCP_RESULT_BYTES) throw new McpResponseTooLargeError();
        } else {
          for (const byte of value) {
            bytes += 1;
            if (bytes > MAX_MCP_RESULT_BYTES) throw new McpResponseTooLargeError();
            if (byte === 10) {
              if (lineEmpty) bytes = 0;
              lineEmpty = true;
            } else if (byte !== 13) lineEmpty = false;
          }
        }
        controller.enqueue(value);
      } catch (error) {
        await reader.cancel().catch(() => {});
        release();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
      release();
    },
  });
  const bounded = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  Object.defineProperty(bounded, "url", { value: response.url });
  return bounded;
}
