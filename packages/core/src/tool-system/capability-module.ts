import type { RegisteredTool } from "../types.js";
import type { ToolContext } from "./context.js";
import type { ToolRegistry } from "./registry.js";
import { ConfigError } from "../exceptions.js";

export interface ExtensionTool {
  definition: RegisteredTool;
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
}

export type ExtensionQueryHandler = (
  params: Readonly<Record<string, unknown>>,
) => unknown | Promise<unknown>;

/**
 * Trusted, in-process product extension. Core owns the registration seam while
 * optional packages own their tools and diagnostic/query surface.
 */
export interface ExtensionModule {
  readonly id: string;
  readonly tools?: readonly ExtensionTool[];
  readonly queries?: Readonly<Record<string, ExtensionQueryHandler>>;
}

function validateExtensionModules(modules: readonly ExtensionModule[]): void {
  const ids = new Set<string>();
  const queries = new Set<string>();
  const tools = new Set<string>();
  for (const module of modules) {
    if (ids.has(module.id)) {
      throw new ConfigError(`Duplicate capability module id: ${module.id}`, {
        duplicateCapabilityId: module.id,
      });
    }
    ids.add(module.id);
    for (const tool of module.tools ?? []) {
      if (tools.has(tool.definition.name)) {
        throw new ConfigError(`Duplicate capability tool: ${tool.definition.name}`, {
          duplicateCapabilityTool: tool.definition.name,
        });
      }
      tools.add(tool.definition.name);
    }
    for (const query of Object.keys(module.queries ?? {})) {
      if (queries.has(query)) {
        throw new ConfigError(`Duplicate capability query: ${query}`, {
          duplicateCapabilityQuery: query,
        });
      }
      queries.add(query);
    }
  }
}

export function registerExtensionModules(
  registry: ToolRegistry,
  modules: readonly ExtensionModule[],
): void {
  validateExtensionModules(modules);
  for (const module of modules) {
    for (const tool of module.tools ?? []) {
      if (registry.hasTool(tool.definition.name)) {
        throw new ConfigError(
          `Capability tool conflicts with registered tool: ${tool.definition.name}`,
          {
            duplicateCapabilityTool: tool.definition.name,
            capabilityId: module.id,
          },
        );
      }
      registry.registerTool(tool.definition, tool.execute);
    }
  }
}

export async function queryExtensionModules(
  modules: readonly ExtensionModule[],
  type: string,
  params: Readonly<Record<string, unknown>>,
): Promise<{ handled: false } | { handled: true; data: unknown }> {
  validateExtensionModules(modules);
  for (const module of modules) {
    const handler = module.queries?.[type];
    if (handler) return { handled: true, data: await handler(params) };
  }
  return { handled: false };
}
