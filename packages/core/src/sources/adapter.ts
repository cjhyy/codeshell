/** provider 无关的连接器边界（ADR §4）。core 不出现任何具体 provider 名。 */
import type { SourceContent, SourceDefinition, SourceResourceMeta, SourceScope } from "./types.js";

export interface ConnectorAdapter {
  kind: string;
  listScopes(definition: SourceDefinition): Promise<SourceScope[]>;
  listResources(definition: SourceDefinition, scopeId: string): Promise<SourceResourceMeta[]>;
  read(
    definition: SourceDefinition,
    resourceId: string,
    options: { maxBytes: number; signal?: AbortSignal; cwd?: string },
  ): Promise<SourceContent>;
}

const registry = new Map<string, ConnectorAdapter>();

export function registerConnectorAdapter(adapter: ConnectorAdapter): void {
  registry.set(adapter.kind, adapter);
}

export function connectorAdapterFor(kind: string): ConnectorAdapter | undefined {
  return registry.get(kind);
}
