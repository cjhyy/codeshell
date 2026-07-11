/**
 * Unified tool registry — built-in tools + MCP tools.
 */

import type { RegisteredTool, ToolDefinition, ToolResult } from "../types.js";
import {
  ConfigError,
  ToolNotFoundError,
  ToolExecutionError,
  ToolTimeoutError,
} from "../exceptions.js";
import { BUILTIN_TOOLS, type BuiltinToolFn, toToolExecutionResult } from "./builtin/index.js";
import type { ToolContext } from "./context.js";
import { validateToolMetadata } from "./validate-tool-metadata.js";

/**
 * Default execution timeout for any tool that does not declare its own
 * timeoutMs at registration time. Tools that need to run longer (Agent,
 * Arena, Bash, custom long-running tools) should set timeoutMs explicitly.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

export interface ToolRegistryOptions {
  builtinTools?: readonly string[];
}

type ToolImplementation = (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;

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
        throw new ConfigError(`Unknown built-in tool(s): ${unknown.join(", ")}`, {
          unknownBuiltinTools: unknown,
        });
      }
    }

    for (const tool of BUILTIN_TOOLS) {
      if (selectedNames && !selectedNames.has(tool.definition.name)) {
        continue;
      }
      // Fail loud on pathPolicy.arg drift rather than silently disabling path
      // protection (assessment §4.1).
      validateToolMetadata(tool.definition);
      this.tools.set(tool.definition.name, tool.definition);
      this.builtinExecutors.set(tool.definition.name, tool.execute);
    }
  }

  registerTool(tool: RegisteredTool, executor?: ToolImplementation): void {
    validateToolMetadata(tool);
    this.tools.set(tool.name, tool);
    if (executor) {
      this.builtinExecutors.set(tool.name, async (args, ctx) =>
        toToolExecutionResult(await executor(args, ctx)),
      );
    }
  }

  unregisterTool(name: string): void {
    this.tools.delete(name);
    this.builtinExecutors.delete(name);
  }

  getToolDefinitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      sensitiveResult: t.sensitiveResult,
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
    let timedOut = false;
    const timerId =
      timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            childController.abort(new ToolTimeoutError(name, timeout));
          }, timeout)
        : undefined;

    // Cascade parent abort to child
    const onParentAbort = () => childController.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", onParentAbort, { once: true });
    if (parentSignal?.aborted) onParentAbort();

    // Inject the abort signal into args so tools (like Agent) can use it
    const argsWithSignal = { ...args, __signal: childController.signal };

    // Build per-call ctx: caller's ctx (if any) + this call's signal
    const ctx: ToolContext | undefined = options?.ctx
      ? { ...options.ctx, signal: childController.signal }
      : undefined;

    let onChildAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onChildAbort = () => {
        const reason = childController.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : Object.assign(new Error("Tool aborted"), { name: "AbortError" }),
        );
      };
      childController.signal.addEventListener("abort", onChildAbort, { once: true });
      if (childController.signal.aborted) onChildAbort();
    });
    const cleanup = () => {
      clearTimeout(timerId);
      parentSignal?.removeEventListener("abort", onParentAbort);
      if (onChildAbort) childController.signal.removeEventListener("abort", onChildAbort);
    };

    try {
      const result = await Promise.race([executor(argsWithSignal, ctx), aborted]);
      if (childController.signal.aborted) {
        throw childController.signal.reason instanceof Error
          ? childController.signal.reason
          : Object.assign(new Error("Tool aborted"), { name: "AbortError" });
      }
      cleanup();
      if (!result.ok) {
        return {
          id,
          toolName: name,
          error: result.error,
          isError: true,
          sandbox: result.sandbox,
        };
      }
      return {
        id,
        toolName: name,
        result: result.result ?? (result.contentBlocks ? "(image)" : ""),
        contentBlocks: result.contentBlocks,
        sandbox: result.sandbox,
        sensitive: result.sensitive,
        displayResult: result.displayResult,
        transcriptResult: result.transcriptResult,
        isError: false,
      };
    } catch (err) {
      cleanup();

      // Always return error as ToolResult, never throw
      let errorMsg: string;
      const isAbort = (err as Error)?.name === "AbortError" || parentSignal?.aborted === true;
      if (timedOut || err instanceof ToolTimeoutError) {
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
