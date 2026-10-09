/** provider 无关的连接器边界（ADR §4）。core 不出现任何具体 provider 名。 */
import type { SourceContent, SourceDefinition, SourceResourceMeta, SourceScope } from "./types.js";
import type { SettingsScope } from "../settings/manager.js";
import type { ToolContext } from "../tool-system/context.js";

/** The caller's credential authority; adapters must never promote project scope. */
export interface SourceAdapterContext {
  cwd?: string;
  settingsScope?: SettingsScope;
  signal?: AbortSignal;
  executeBoundTool?: ToolContext["executeBoundTool"];
  /** Owning Run's native MCP binding; never supplied by source arguments. */
  mcpContext?: ToolContext;
  assertAuthorized?: () => void;
  documentParserExecutable?: ToolContext["documentParserExecutable"];
}

export interface ConnectorAdapter {
  kind: string;
  listScopes(definition: SourceDefinition, context?: SourceAdapterContext): Promise<SourceScope[]>;
  listResources(
    definition: SourceDefinition,
    scopeId: string,
    context?: SourceAdapterContext,
  ): Promise<SourceResourceMeta[]>;
  read(
    definition: SourceDefinition,
    resourceId: string,
    options: SourceAdapterContext & {
      maxBytes: number;
      /** Uploaded documents only; the exact source/scope/resource remains required. */
      query?: string;
      limit?: number;
      chunk?: string;
    },
  ): Promise<SourceContent>;
}

const registry = new Map<string, ConnectorAdapter>();

export function registerConnectorAdapter(adapter: ConnectorAdapter): void {
  registry.set(adapter.kind, adapter);
}

export function connectorAdapterFor(kind: string): ConnectorAdapter | undefined {
  return registry.get(kind);
}
