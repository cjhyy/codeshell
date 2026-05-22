/**
 * Unified tool registry — built-in tools + MCP tools.
 */

import type { RegisteredTool, ToolDefinition, ToolResult } from "../types.js";
import { ConfigError, ToolNotFoundError, ToolExecutionError, ToolTimeoutError } from "../exceptions.js";
import { BUILTIN_TOOLS, type BuiltinToolFn } from "./builtin/index.js";
import type { ToolContext } from "./context.js";

/**
 * Default execution timeout for any tool that does not declare its own
 * timeoutMs at registration time. Tools that need to run longer (Agent,
 * Arena, Bash, custom long-running tools) should set timeoutMs explicitly.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface ToolRegistryOptions {
  builtinTools?: readonly string[];
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private builtinExecutors = new Map<string, BuiltinToolFn>();

  constructor(options: ToolRegistryOptions = {}) {
    this.registerBuiltins(options.builtinTools);
  }

  private registerBuiltins(selectedBuiltinTools?: readonly string[]): void {
    const availableNames = new Set(BUILTIN_TOOLS.map((tool) => tool.definition.name));
    const selectedNames = selectedBuiltinTools ? new Set(selectedBuiltinTools) : null;

    if (selectedNames) {
      const unknown = [...selectedNames].filter((name) => !availableNames.has(name));
      if (unknown.length > 0) {
        throw new ConfigError(
          `Unknown built-in tool(s): ${unknown.join(", ")}`,
          { unknownBuiltinTools: unknown },
        );
      }
    }

    for (const tool of BUILTIN_TOOLS) {
      if (selectedNames && !selectedNames.has(tool.definition.name)) {
        continue;
      }
      this.tools.set(tool.definition.name, tool.definition);
      this.builtinExecutors.set(tool.definition.name, tool.execute);
    }
  }

  registerTool(tool: RegisteredTool, executor?: BuiltinToolFn): void {
    this.tools.set(tool.name, tool);
    if (executor) {
      this.builtinExecutors.set(tool.name, executor);
    }
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async executeTool(
    name: string,
    args: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal; ctx?: ToolContext },
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }

    const executor = this.builtinExecutors.get(name);
    if (!executor) {
      throw new ToolExecutionError(name, "No executor registered for this tool");
    }

    // Tool timeout precedence:
    //   options.timeoutMs (per-call override) > tool.timeoutMs (declared at registration) > default 120s.
    // To run longer, declare timeoutMs on the tool (e.g. Agent/Arena: 30min, Bash: 1h).
    const timeout = options?.timeoutMs ?? tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const parentSignal = options?.signal;
    const id = `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Check if already aborted before starting
    if (parentSignal?.aborted) {
      return {
        id,
        toolName: name,
        error: `Tool aborted before execution: ${name}`,
        isError: true,
      };
    }

    // Create a child AbortController that aborts on timeout OR parent abort
    const childController = new AbortController();
    const timerId = timeout > 0
      ? setTimeout(() => childController.abort(new ToolTimeoutError(name, timeout)), timeout)
      : undefined;

    // Cascade parent abort to child
    const onParentAbort = () => childController.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });

    // Inject the abort signal into args so tools (like Agent) can use it
    const argsWithSignal = { ...args, __signal: childController.signal };

    // Build per-call ctx: caller's ctx (if any) + this call's signal
    const ctx: ToolContext | undefined = options?.ctx
      ? { ...options.ctx, signal: childController.signal }
      : undefined;

    try {
      const result = await Promise.race([
        executor(argsWithSignal, ctx),
        new Promise<never>((_, reject) => {
          childController.signal.addEventListener("abort", () => {
            const reason = childController.signal.reason;
            reject(reason instanceof ToolTimeoutError ? reason : new Error("Tool aborted"));
          }, { once: true });
        }),
      ]);

      clearTimeout(timerId);
      parentSignal?.removeEventListener("abort", onParentAbort);
      return { id, toolName: name, result };
    } catch (err) {
      clearTimeout(timerId);
      parentSignal?.removeEventListener("abort", onParentAbort);

      // Always return error as ToolResult, never throw
      let errorMsg: string;
      const isAbort =
        (err as Error)?.name === "AbortError" ||
        parentSignal?.aborted === true;
      if (err instanceof ToolTimeoutError) {
        errorMsg = `Tool timed out after ${timeout}ms: ${name}`;
      } else if (isAbort) {
        errorMsg = `Tool aborted: ${name}`;
      } else {
        errorMsg = (err as Error).message;
      }

      return { id, toolName: name, error: errorMsg, isError: true };
    }
  }

  listTools(): string[] {
    return [...this.tools.keys()];
  }

  listToolsDetailed(): RegisteredTool[] {
    return [...this.tools.values()];
  }
}
