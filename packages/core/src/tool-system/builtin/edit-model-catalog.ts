/**
 * EditModelCatalog tool — add or update a provider/model template in the user
 * model catalog (~/.code-shell/model-catalog.user.json). Pairs with the
 * model-fact-finder skill: the skill researches a model's facts (modalities,
 * params, context), then this tool writes them into a CatalogEntry so the
 * connection page picks it up. Backs up before writing; validates against the
 * schema; never touches API keys/credentials (those go through the user's own
 * Edit, by design). See docs/.../2026-06-15-unified-model-catalog-design.md §7.
 */
import { randomBytes } from "node:crypto";
import type { ToolDefinition } from "../../types.js";
import { userCatalogPath } from "../../model-catalog/index.js";
import { saveCatalogEntry } from "../../model-catalog/save-entry.js";
import { catalogEntrySchema } from "../../model-catalog/types.js";

export const editModelCatalogToolDef: ToolDefinition = {
  name: "EditModelCatalog",
  description:
    "Add or update a provider/model template in the user model catalog so it " +
    "appears in the connection page (text/image/video). Keyed by `id`: a new id " +
    "adds a provider, an existing id replaces that user-catalog entry. Backs up " +
    "the file before writing and " +
    "validates the entry. Use after researching a model's real facts (id, context " +
    "window, supported params, modalities) — do NOT guess; verify against the " +
    "provider's official docs first (see the model-fact-finder skill). Does NOT set " +
    "API keys: the user enters keys in the connection page (credentials), not here.",
  inputSchema: {
    type: "object",
    properties: {
      entry: {
        type: "object",
        description:
          "A full CatalogEntry. Required: id, tag (text|image|video), adapterKind " +
          "(an already-wired adapter: openai|anthropic|google|fal), displayName, " +
          "description, defaultBaseUrl. Optional: protocol (openai-compat|anthropic-style), " +
          "defaultModel, needsKey, signupUrl, test, modelPresets[] (each {value, label?, " +
          "maxContextTokens?, maxOutputTokens?, supportsVision?, params?[]}). Each param: " +
          "{name, label?, control (enum|number|toggle|text), options?[], min?, max?, default?, " +
          "doc?, wire?{field}}. Fill maxContextTokens with the model's REAL window; declare " +
          "params per-model (only what that model supports). To keep a custom provider " +
          "beside a built-in one, use a distinct id.",
      },
    },
    required: ["entry"],
  },
};

export async function editModelCatalogTool(
  args: Record<string, unknown>,
): Promise<string> {
  const entry = args.entry;
  if (!entry || typeof entry !== "object") {
    return "Error: `entry` (a CatalogEntry object) is required.";
  }
  const parsed = catalogEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return `Error: invalid catalog entry: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
  }
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const r = saveCatalogEntry(parsed.data, {
    path: userCatalogPath(),
    stamp,
  });
  if (!r.ok) return `Error: ${r.error}`;
  return summarizeWrite(parsed.data as CatalogEntryShape, r.action ?? "added", r.backup);
}

/** Shape we read off the written entry for the summary (loose — schema already validated it). */
interface CatalogEntryShape {
  id?: string;
  tag?: string;
  adapterKind?: string;
  defaultModel?: string;
  defaultBaseUrl?: string;
  modelPresets?: Array<{
    value?: string;
    label?: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    params?: Array<{
      name?: string;
      control?: string;
      options?: unknown[];
      min?: number;
      max?: number;
      default?: unknown;
    }>;
  }>;
}

/**
 * Build a structured completion summary so the user can SEE exactly what was
 * written and catch a wrong value at a glance — every param's options/default
 * is echoed back, because that's where catalog entries go wrong (e.g. listing a
 * gateway's input aliases as if they were the model's native effort levels).
 * The LLM is told to relay this and ask the user to verify against the docs.
 */
function summarizeWrite(
  entry: CatalogEntryShape,
  action: "added" | "updated",
  backup?: string,
): string {
  const id = entry.id ?? "(unknown)";
  const lines: string[] = [];
  lines.push(`✅ ${action === "updated" ? "Updated" : "Added"} catalog entry "${id}".`);
  lines.push(
    `tag: ${entry.tag ?? "?"} | adapter: ${entry.adapterKind ?? "?"}` +
      (entry.defaultModel ? ` | defaultModel: ${entry.defaultModel}` : "") +
      (entry.defaultBaseUrl ? ` | baseUrl: ${entry.defaultBaseUrl}` : ""),
  );
  const presets = entry.modelPresets ?? [];
  if (presets.length === 0) {
    lines.push("(no modelPresets)");
  }
  for (const p of presets) {
    const ctx = p.maxContextTokens ? `ctx ${p.maxContextTokens}` : "";
    const out = p.maxOutputTokens ? `out ${p.maxOutputTokens}` : "";
    const limits = [ctx, out].filter(Boolean).join(", ");
    lines.push(`\nmodel: ${p.value ?? "?"}${p.label ? ` (${p.label})` : ""}${limits ? ` — ${limits}` : ""}`);
    const params = p.params ?? [];
    if (params.length === 0) {
      lines.push("  (no params declared)");
    }
    for (const pa of params) {
      let detail = "";
      if (pa.control === "enum") detail = `options=[${(pa.options ?? []).join(", ")}]`;
      else if (pa.control === "number")
        detail = `range ${pa.min ?? "?"}..${pa.max ?? "?"}`;
      const def = pa.default !== undefined ? ` default=${JSON.stringify(pa.default)}` : "";
      lines.push(`  - ${pa.name ?? "?"} (${pa.control ?? "?"}) ${detail}${def}`.trimEnd());
    }
  }
  lines.push(
    `\nWritten to ${userCatalogPath()}.` + (backup ? ` Backup: ${backup}.` : ""),
  );
  lines.push("Hot-reloads — the connection page refreshes once this turn completes.");
  lines.push(
    "⚠️ Relay this summary to the user and ask them to verify each param's options/default " +
      "match the provider's OFFICIAL docs — especially enum levels (a gateway's input aliases " +
      "are NOT the model's native values). To fix: edit this file directly, or ask me to.",
  );
  return lines.join("\n");
}
