/**
 * Param projection — the two halves of the "one declaration drives both" goal:
 *  - applyParams: user's chosen values → request-body fields (via wire.field).
 *  - buildParamsDoc: the param specs → a natural-language note injected into the
 *    tool description so the agent knows what a configured model accepts.
 * See docs/superpowers/specs/2026-06-15-unified-model-catalog-design.md §4/§6.
 */
import type { ParamSpec } from "./types.js";

/**
 * Project `values` onto a request-body fragment using each spec's wire.field
 * (falling back to the param name). A dotted field ("thinking.budget_tokens")
 * nests. Values with no matching spec, and specs the user didn't set, are
 * skipped.
 */
export function applyParams(
  values: Record<string, unknown>,
  params: ParamSpec[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const spec of params) {
    if (!(spec.name in values)) continue;
    const value = values[spec.name];
    if (value === undefined) continue;
    const field = spec.wire?.field ?? spec.name;
    setDeep(body, field, value);
  }
  return body;
}

/** Set a (possibly dotted) path on an object, creating intermediate objects. */
function setDeep(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    if (typeof cur[key] !== "object" || cur[key] === null) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/**
 * Build a natural-language note describing the params a model accepts, for
 * injection into the tool description. Empty string when there are no params.
 */
export function buildParamsDoc(params: ParamSpec[] | undefined): string {
  if (!params || params.length === 0) return "";
  const lines = params.map((p) => {
    const opts = p.options && p.options.length > 0 ? ` (${p.options.join(" | ")})` : "";
    const doc = p.doc ? ` — ${p.doc}` : "";
    return `${p.name}${opts}${doc}`;
  });
  return lines.join("; ");
}
