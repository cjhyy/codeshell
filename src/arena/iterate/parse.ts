/**
 * Parsing helpers for LLM responses in iterate mode.
 *
 * We use literal XML-ish markers (<v1_content>…</v1_content>) instead of
 * pure JSON because LLMs are far more reliable at "write 5000 chars of
 * markdown then a small JSON block at the end" than at producing one
 * giant well-formed JSON document with a 5000-char string field.
 */

import type { Critique } from "./types.js";

/** Extract content between `<tag>` and `</tag>`. Forgiving: trims whitespace; case-insensitive. */
export function extractTag(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/** Parse merge response: extract v1 content + rationale. Falls back to whole text if markers are missing. */
export function parseMergeResponse(text: string): { content: string; rationale?: string } {
  const content = extractTag(text, "v1_content");
  const rationale = extractTag(text, "merge_rationale");
  if (content) {
    return { content, rationale: rationale ?? undefined };
  }
  // Fallback: no markers — treat whole response as content (with a warning sentinel).
  return { content: text.trim(), rationale: "[merge markers not found; using full response]" };
}

export interface ReviseMeta {
  acceptedCritiques?: string[];
  rejectedCritiques?: Array<{ id: string; reason: string }>;
  changelog?: string;
}

/** Parse revise response: extract content + meta JSON. */
export function parseReviseResponse(text: string): { content: string; meta: ReviseMeta } {
  const content = extractTag(text, "v_next_content");
  const metaRaw = extractTag(text, "v_next_meta");

  let meta: ReviseMeta = {};
  if (metaRaw) {
    // Strip surrounding code fences if present.
    const cleaned = metaRaw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      meta = JSON.parse(cleaned);
    } catch {
      meta = { changelog: `[meta JSON parse failed; raw text below]\n${metaRaw}` };
    }
  }

  return {
    content: content ?? text.trim(),
    meta,
  };
}

/**
 * Parse critique JSON from an argue-phase response.
 * Tolerant: handles bare objects, fenced JSON, leading prose, trailing prose.
 */
export function parseCritiquesResponse(text: string, criticName: string, idPrefix: string): Critique[] {
  const cleaned = text.replace(/^[^{[]*/, "").replace(/[^}\]]*$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Try to find the largest JSON object/array in the text.
    const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!jsonMatch) return [];
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch {
      return [];
    }
  }

  // Accept either {critiques: [...]} or [...] directly.
  const arr =
    Array.isArray(parsed)
      ? parsed
      : (parsed as { critiques?: unknown[] }).critiques;
  if (!Array.isArray(arr)) return [];

  const out: Critique[] = [];
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i] as Partial<Critique>;
    if (!c.anchor || !c.comment) continue;
    out.push({
      id: `${idPrefix}-${criticName}-${i + 1}`,
      critic: criticName,
      anchor: String(c.anchor),
      severity: (c.severity as Critique["severity"]) ?? "minor",
      category: (c.category as Critique["category"]) ?? "other",
      comment: String(c.comment),
      suggestion: c.suggestion ? String(c.suggestion) : undefined,
    });
  }
  return out;
}
