import { createHash } from "node:crypto";
import type { LLMConfig, SessionToolSelection } from "../types.js";
import { normalizeSessionToolSelection } from "../tool-system/run-tool-surface.js";

/** Model/route identity contains no credentials and survives process restarts. */
export function toolCacheIdentity(config: LLMConfig | undefined): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config?.provider,
        config?.providerKind,
        config?.baseUrl,
        config?.model,
        config?.modelKey,
      ]),
    )
    .digest("hex");
}

/** A cold history may refresh schemas and promote all previously discovered tools. */
export function rebaseToolSelection(value: unknown): SessionToolSelection | undefined {
  const selection = normalizeSessionToolSelection(value);
  if (!selection) return undefined;
  const { frozenDefinitions: _definitions, ...rest } = selection;
  return {
    ...rest,
    names: [...new Set([...selection.names, ...selection.discovered])],
    discovered: [],
  };
}

export function selectionForToolCacheCycle(value: unknown, identity: string): unknown {
  const selection = normalizeSessionToolSelection(value);
  if (!selection) return value;
  return {
    ...(selection.cacheIdentity && selection.cacheIdentity !== identity
      ? rebaseToolSelection(selection)!
      : selection),
    cacheIdentity: identity,
  };
}

/** Do not promote discovery for a failed/no-op context cleanup. */
export function isToolCacheCompaction(info: {
  strategy: string;
  before: number;
  after: number;
  historyChanged?: boolean;
}): boolean {
  return (
    (info.historyChanged ?? info.after < info.before) &&
    ["summary", "snip", "window", "emergency", "notes", "range"].includes(info.strategy)
  );
}
