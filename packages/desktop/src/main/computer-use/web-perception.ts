/** Perception shaping for web content (Chromium, Electron, WebKit) on the
 * read path only. Imported by the CUA proxy, so no dependencies. */

/** The driver's own default walk budget is 1 s and returns a partial tree when
 * it runs out; web pages routinely need longer. Callers that set one keep it. */
export const WINDOW_STATE_TIMEOUT_MS = 3_000;
/** A web area with fewer descendants than this was read before the page's
 * accessibility tree existed (the driver: "retry once, it populates"). */
const SPARSE_WEB_AREA = 3;

type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;

/** A `get_window_state` request with the default walk budget filled in, or
 * undefined when nothing changes (other tools, explicit budgets, no tree). */
export function withReadBudget(request: unknown): JsonRecord | undefined {
  const message = record(request);
  const params = record(message?.params);
  if (message?.method !== "tools/call" || params?.name !== "get_window_state") return;
  const args = record(params.arguments) ?? {};
  if (args.timeout_ms !== undefined || args.include_accessibility_tree === false) return;
  return {
    ...message,
    params: { ...params, arguments: { ...args, timeout_ms: WINDOW_STATE_TIMEOUT_MS } },
  };
}

/** True when a successful window state contains a web area that is still
 * empty: the page's accessibility tree had not been built yet. */
export function sparseWebArea(result: unknown): boolean {
  const value = record(result);
  if (!value || value.isError === true) return false;
  const elements = record(value.structuredContent)?.elements;
  if (!Array.isArray(elements)) return false;
  const parents = new Map<unknown, unknown>();
  const areas: unknown[] = [];
  for (const raw of elements.slice(0, 5_000)) {
    const element = record(raw);
    if (!element) continue;
    parents.set(element.element_index, element.parent_index);
    if (/web.?area/i.test(String(element.role))) areas.push(element.element_index);
  }
  if (!areas.length) return false;
  const descendants = new Map<unknown, number>(areas.map((area) => [area, 0]));
  for (const index of parents.keys()) {
    let parent = parents.get(index);
    for (let depth = 0; parent !== undefined && depth < 64; depth++) {
      if (descendants.has(parent)) {
        descendants.set(parent, descendants.get(parent)! + 1);
        break;
      }
      parent = parents.get(parent);
    }
  }
  return [...descendants.values()].some((count) => count < SPARSE_WEB_AREA);
}
