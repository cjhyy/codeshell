/**
 * External Agent Runtimes as model choices.
 *
 * The product requirement is that picking Codex feels exactly like picking any
 * other model — one dropdown, no separate "backend" concept. A user should not
 * have to know that one entry drives an in-process Engine and another spawns
 * `codex app-server`.
 *
 * So the runtime is encoded INTO the model key, the way the cindy reference
 * implementation does it (`codex/gpt-5.6-sol`):
 *
 *     codex/gpt-5.6-sol        → CodexRuntime,      model gpt-5.6-sol
 *     claude-code/sonnet       → ClaudeCodeRuntime, model sonnet
 *     <anything without "/">   → native Engine, unchanged
 *
 * Making the key itself carry the routing information is what keeps the UI
 * untouched: `ModelPill` renders these like any other option, `onModelChange`
 * persists them like any other key, and only the send path has to branch.
 *
 * This module is the single source of truth for that encoding and is imported
 * by BOTH the renderer (to build options) and main (to route a send). Parsing
 * it in two places would be the obvious way to let the two drift apart.
 */

/** Runtime kinds that can back a model entry. Mirrors ExternalRuntimeKind. */
export type ExternalRuntimeModelKind = "codex" | "claude-code";

/** The `provider` value carried on a ModelOption for these entries. */
export const EXTERNAL_RUNTIME_PROVIDERS: Readonly<Record<ExternalRuntimeModelKind, string>> =
  Object.freeze({
    codex: "codex",
    "claude-code": "claude-code",
  });

const PREFIXES: readonly ExternalRuntimeModelKind[] = ["codex", "claude-code"];

/** 0.8.0 shipped these stale picker values; keep saved sessions usable after upgrade. */
const LEGACY_CODEX_MODELS: Readonly<Record<string, string>> = Object.freeze({
  "gpt-5.1-codex-max": "gpt-5.6-sol",
  "gpt-5.1-codex": "gpt-5.6-sol",
  "gpt-5.1": "gpt-5.6-sol",
});

export interface ParsedExternalRuntimeModel {
  kind: ExternalRuntimeModelKind;
  /** The runtime-specific model id, or undefined to let the runtime decide. */
  model?: string;
}

/** Normalize persisted 0.8.0 runtime keys without touching native model keys. */
export function normalizeExternalRuntimeModelKey(key: string): string {
  const prefix = "codex/";
  if (!key.startsWith(prefix)) return key;
  const model = key.slice(prefix.length).trim();
  const replacement = LEGACY_CODEX_MODELS[model];
  return replacement ? `${prefix}${replacement}` : key;
}

/**
 * Parse a model key into a runtime + model, or `null` for native models.
 *
 * `null` is the important case: every existing model key in every user's
 * settings must keep resolving to the native Engine. The check is an exact
 * prefix match on a closed list rather than "contains a slash", because plenty
 * of legitimate native model ids contain slashes (`openrouter/auto`,
 * `anthropic/claude-3`). Treating those as external would silently reroute a
 * user's normal model to a runtime they never asked for.
 */
export function parseExternalRuntimeModelKey(
  key: string | null | undefined,
): ParsedExternalRuntimeModel | null {
  if (!key) return null;
  key = normalizeExternalRuntimeModelKey(key);
  for (const kind of PREFIXES) {
    const prefix = `${kind}/`;
    if (!key.startsWith(prefix)) continue;
    const model = key.slice(prefix.length).trim();
    return model ? { kind, model } : { kind };
  }
  return null;
}

/** Build the model key for a runtime + model id. Inverse of the parser. */
export function externalRuntimeModelKey(kind: ExternalRuntimeModelKind, model: string): string {
  return `${kind}/${model}`;
}

/** True when this key routes to an external runtime rather than the Engine. */
export function isExternalRuntimeModelKey(key: string | null | undefined): boolean {
  return parseExternalRuntimeModelKey(key) !== null;
}

/**
 * The models offered per runtime.
 *
 * Deliberately a short curated list rather than a live query: `codex app-server`
 * has no "list models" call we can rely on across versions, and an empty or
 * failed query would silently produce a picker with nothing in it. A wrong id
 * here surfaces as an error from the runtime on first use, which is
 * self-explanatory; a missing entry is invisible.
 */
export const EXTERNAL_RUNTIME_MODELS: Readonly<
  Record<ExternalRuntimeModelKind, readonly { model: string; label: string }[]>
> = Object.freeze({
  codex: Object.freeze([
    { model: "gpt-5.6-sol", label: "Codex · GPT-5.6 Sol" },
    { model: "gpt-5.6-terra", label: "Codex · GPT-5.6 Terra" },
    { model: "gpt-5.6-luna", label: "Codex · GPT-5.6 Luna" },
  ]),
  "claude-code": Object.freeze([
    { model: "opus", label: "Claude Code · Opus" },
    { model: "sonnet", label: "Claude Code · Sonnet" },
    { model: "haiku", label: "Claude Code · Haiku" },
  ]),
});

export interface ExternalRuntimeModelEntry {
  key: string;
  label: string;
  provider: string;
  kind: ExternalRuntimeModelKind;
}

/**
 * Flatten the catalog into pickable entries for the runtimes that are actually
 * installed.
 *
 * `available` gates the list because an entry the machine cannot run is worse
 * than no entry: the user picks it, sends a message, and gets a spawn failure.
 * Detection lives in main (it needs PATH resolution); the renderer only renders
 * what it is told is available.
 */
export function externalRuntimeModelEntries(
  available: readonly ExternalRuntimeModelKind[],
): ExternalRuntimeModelEntry[] {
  const entries: ExternalRuntimeModelEntry[] = [];
  for (const kind of PREFIXES) {
    if (!available.includes(kind)) continue;
    for (const { model, label } of EXTERNAL_RUNTIME_MODELS[kind]) {
      entries.push({
        key: externalRuntimeModelKey(kind, model),
        label,
        provider: EXTERNAL_RUNTIME_PROVIDERS[kind],
        kind,
      });
    }
  }
  return entries;
}
