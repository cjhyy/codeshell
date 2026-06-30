/**
 * Generic JSON extraction from LLM text output — strip markdown fences and
 * pull out the first balanced object/array. These are provider-agnostic and
 * have no Arena dependency; they live here (not in arena/strategies/utils.ts)
 * so non-Arena consumers (e.g. services/memory-orchestrator) can use them
 * without dragging in the Arena subsystem. Arena re-exports them for
 * back-compat.
 */

/** Extract JSON from text that might have markdown fences or surrounding text. */
export function extractJSON(text: string): string {
  // Try fenced code blocks — use GREEDY match to handle nested backticks
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*)\n\s*```/);
  if (fenced) return fenced[1].trim();

  // Try to find the outermost { ... } pair with balanced braces
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    // Unbalanced — return from start to end as best effort
    return text.slice(start);
  }

  return text;
}

/** Extract a JSON array from text. */
export function extractJSONArray(text: string): string {
  const fenced = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenced) return fenced[1].trim();

  // Return the FIRST balanced top-level array. A greedy /\[[\s\S]*\]/ spanned
  // to the last ']', merging two arrays (or trailing prose) into one invalid
  // blob. Scan for bracket balance, ignoring brackets inside strings.
  const balanced = firstBalancedArray(text);
  if (balanced) return balanced;

  return text;
}

function firstBalancedArray(text: string): string | undefined {
  const start = text.indexOf("[");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined; // unbalanced
}
