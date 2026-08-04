const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20_000;
const LOCAL_LINK_ALLOWED_HOSTS = new Set([
  "api.github.com",
  "gitlab.com",
  "api.figma.com",
  "api.notion.com",
  "api.linear.app",
  "slack.com",
  "sentry.io",
  "api.airtable.com",
  "api.todoist.com",
  "api.vercel.com",
]);

export interface LinkHttpRequest {
  url: URL;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export async function linkRequestJson(request: LinkHttpRequest): Promise<unknown> {
  if (
    request.url.protocol !== "https:" ||
    !LOCAL_LINK_ALLOWED_HOSTS.has(request.url.hostname.toLowerCase())
  ) {
    throw new Error(`Link provider host is not allowed: ${request.url.hostname}`);
  }
  const fetchImpl = request.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const response = await fetchImpl(request.url, {
    method: request.method ?? "GET",
    headers: {
      Accept: "application/json",
      ...request.headers,
      ...(request.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    redirect: "error",
    signal,
  });
  const text = await readResponseText(response);
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Link provider returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    throw new Error(normalizeProviderError(response.status, data));
  }
  return data;
}

async function readResponseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(`Link provider response exceeded ${MAX_RESPONSE_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function normalizeProviderError(status: number, data: unknown): string {
  const record = asRecord(data);
  const nested = asRecord(record?.error);
  const message = firstString(
    record?.message,
    record?.error_description,
    nested?.message,
    nested?.type,
  );
  return message
    ? `Link provider request failed (HTTP ${status}): ${message.slice(0, 300)}`
    : `Link provider request failed (HTTP ${status})`;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

export function stringParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined {
  const value = params[key];
  if (value === undefined || value === null || value === "") {
    if (options.required) throw new Error(`Missing required Link Action parameter: ${key}`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`Link Action parameter ${key} must be a string`);
  const trimmed = value.trim();
  if (!trimmed && options.required)
    throw new Error(`Missing required Link Action parameter: ${key}`);
  const max = options.maxLength ?? 300;
  if (trimmed.length > max) throw new Error(`Link Action parameter ${key} is too long`);
  return trimmed;
}

/**
 * Values interpolated into a fixed URL path template must never move the
 * request to another endpoint. `encodeURIComponent` does not neutralize
 * `.`/`..`, and both `new URL()` and CLI backends like `gh api` normalize dot
 * segments away, so `organization: ".."` would otherwise turn
 * `/organizations/../projects/` into `/projects/`.
 */
export function assertPathSegment(value: string, key: string): string {
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding; the raw value is still checked below.
  }
  for (const candidate of [value, decoded]) {
    if (!candidate || candidate === "." || candidate === ".." || /[/\\]/.test(candidate)) {
      throw new Error(`Link Action parameter ${key} contains an invalid path segment`);
    }
  }
  return value;
}

/** A string param used as exactly one segment of a URL path template. */
export function pathSegmentParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined {
  const value = stringParam(params, key, options);
  if (value === undefined) return undefined;
  return assertPathSegment(value, key);
}

/**
 * A slash-separated resource path (e.g. a file path inside a repository).
 * Every segment is validated like assertPathSegment and encoded individually;
 * the returned string is ready to interpolate into a URL path template.
 */
export function pathParam(
  params: Record<string, unknown>,
  key: string,
  options: { required?: boolean; maxLength?: number } = {},
): string | undefined {
  const value = stringParam(params, key, options);
  if (value === undefined) return undefined;
  return value
    .split("/")
    .map((segment) => encodeURIComponent(assertPathSegment(segment, key)))
    .join("/");
}

export function intParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
  max: number,
): number {
  const raw = params[key];
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
  return Math.min(value, max);
}

export function pick(record: unknown, keys: readonly string[]): Record<string, unknown> {
  const source = asRecord(record) ?? {};
  return Object.fromEntries(
    keys.flatMap((key) => (source[key] === undefined ? [] : [[key, source[key]]])),
  );
}
