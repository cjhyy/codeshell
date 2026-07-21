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
import {
  BUILTIN_CATALOG,
  getMergedCatalog,
  loadUserCatalog,
  userCatalogPath,
} from "../../model-catalog/index.js";
import { saveCatalogEntry } from "../../model-catalog/save-entry.js";
import {
  catalogEntrySchema,
  modelPresetSchema,
  type CatalogEntry,
  type ModelPreset,
} from "../../model-catalog/types.js";
import { upsertModelPreset } from "../../model-catalog/upsert.js";
import { PROVIDER_KINDS, type ProviderKindName } from "../../llm/provider-kinds.js";

const CATALOG_ADAPTER_KINDS = [...Object.keys(PROVIDER_KINDS), "fal"].join("|");

/**
 * Recognise first-party provider hosts so the catalog tool can reject the
 * dangerous-but-schema-valid combination that caused an OpenRouter model to be
 * sent to api.openai.com. Unknown/custom hosts remain allowed.
 */
function inferProviderKindFromBaseUrl(baseUrl: string): ProviderKindName | undefined {
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [kind, meta] of Object.entries(PROVIDER_KINDS) as Array<
    [ProviderKindName, (typeof PROVIDER_KINDS)[ProviderKindName]]
  >) {
    if (!meta.defaultBaseUrl) continue;
    try {
      if (new URL(meta.defaultBaseUrl).host.toLowerCase() === host) return kind;
    } catch {
      // A future custom kind may intentionally have no parseable default URL.
    }
  }
  return undefined;
}

function providerIdentityError(entry: CatalogEntry): string | undefined {
  if (entry.tag !== "text") return undefined;
  const inferred = inferProviderKindFromBaseUrl(entry.defaultBaseUrl);
  if (!inferred || inferred === "custom" || entry.adapterKind === inferred) return undefined;
  const protocolHint = inferred === "anthropic" ? "anthropic-style" : "openai-compat";
  return (
    `provider mismatch: defaultBaseUrl points to ${inferred}, but adapterKind is ` +
    `"${entry.adapterKind}". Use adapterKind="${inferred}" and ` +
    `protocol="${protocolHint}". adapterKind identifies the provider/gateway account; ` +
    `protocol only identifies the HTTP wire format.`
  );
}

/** Notifies process hosts after the user catalog has been persisted. Desktop
 * uses this to refresh mounted settings/connection views without waiting for
 * a parent turn_complete event (which may be absent for child/yielded runs). */
type ModelCatalogChangedSink = () => void;
let modelCatalogChangedSink: ModelCatalogChangedSink | null = null;

export function setModelCatalogChangedSink(sink: ModelCatalogChangedSink | null): void {
  modelCatalogChangedSink = sink;
}

function fireModelCatalogChanged(): void {
  try {
    modelCatalogChangedSink?.();
  } catch {
    // Host notification is best-effort; the catalog write itself succeeded.
  }
}

export const editModelCatalogToolDef: ToolDefinition = {
  name: "EditModelCatalog",
  description:
    "Add a model to an existing provider, or add/replace a complete provider template, " +
    "in the user model catalog so it appears in the connection page " +
    "(text/image/video/audio). Prefer operation='upsertModel' whenever the provider " +
    "already exists: it preserves all existing/built-in models and reuses that provider's " +
    "credentials. Use operation='upsertProvider' only for a genuinely new provider/endpoint " +
    "or an intentional full provider override. Backs up the file before writing and " +
    "validates the entry. Use after researching a model's real facts (id, context " +
    "window, supported params, modalities) — do NOT guess; verify against the " +
    "provider's official docs first (see the model-fact-finder skill). Does NOT set " +
    "API keys: the user enters keys in the connection page (credentials), not here.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["upsertModel", "upsertProvider"],
        description:
          "upsertModel appends/updates one model inside an existing provider; " +
          "upsertProvider saves a complete provider template. Defaults from the supplied fields.",
      },
      providerId: {
        type: "string",
        description:
          "Existing provider id for upsertModel, e.g. 'openrouter'. Do not create a " +
          "provider-per-model id such as 'openrouter-kimi'.",
      },
      modelPreset: {
        type: "object",
        description:
          "One complete ModelPreset for upsertModel: {value, label?, maxContextTokens?, " +
          "maxOutputTokens?, supportsVision?, params?[]}. Existing model value updates in " +
          "place; a new value appends without hiding the provider's other models.",
      },
      setAsDefault: {
        type: "boolean",
        description: "For upsertModel, also make this model the provider template default.",
      },
      entry: {
        type: "object",
        description:
          "For upsertProvider only: a full CatalogEntry. Required: id, tag " +
          "(text|image|video|audio), adapterKind " +
          `(the actual provider/gateway identity: ${CATALOG_ADAPTER_KINDS}), displayName, ` +
          "description, defaultBaseUrl. Optional: protocol (openai-compat|anthropic-style), " +
          "defaultModel, needsKey, signupUrl, test, modelPresets[] (each {value, label?, " +
          "maxContextTokens?, maxOutputTokens?, supportsVision?, params?[]}). Each param: " +
          "{name, label?, control (enum|number|toggle|text), options?[], min?, max?, default?, " +
          "doc?, wire?{field}}. Fill maxContextTokens with the model's REAL window; declare " +
          "params per-model (only what that model supports). IMPORTANT: adapterKind is NOT " +
          "the wire protocol. OpenRouter must use adapterKind='openrouter' with " +
          "protocol='openai-compat'; never use adapterKind='openai' merely because an endpoint " +
          "is OpenAI-compatible. Adding a model to OpenRouter is operation='upsertModel' with " +
          "providerId='openrouter', not a new provider entry. For genuinely distinct custom " +
          "providers, retain the real provider's adapterKind so credentials and capability " +
          "rules stay in the correct provider family.",
      },
    },
  },
};

export async function editModelCatalogTool(args: Record<string, unknown>): Promise<string> {
  const operation =
    args.operation ??
    (args.providerId !== undefined || args.modelPreset !== undefined
      ? "upsertModel"
      : "upsertProvider");
  if (operation === "upsertModel") return upsertExistingProviderModel(args);
  if (operation !== "upsertProvider") {
    return "Error: `operation` must be `upsertModel` or `upsertProvider`.";
  }

  const entry = args.entry;
  if (!entry || typeof entry !== "object") {
    return "Error: `entry` (a CatalogEntry object) is required.";
  }
  const parsed = catalogEntrySchema.safeParse(entry);
  if (!parsed.success) {
    return `Error: invalid catalog entry: ${parsed.error.issues.map((i) => i.message).join("; ")}`;
  }
  const identityError = providerIdentityError(parsed.data);
  if (identityError) return `Error: ${identityError}`;
  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const r = saveCatalogEntry(parsed.data, {
    path: userCatalogPath(),
    stamp,
  });
  if (!r.ok) return `Error: ${r.error}`;
  fireModelCatalogChanged();
  return summarizeWrite(parsed.data as CatalogEntryShape, r.action ?? "added", r.backup);
}

async function upsertExistingProviderModel(args: Record<string, unknown>): Promise<string> {
  const providerId = typeof args.providerId === "string" ? args.providerId.trim() : "";
  if (!providerId) return "Error: `providerId` is required for `upsertModel`.";

  const parsedPreset = modelPresetSchema.safeParse(args.modelPreset);
  if (!parsedPreset.success) {
    return `Error: invalid model preset: ${parsedPreset.error.issues.map((issue) => issue.message).join("; ")}`;
  }

  const builtin = BUILTIN_CATALOG.find((entry) => entry.id === providerId);
  const userEntry = loadUserCatalog().find((entry) => entry.id === providerId);
  const provider = userEntry ?? builtin;
  if (!provider) {
    return (
      `Error: provider "${providerId}" does not exist. ` +
      "Create it first with operation=`upsertProvider`."
    );
  }

  const effective = getMergedCatalog().find((entry) => entry.id === providerId) ?? provider;
  const existed = effective.modelPresets?.some(
    (preset) => preset.value === parsedPreset.data.value,
  );
  // For built-ins, the user file stores only model-level additions/overrides.
  // getMergedCatalog layers these over the current shipped presets, so app
  // upgrades can add models without being frozen by a full user override.
  const storedPresets = builtin ? (userEntry?.modelPresets ?? []) : (provider.modelPresets ?? []);
  const nextEntry: CatalogEntry = {
    ...(builtin ?? provider),
    ...(userEntry ?? {}),
    ...(builtin ? { modelPresetsMode: "merge" as const } : {}),
    ...(args.setAsDefault === true ? { defaultModel: parsedPreset.data.value } : {}),
    modelPresets: upsertModelPreset(storedPresets, parsedPreset.data),
  };
  const identityError = providerIdentityError(nextEntry);
  if (identityError) return `Error: ${identityError}`;

  const stamp = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const result = saveCatalogEntry(nextEntry, { path: userCatalogPath(), stamp });
  if (!result.ok) return `Error: ${result.error}`;
  fireModelCatalogChanged();
  return summarizeModelWrite(
    nextEntry,
    parsedPreset.data,
    existed ? "updated" : "added",
    result.backup,
  );
}

function summarizeModelWrite(
  entry: CatalogEntry,
  preset: ModelPreset,
  action: "added" | "updated",
  backup?: string,
): string {
  const lines = [
    `✅ ${action === "updated" ? "Updated" : "Added"} model "${preset.value}" in provider "${entry.id}".`,
    `adapter: ${entry.adapterKind} | baseUrl: ${entry.defaultBaseUrl}`,
    `merge: existing provider models preserved${entry.defaultModel === preset.value ? " | provider default: yes" : ""}`,
  ];
  const limits = [
    preset.maxContextTokens ? `ctx ${preset.maxContextTokens}` : "",
    preset.maxOutputTokens ? `out ${preset.maxOutputTokens}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  if (limits) lines.push(`limits: ${limits}`);
  for (const param of preset.params ?? []) {
    const details =
      param.control === "enum"
        ? ` options=[${param.options?.join(", ") ?? ""}]`
        : param.control === "number"
          ? ` range=${param.min ?? "?"}..${param.max ?? "?"}`
          : "";
    const defaultValue =
      param.default !== undefined ? ` default=${JSON.stringify(param.default)}` : "";
    lines.push(`- ${param.name} (${param.control})${details}${defaultValue}`);
  }
  lines.push(`Written to ${userCatalogPath()}.` + (backup ? ` Backup: ${backup}.` : ""));
  lines.push("Hot-reloads — the connection page refreshes after this write.");
  lines.push(
    "⚠️ Relay this summary to the user and ask them to verify the model facts against official docs.",
  );
  return lines.join("\n");
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
    lines.push(
      `\nmodel: ${p.value ?? "?"}${p.label ? ` (${p.label})` : ""}${limits ? ` — ${limits}` : ""}`,
    );
    const params = p.params ?? [];
    if (params.length === 0) {
      lines.push("  (no params declared)");
    }
    for (const pa of params) {
      let detail = "";
      if (pa.control === "enum") detail = `options=[${(pa.options ?? []).join(", ")}]`;
      else if (pa.control === "number") detail = `range ${pa.min ?? "?"}..${pa.max ?? "?"}`;
      const def = pa.default !== undefined ? ` default=${JSON.stringify(pa.default)}` : "";
      lines.push(`  - ${pa.name ?? "?"} (${pa.control ?? "?"}) ${detail}${def}`.trimEnd());
    }
  }
  lines.push(`\nWritten to ${userCatalogPath()}.` + (backup ? ` Backup: ${backup}.` : ""));
  lines.push("Hot-reloads — the connection page refreshes after this write.");
  lines.push(
    "⚠️ Relay this summary to the user and ask them to verify each param's options/default " +
      "match the provider's OFFICIAL docs — especially enum levels (a gateway's input aliases " +
      "are NOT the model's native values). To fix: edit this file directly, or ask me to.",
  );
  return lines.join("\n");
}
