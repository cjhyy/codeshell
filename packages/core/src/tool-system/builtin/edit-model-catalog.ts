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

export const editModelCatalogToolDef: ToolDefinition = {
  name: "EditModelCatalog",
  description:
    "Add or update a provider/model template in the user model catalog so it " +
    "appears in the connection page (text/image/video). Keyed by `id` — a new id " +
    "adds, an existing id updates (in place). Backs up the file before writing and " +
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
          "params per-model (only what that model supports).",
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
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const r = saveCatalogEntry(entry, { path: userCatalogPath(), stamp });
  if (!r.ok) return `Error: ${r.error}`;
  const id = (entry as { id?: string }).id ?? "(unknown)";
  const backupNote = r.backup ? ` Previous file backed up to ${r.backup}.` : "";
  return (
    `${r.action === "updated" ? "Updated" : "Added"} catalog entry "${id}" in ` +
    `${userCatalogPath()}.${backupNote} Restart the app to see it in the connection page.`
  );
}
