import { CodexAppServerClient, type AppServerClientOptions } from "./app-server-client.js";
import { buildRuntimeSpawnEnv } from "../shared/spawn-env.js";

export interface CodexDiscoveredModel {
  model: string;
  displayName: string;
  isDefault: boolean;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_PAGES = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read the installed Codex CLI's available models without starting a thread or
 * turn. The deadline covers initialization and every page together. Callers own
 * caching and fallback policy; a valid empty catalog is distinct from failure.
 */
export async function discoverCodexModels(
  options: AppServerClientOptions & { timeoutMs?: number } = {},
): Promise<CodexDiscoveredModel[]> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ...clientOptions } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex model discovery requires a positive timeout");
  }

  const deadline = performance.now() + timeoutMs;
  const remainingMs = (): number => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Codex model discovery timed out");
    return Math.ceil(remaining);
  };
  const client = new CodexAppServerClient({
    ...clientOptions,
    env: buildRuntimeSpawnEnv({ base: options.env }),
  });
  client.onNotification(() => {});
  client.onServerRequest(() => undefined);

  try {
    client.start();
    await client.request(
      "initialize",
      { clientInfo: { name: "codeshell", title: "CodeShell", version: "1" } },
      remainingMs(),
    );
    client.notify("initialized");

    const models = new Map<string, CodexDiscoveredModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await client.request(
        "model/list",
        { includeHidden: false, limit: 100, ...(cursor ? { cursor } : {}) },
        remainingMs(),
      );
      if (!isRecord(result) || !Array.isArray(result.data)) {
        throw new Error("Invalid Codex model/list response");
      }
      for (const entry of result.data) {
        if (
          !isRecord(entry) ||
          !nonemptyString(entry.model) ||
          !nonemptyString(entry.displayName) ||
          (entry.isDefault !== undefined && typeof entry.isDefault !== "boolean") ||
          (entry.hidden !== undefined && typeof entry.hidden !== "boolean")
        ) {
          throw new Error("Invalid Codex model/list entry");
        }
        if (entry.hidden === true || models.has(entry.model)) continue;
        models.set(entry.model, {
          model: entry.model,
          displayName: entry.displayName,
          isDefault: entry.isDefault === true,
        });
      }

      if (result.nextCursor === null || result.nextCursor === undefined) {
        return [...models.values()];
      }
      if (!nonemptyString(result.nextCursor) || cursors.has(result.nextCursor)) {
        throw new Error("Invalid Codex model/list pagination cursor");
      }
      cursor = result.nextCursor;
      cursors.add(cursor);
    }
    throw new Error("Codex model/list exceeded the pagination limit");
  } finally {
    await client.close();
  }
}
