import { resolve } from "node:path";
import type { BuiltinTool } from "../builtin/index.js";
import type { ToolContext } from "../context.js";
import { ToolRegistry, type ToolRegistryOptions } from "../registry.js";
import type { ToolResult } from "../../types.js";

export interface FakeToolContextOptions {
  cwd?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Shallow overrides for tool-family-specific host bridges. */
  overrides?: Partial<ToolContext>;
}

export interface ToolRegistryHarnessOptions extends FakeToolContextOptions {
  builtinTools?: readonly string[];
  toolCatalog?: readonly BuiltinTool[];
  registry?: ToolRegistry;
  timeoutMs?: number;
}

export interface ToolRegistryHarness {
  registry: ToolRegistry;
  context: ToolContext;
  execute(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Shared fake ToolContext for builtin integration tests. It intentionally
 * supplies only stable harness defaults; tests opt into browser/workspace/MCP/
 * sub-agent behavior through `overrides`, so missing host seams fail visibly.
 */
export function createFakeToolContext(
  registry: ToolRegistry,
  options: FakeToolContextOptions = {},
): ToolContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const context = {
    cwd,
    setCwd(next: string) {
      context.cwd = resolve(next);
    },
    llmConfig: {},
    toolRegistry: registry,
    planMode: false,
    sessionId: options.sessionId ?? "tool-harness-session",
    signal: options.signal,
    allowBackgroundShells: false,
    toolVisibility: { hasGoal: true },
    engine: {
      getPlanMode: () => context.planMode,
      setPlanMode: (enabled: boolean) => {
        context.planMode = enabled;
      },
    },
    askUser: async () => "harness-answer",
    ...options.overrides,
  };
  return context as unknown as ToolContext;
}

/** Build a real ToolRegistry and execute through its timeout/signal/result
 * protocol while keeping host dependencies deterministic and injectable. */
export function createToolRegistryHarness(
  options: ToolRegistryHarnessOptions = {},
): ToolRegistryHarness {
  const registryOptions: ToolRegistryOptions = {
    ...(options.builtinTools ? { builtinTools: options.builtinTools } : {}),
    ...(options.toolCatalog ? { toolCatalog: options.toolCatalog } : {}),
  };
  const registry = options.registry ?? new ToolRegistry(registryOptions);
  const context = createFakeToolContext(registry, options);
  return {
    registry,
    context,
    execute: async (name, args = {}) =>
      await registry.executeTool(name, args, {
        ctx: context,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? 5_000,
      }),
  };
}
