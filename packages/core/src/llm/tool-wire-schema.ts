/**
 * Provider-safe tool input schema.
 *
 * Anthropic (direct, or behind OpenRouter's Chat API) rejects the whole request
 * when any tool's input_schema has `oneOf` / `anyOf` / `allOf` at the top level,
 * and other providers' schema subsets disagree on these too. They only express
 * "one of these argument groups" hints, which the host enforces itself (tool
 * functions check their argument groups; `validateToolArgs` never reads them),
 * so the wire copy drops them. Nested combinators inside properties are kept.
 */
const TOP_LEVEL_COMBINATORS = ["oneOf", "anyOf", "allOf", "not"] as const;

export function wireToolInputSchema<T extends Record<string, unknown>>(schema: T): T {
  if (!TOP_LEVEL_COMBINATORS.some((key) => key in schema)) return schema;
  const copy: Record<string, unknown> = { ...schema };
  for (const key of TOP_LEVEL_COMBINATORS) delete copy[key];
  return copy as T;
}
