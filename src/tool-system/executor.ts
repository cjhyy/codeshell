/**
 * Tool executor — orchestrates permission checks, hooks, and execution.
 */

import type { ToolCall, ToolResult, Message, ContentBlock } from "../types.js";
import type { HookRegistry } from "../hooks/registry.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { PermissionDeniedError } from "../exceptions.js";
import { logger } from "../logging/logger.js";
import { isInPlanMode } from "./builtin/plan.js";
import { validateToolArgs } from "./validation.js";

export class ToolExecutor {
  private signal?: AbortSignal;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly permission: PermissionClassifier,
    private readonly hooks: HookRegistry,
  ) {}

  /** Set the abort signal for cascading cancellation. */
  setSignal(signal?: AbortSignal): void {
    this.signal = signal;
  }

  /** Check if a tool is safe for concurrent execution (read-only). */
  isConcurrencySafe(toolName: string): boolean {
    const tool = this.registry.getTool(toolName);
    return tool?.isConcurrencySafe ?? false;
  }

  async executeSingle(call: ToolCall): Promise<ToolResult> {
    // 0. Plan mode: only allow read-only tools — no file writes at all
    if (isInPlanMode()) {
      const allowedInPlan = new Set([
        "EnterPlanMode", "ExitPlanMode",
        "Read", "Glob", "Grep",
        "WebSearch", "WebFetch",
        "AskUserQuestion", "Agent", "ToolSearch",
        "TaskCreate", "TaskUpdate", "TaskList", "TaskGet",
      ]);

      if (!allowedInPlan.has(call.toolName)) {
        if (call.toolName === "Bash" && this.isReadOnlyBashCommand(call.args)) {
          // Read-only bash is fine
        } else {
          return {
            id: call.id,
            toolName: call.toolName,
            error: `Plan mode: ${call.toolName} is blocked. Only read-only tools (Read, Glob, Grep, WebSearch, WebFetch, Bash read-only) are allowed. You MUST output your plan as text in the conversation instead. Do NOT retry this tool call.`,
            isError: true,
          };
        }
      }
    }

    // 0.5. Validate tool args
    const toolDef = this.registry.getTool(call.toolName);
    if (toolDef?.inputSchema) {
      const validationError = validateToolArgs(call.toolName, call.args, toolDef.inputSchema);
      if (validationError) {
        return { id: call.id, toolName: call.toolName, error: `Invalid input: ${validationError}`, isError: true };
      }
    }

    // 0.6. Pre-tool-use hook (can approve/deny before execution)
    const hookResult = await this.hooks.emit("pre_tool_use", {
      toolName: call.toolName,
      args: call.args,
      toolCallId: call.id,
    });
    if (hookResult.decision === "deny") {
      return { id: call.id, toolName: call.toolName, error: `Blocked by pre_tool_use hook: ${hookResult.messages?.join(", ") ?? "denied"}`, isError: true };
    }

    // 1. Permission check
    const decision = this.permission.classify(call.toolName, call.args);

    if (decision === "deny") {
      return {
        id: call.id,
        toolName: call.toolName,
        error: `Permission denied for tool: ${call.toolName}`,
        isError: true,
      };
    }

    if (decision === "ask") {
      const approved = await this.permission.handleAsk(call.toolName, call.args);
      if (!approved) {
        return {
          id: call.id,
          toolName: call.toolName,
          error: `Permission denied by user for tool: ${call.toolName}`,
          isError: true,
        };
      }
    }

    // 2. Pre-tool hook
    await this.hooks.emit("on_tool_start", {
      toolName: call.toolName,
      args: call.args,
      toolCallId: call.id,
    });

    // 3. Execute
    logger.info("tool.exec", { tool: call.toolName, args: JSON.stringify(call.args).slice(0, 200) });
    const result = await this.registry.executeTool(call.toolName, call.args, { signal: this.signal });
    result.id = call.id;
    logger.info("tool.done", { tool: call.toolName, ok: !result.error, chars: (result.result ?? result.error ?? "").length });

    // 4. Post-tool hook
    await this.hooks.emit("on_tool_end", {
      toolName: call.toolName,
      toolCallId: call.id,
      result: result.result,
      error: result.error,
    });

    // 5. Post-tool-use hook (after execution, can observe/modify result)
    await this.hooks.emit("post_tool_use", {
      toolName: call.toolName,
      toolCallId: call.id,
      result: result.result,
      error: result.error,
    });

    // 6. file_changed hook for Write/Edit tools
    if ((call.toolName === "Write" || call.toolName === "Edit") && !result.error) {
      await this.hooks.emit("file_changed", {
        toolName: call.toolName,
        filePath: call.args.file_path as string,
      });
    }

    return result;
  }

  private isReadOnlyBashCommand(args: Record<string, unknown>): boolean {
    const cmd = String(args.command ?? "").trim();
    // Extract the base command (first word, ignoring env vars like VAR=val)
    const baseCmd = cmd.replace(/^(\w+=\S+\s+)*/, "").split(/\s/)[0];

    const readOnlyCommands = new Set([
      "ls", "find", "cat", "head", "tail", "wc", "file", "stat",
      "tree", "du", "df", "pwd", "echo", "which", "type", "env", "printenv",
      "grep", "rg", "ag", "awk", "less", "more", "sort", "uniq", "diff",
      "readlink", "realpath", "basename", "dirname", "date", "whoami",
      "uname", "hostname", "id", "groups", "locale", "uptime",
    ]);

    const readOnlyPrefixes = [
      "git log", "git status", "git diff", "git branch", "git show", "git blame",
      "git remote", "git tag", "git stash list", "git rev-parse",
      "node -e", "node --eval", "npx tsc --noEmit",
      "sed -n", "python -c", "python3 -c",
    ];

    if (readOnlyCommands.has(baseCmd)) return true;
    if (readOnlyPrefixes.some((p) => cmd.startsWith(p))) return true;

    // Allow piped commands if all parts are read-only
    if (cmd.includes("|") && !cmd.includes(">") && !cmd.includes(">>")) {
      const parts = cmd.split("|").map((p) => p.trim());
      return parts.every((part) => {
        const partBase = part.replace(/^(\w+=\S+\s+)*/, "").split(/\s/)[0];
        return readOnlyCommands.has(partBase);
      });
    }

    return false;
  }

  async executeAll(calls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    // Separate safe (concurrent) and unsafe (sequential) tools
    const safe: ToolCall[] = [];
    const unsafe: ToolCall[] = [];

    for (const call of calls) {
      const tool = this.registry.getTool(call.toolName);
      if (tool?.isConcurrencySafe) {
        safe.push(call);
      } else {
        unsafe.push(call);
      }
    }

    // Execute safe tools concurrently
    if (safe.length > 0) {
      const safeResults = await Promise.all(safe.map((c) => this.executeSingle(c)));
      results.push(...safeResults);
    }

    // Execute unsafe tools sequentially
    for (const call of unsafe) {
      const result = await this.executeSingle(call);
      results.push(result);
    }

    return results;
  }

  /**
   * Convert tool results into Message entries for the transcript.
   */
  resultsToMessages(toolCalls: ToolCall[], results: ToolResult[]): Message[] {
    const blocks: ContentBlock[] = [];

    for (const result of results) {
      blocks.push({
        type: "tool_result",
        tool_use_id: result.id,
        content: result.error
          ? `Error: ${result.error}`
          : result.result ?? "(no output)",
      });
    }

    return [
      {
        role: "user",
        content: blocks,
      },
    ];
  }
}
