/**
 * genInstancesFromConnections — bridge unified modelConnections (tag=image or
 * video) + credentials into the GenInstance shape the image/video runtime
 * resolvers (resolveImageProvider / resolveVideoProvider) consume. Lets
 * image/video flow through the unified credentials store; key comes from the
 * referenced credential. Connections whose catalogId doesn't resolve are
 * skipped. See docs/.../2026-06-15-unified-model-catalog-design.md §6.
 */
import { resolveInstance, type ModelInstance, type Credential } from "./resolve.js";
import type { CatalogEntry } from "./index.js";

/** The shape image/video resolvers expect (mirrors generate-image GenInstance). */
export interface GenRuntimeInstance {
  id: string;
  kind: string;
  baseUrl: string;
  apiKey?: string;
  defaultModel?: string;
  catalogId: string;
}

export function genInstancesFromConnections(
  connections: ModelInstance[],
  credentials: Credential[],
  catalog: CatalogEntry[],
  tag: "image" | "video" | "audio",
): GenRuntimeInstance[] {
  const out: GenRuntimeInstance[] = [];
  for (const inst of connections) {
    if (inst.tag !== tag) continue;
    const resolved = resolveInstance(inst, credentials, catalog);
    if (!resolved) continue;
    out.push({
      id: inst.id,
      kind: resolved.adapterKind,
      baseUrl: resolved.baseUrl,
      ...(resolved.apiKey !== undefined ? { apiKey: resolved.apiKey } : {}),
      defaultModel: inst.model || resolved.entry.defaultModel,
      catalogId: inst.catalogId,
    });
  }
  return out;
}
