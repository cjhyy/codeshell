/**
 * Tool executor — orchestrates permission checks, hooks, and execution.
 */

import type { ToolCall, ToolResult, Message, ContentBlock } from "../types.js";
import type { HookRegistry } from "../hooks/registry.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier } from "./permission.js";
import { PermissionDeniedError } from "../exceptions.js";
import { logger as rootLogger, getCurrentSid } from "../logging/logger.js";
import { recordToolCall, recordToolResult } from "../logging/session-recorder.js";
import { isInPlanMode } from "./builtin/plan.js";
import { validateToolArgs } from "./validation.js";
import type { ToolContext } from "./context.js";
import type { InvestigationGuard } from "./investigation-guard.js";
import type { TaskGuard } from "./task-guard.js";

type Logger = typeof rootLogger;

export class ToolExecutor {
  private signal?: AbortSignal;
  /** Per-Engine ToolContext injected for every tool call. */
  private toolCtx?: ToolContext;
  /**
   * Turn-scoped logger set by TurnLoop at the top of each iteration.
   * Falls back to the root logger so executor calls outside the turn loop
   * (tests, ad-hoc tool runs) still write log lines, just without turn tags.
   */
  private log: Logger = rootLogger;
  private guard?: InvestigationGuard;
  private taskGuard?: TaskGuard;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly permission: PermissionClassifier,
    private readonly hooks: HookRegistry,
  ) {}

  setInvestigationGuard(guard: InvestigationGuard | undefined): void {
    this.guard = guard;
  }

  getInvestigationGuard(): InvestigationGuard | undefined {
    return this.guard;
  }

  setTaskGuard(guard: TaskGuard | undefined): void {
    this.taskGuard = guard;
  }

  getTaskGuard(): TaskGuard | undefined {
    return this.taskGuard;
  }

  /** Set the abort signal for cascading cancellation. */
  setSignal(signal?: AbortSignal): void {
    this.signal = signal;
  }

  /** Set the per-Engine ToolContext (askUser, llmConfig, modelPool, etc.). */
  setContext(ctx: ToolContext | undefined): void {
    this.toolCtx = ctx;
  }

  /** Inject a turn-scoped logger so tool-execution lines carry turn/turnId. */
  setLogger(log: Logger): void {
    this.log = log;
    this.permission.setLogger(log);
  }

  /** Check if a tool is safe for concurrent execution (read-only). */
  isConcurrencySafe(toolName: string): boolean {
    const tool = this.registry.getTool(toolName);
    return tool?.isConcurrencySafe ?? false;
  }

  async executeSingle(callIn: ToolCall): Promise<ToolResult> {
    // Local `call` so we can rewrite args via pre_tool_use updatedInput
    // without mutating the caller's object.
    let call: ToolCall = callIn;
    // 0. Plan mode: only allow read-only tools — no file writes at all
    if (isInPlanMode()) {
      const allowedInPlan = new Set([
        "EnterPlanMode",
        "ExitPlanMode",
        "Read",
        "Glob",
        "Grep",
        "WebSearch",
        "WebFetch",
        "AskUserQuestion",
        "Agent",
        "ToolSearch",
        "TodoWrite",
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
        return {
          id: call.id,
          toolName: call.toolName,
          error: `Invalid input: ${validationError}`,
          isError: true,
        };
      }
    }

    // 0.6. Pre-tool-use hook (can approve/deny before execution)
    const hookResult = await this.hooks.emit("pre_tool_use", {
      toolName: call.toolName,
      args: call.args,
      toolCallId: call.id,
    });
    if (hookResult.decision === "deny") {
      return {
        id: call.id,
        toolName: call.toolName,
        error: `Blocked by pre_tool_use hook: ${hookResult.messages?.join(", ") ?? "denied"}`,
        isError: true,
      };
    }
    // pre_tool_use can rewrite the args for sanitizer / normalizer use
    // cases. Re-validate against the schema so a malformed rewrite
    // surfaces as the standard "Invalid input" error rather than
    // silently corrupting downstream execution.
    if (hookResult.updatedInput !== undefined) {
      call = { ...call, args: hookResult.updatedInput };
      if (toolDef?.inputSchema) {
        const revalidation = validateToolArgs(call.toolName, call.args, toolDef.inputSchema);
        if (revalidation) {
          return {
            id: call.id,
            toolName: call.toolName,
            error: `Invalid input (after pre_tool_use rewrite): ${revalidation}`,
            isError: true,
          };
        }
      }
      this.log.info("hook.updated_input", {
        cat: "tool",
        tool: call.toolName,
        toolCallId: call.id,
      });
    }

    // pre_tool_use can pre-approve a tool, bypassing the PermissionClassifier.
    // This is the dual of "deny" — handler overrides the rule set. We still
    // run the investigation guard and the sandbox afterwards: those are
    // independent safety layers, not permission decisions.
    const hookAllowed = hookResult.decision === "allow";

    // pre_tool_use can request interactive confirmation via decision: "ask".
    // We invoke the same handleAsk path the classifier uses, but feed the
    // hook's messages so the user sees the handler's reasoning.
    if (hookResult.decision === "ask") {
      const reason = hookResult.messages?.join("\n") ?? undefined;
      const approved = await this.permission.handleAsk(
        call.toolName,
        call.args,
        reason,
      );
      if (!approved) {
        return {
          id: call.id,
          toolName: call.toolName,
          error: `Tool call denied by user (pre_tool_use ask).`,
          isError: true,
        };
      }
      // User approved — fall through, skipping the classifier (the hook
      // and the user together have already decided).
    }

    // 0.7. Investigation guard — block redundant reads and tag soft reminders
    // onto results. See investigation-guard.ts for the rules; they enforce the
    // soft prompt guidance in coding.md ("never re-read", "3-call budget").
    const guardDecision = this.guard?.preToolCheck(call);
    if (guardDecision?.block) {
      this.log.info("guard.block", { cat: "guard", tool: call.toolName, reason: guardDecision.block.slice(0, 200) });
      return {
        id: call.id,
        toolName: call.toolName,
        error: guardDecision.block,
        isError: true,
      };
    }

    // 1. Permission check — skipped when the hook already approved.
    if (!hookAllowed && hookResult.decision !== "ask") {
      const classifierDecision = this.permission.classify(call.toolName, call.args);
      this.log.info("permission.classify", {
        cat: "permission",
        tool: call.toolName,
        decision: classifierDecision,
        mode: this.permission.getMode(),
      });

      // on_permission_check hook: lets handlers audit AND override the
      // classifier decision (allow|deny|ask). Final priority order is:
      //   pre_tool_use hook (deny/allow/ask above)  > classifier rules
      //   on_permission_check hook (here)           > classifier rules
      //   pre_tool_use already-decided cases skip both.
      // If multiple handlers return decisions, the highest-priority wins
      // (HookRegistry preserves last-write semantics — last handler's
      // decision is the aggregated one).
      const permHook = await this.hooks.emit("on_permission_check", {
        toolName: call.toolName,
        args: call.args,
        toolCallId: call.id,
        classifierDecision,
      });
      const decision = permHook.decision ?? classifierDecision;
      if (decision !== classifierDecision) {
        this.log.info("permission.hook_override", {
          cat: "permission",
          tool: call.toolName,
          from: classifierDecision,
          to: decision,
        });
      }

      if (decision === "deny") {
        return {
          id: call.id,
          toolName: call.toolName,
          error: `Permission denied for tool: ${call.toolName}`,
          isError: true,
        };
      }

      if (decision === "ask") {
        const reason = permHook.messages?.join("\n");
        const approved = await this.permission.handleAsk(call.toolName, call.args, reason);
        if (!approved) {
          return {
            id: call.id,
            toolName: call.toolName,
            error: `Permission denied by user for tool: ${call.toolName}`,
            isError: true,
          };
        }
      }
    } else {
      this.log.info("permission.hook_override", {
        cat: "permission",
        tool: call.toolName,
        decision: hookResult.decision,
      });
    }

    // 2. Pre-tool hook
    await this.hooks.emit("on_tool_start", {
      toolName: call.toolName,
      args: call.args,
      toolCallId: call.id,
    });

    // 3. Execute. Use a span so begin/end share one cat and end carries
    // duration_ms; widen args truncation from 200→2000 so Edit/Write payloads
    // (file_path + a chunk of code) actually show what was changed instead of
    // just the path. End-event also records a result snippet on failure for
    // post-mortem without having to crack the full transcript.
    const span = this.log.span("tool.exec", {
      cat: "tool",
      tool: call.toolName,
      toolCallId: call.id,
      args: JSON.stringify(call.args).slice(0, 2000),
    });
    const sid = getCurrentSid();
    recordToolCall(sid, { id: call.id, toolName: call.toolName, args: call.args });
    const toolStartedAt = Date.now();
    let result: ToolResult;
    try {
      result = await this.registry.executeTool(call.toolName, call.args, {
        signal: this.signal,
        ctx: this.toolCtx,
      });
    } catch (err) {
      span.fail(err);
      recordToolResult(sid, {
        id: call.id,
        toolName: call.toolName,
        ok: false,
        durationMs: Date.now() - toolStartedAt,
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
      throw err;
    }
    result.id = call.id;
    // Prepend any non-blocking guard reminder onto a successful result so the
    // model sees it on its next turn alongside the content it just fetched.
    if (guardDecision?.prepend && !result.error && result.result) {
      result.result = `${guardDecision.prepend}\n${result.result}`;
    }
    const payload = result.result ?? result.error ?? "";
    span.end({
      ok: !result.error,
      chars: payload.length,
      // Snippet only on failure — successful tool output can be huge and is
      // already on the transcript. Failures are rare and the first 500 chars
      // usually contain the message we need.
      ...(result.error ? { errorSnippet: payload.slice(0, 500) } : {}),
    });
    recordToolResult(sid, {
      id: call.id,
      toolName: call.toolName,
      ok: !result.error,
      durationMs: Date.now() - toolStartedAt,
      output: result.error ? undefined : result.result,
      error: result.error,
    });

    // 4. Post-tool hook
    await this.hooks.emit("on_tool_end", {
      toolName: call.toolName,
      toolCallId: call.id,
      result: result.result,
      error: result.error,
    });

    // 5. Post-tool-use hook (after execution, can observe/modify result)
    const postHook = await this.hooks.emit("post_tool_use", {
      toolName: call.toolName,
      toolCallId: call.id,
      result: result.result,
      error: result.error,
    });
    // Append handler-supplied context (linter output, type-check result,
    // etc.) onto the tool result so the model sees it on the next turn.
    // Tagged with a separator so the model can tell hook output from
    // tool output. Skip when the tool errored — additional context on a
    // failed tool would be confusing.
    if (postHook.additionalContext && !result.error) {
      const tag = "--- additional context from post_tool_use hook ---";
      result.result = result.result
        ? `${result.result}\n\n${tag}\n${postHook.additionalContext}`
        : `${tag}\n${postHook.additionalContext}`;
      this.log.info("hook.additional_context", {
        cat: "tool",
        tool: call.toolName,
        toolCallId: call.id,
        chars: postHook.additionalContext.length,
      });
    }

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

    // Reject shell metacharacters that could chain a write command after a
    // read-only prefix: ; && || ` $(...) redirections. A single pipe (|) is
    // still allowed — the per-part whitelist further down validates it.
    const DANGEROUS = /;|&&|\|\||`|\$\(|>/;
    if (DANGEROUS.test(cmd)) return false;

    // Extract the base command (first word, ignoring env vars like VAR=val)
    const baseCmd = cmd.replace(/^(\w+=\S+\s+)*/, "").split(/\s/)[0];

    const readOnlyCommands = new Set([
      "ls",
      "find",
      "cat",
      "head",
      "tail",
      "wc",
      "file",
      "stat",
      "tree",
      "du",
      "df",
      "pwd",
      "echo",
      "which",
      "type",
      "env",
      "printenv",
      "grep",
      "rg",
      "ag",
      "awk",
      "less",
      "more",
      "sort",
      "uniq",
      "diff",
      "readlink",
      "realpath",
      "basename",
      "dirname",
      "date",
      "whoami",
      "uname",
      "hostname",
      "id",
      "groups",
      "locale",
      "uptime",
    ]);

    // Whitelisted read-only git/tool subcommands.
    // Deliberately exclude `node -e`, `python -c`, `sed -n`, etc. — those can
    // execute arbitrary code even though they "look read-only".
    const readOnlyPrefixes = [
      "git log",
      "git status",
      "git diff",
      "git branch",
      "git show",
      "git blame",
      "git remote",
      "git tag",
      "git stash list",
      "git rev-parse",
      "npx tsc --noEmit",
    ];

    if (readOnlyCommands.has(baseCmd)) return true;
    if (readOnlyPrefixes.some((p) => cmd.startsWith(p))) return true;

    // Allow piped commands if all parts are read-only. Redirections were
    // already rejected above, so a bare `|` here is a real pipeline.
    if (cmd.includes("|")) {
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
        content: result.error ? `Error: ${result.error}` : (result.result ?? "(no output)"),
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
