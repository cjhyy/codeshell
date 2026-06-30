/**
 * Tool executor — orchestrates permission checks, hooks, and execution.
 */

import { setMaxListeners } from "node:events";
import { resolve as resolvePath, isAbsolute as isAbsolutePath } from "node:path";
import type {
  ToolCall,
  ToolResult,
  Message,
  ContentBlock,
  PermissionDecision,
  RegisteredTool,
  ToolPathPolicy,
  ToolPathPolicyOperation,
} from "../types.js";
import type { HookRegistry } from "../hooks/registry.js";
import { ToolRegistry } from "./registry.js";
import { PermissionClassifier, classifyBashCommand } from "./permission.js";
import { PermissionDeniedError, ToolNotFoundError } from "../exceptions.js";
import { logger as rootLogger, getCurrentSid } from "../logging/logger.js";
import { recordToolCall, recordToolResult } from "../logging/session-recorder.js";
import { validateToolArgs } from "./validation.js";
import type { ToolContext } from "./context.js";
import type { InvestigationGuard } from "./investigation-guard.js";
import type { TaskGuard } from "./task-guard.js";
import { PLAN_MODE_ALLOWED_TOOLS } from "./plan-mode-allowlist.js";
import { enforcePathPolicyWithApproval, type PathOperation } from "./path-policy.js";
import { parsePatch } from "./builtin/apply-patch/parser.js";

type Logger = typeof rootLogger;

// A1 hardening: hooks must never promote a non-`allow` classifier
// decision to `allow`. They may otherwise adjust the decision freely
// (e.g. tighten `allow` to `deny`/`ask`, or relax `deny` to `ask` to
// request interactive confirmation — both legitimate audit patterns).
// The user remains the only source of `allow` when the classifier
// said `ask`/`deny`.
//
// See standard §S4 and spec docs/superpowers/specs/2026-05-26-a1-permission-hardening-design.md.
function clampHookDecision(
  classifier: PermissionDecision,
  hook: PermissionDecision | undefined,
): { decision: PermissionDecision; rejectedUpgrade: boolean } {
  if (!hook) return { decision: classifier, rejectedUpgrade: false };
  if (hook === "allow" && classifier !== "allow") {
    return { decision: classifier, rejectedUpgrade: true };
  }
  return { decision: hook, rejectedUpgrade: false };
}

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
    // Each parallel tool call attaches its own `abort` listener to this
    // session-wide signal (registry.ts:115). With 11+ concurrent tools —
    // common when an Agent subagent fans out reads — Node's default
    // limit of 10 fires a MaxListenersExceededWarning. The listeners are
    // removed correctly in finally blocks; raise the ceiling to silence
    // the noise without masking real leaks.
    if (signal) setMaxListeners(50, signal);
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
    // 0. Abort fast-path: if the run signal is already aborted, return a
    // synthetic error result WITHOUT running pre_tool_use hooks, the
    // permission classifier, or the handler. registry.executeTool also checks
    // abort, but only after this method has paid for all the per-tool
    // hook/permission round-trips. For an aborted sub-agent whose turn queued
    // a batch of tools (e.g. 10 Reads), this collapses the whole batch
    // instantly instead of round-tripping each one — part of the sub-agent
    // leak fix that keeps an aborted child from burning work post-abort.
    if (this.signal?.aborted) {
      return {
        id: call.id,
        toolName: call.toolName,
        error: `Tool aborted before execution: ${call.toolName}`,
        isError: true,
      };
    }
    // 0. Capability override: a builtin the project marked `off` is HIDDEN from
    // the model's tool list (engine.ts applyBuiltinOverrideVisibility), but the
    // model can still NAME it (hallucination, or a remembered earlier turn). The
    // registry still holds the tool, so without a gate here it would execute.
    // Reject it the same way plan mode rejects a disallowed tool — return an
    // error result, never run the handler.
    if (this.toolCtx?.disabledBuiltins?.has(call.toolName)) {
      return {
        id: call.id,
        toolName: call.toolName,
        error: `Tool ${call.toolName} is disabled by this project's capability override and cannot be used. Do NOT retry this tool call.`,
        isError: true,
      };
    }
    // Same gate for MCP tools: the registry is worker-shared, so it can hold
    // tools from servers OTHER sessions enabled. Visibility filtering hides
    // them from this session's tool list; this rejects a direct call anyway.
    if (this.toolCtx?.allowedMcpServers) {
      const reg = this.registry.getTool(call.toolName) as
        | { source?: string; serverName?: string }
        | null;
      if (reg?.source === "mcp" && !this.toolCtx.allowedMcpServers.has(reg.serverName ?? "")) {
        return {
          id: call.id,
          toolName: call.toolName,
          error: `Tool ${call.toolName} belongs to an MCP server that is not enabled for this project. Do NOT retry this tool call.`,
          isError: true,
        };
      }
    }
    // 0. Plan mode: only allow read-only tools — no file writes at all
    if (this.toolCtx?.planMode) {
      // Shared with engine.ts's tool-visibility filter so the set the model
      // SEES and the set the executor RUNS can't drift (they had).
      // Bash is in the allow-list so the model can SEE it for read-only probing,
      // but membership alone must NOT grant write access: a Bash command that
      // modifies files (echo >, sed -i, mv, ...) has to be blocked here too, or it
      // would slip past plan mode into the normal permission flow (where the user
      // could approve it) AND leave no diff, since it never touches Write/Edit.
      const allowed = PLAN_MODE_ALLOWED_TOOLS.has(call.toolName);
      // Defer to the canonical shell classifier (the same one the permission
      // flow uses) instead of a second hand-rolled allowlist that drifted and
      // let find -delete / awk system() / process substitution / git difftool
      // through. Plan mode is strictly read-only, so ONLY "safe-read" passes —
      // safe-write (mkdir/touch/cp), unsafe, and dangerous are all blocked.
      const bashWrite =
        call.toolName === "Bash" &&
        classifyBashCommand(String(call.args.command ?? "")) !== "safe-read";
      if (!allowed || bashWrite) {
        return {
          id: call.id,
          toolName: call.toolName,
          error:
            allowed && bashWrite
              ? `Plan mode is read-only: this Bash command writes or modifies files, which is not allowed while planning. To carry it out, first call ExitPlanMode (after the user approves your plan), then run it. Do NOT retry this command in plan mode.`
              : `Plan mode: ${call.toolName} is blocked. Only read-only tools (Read, Glob, Grep, WebSearch, WebFetch, Bash read-only) are allowed. You MUST output your plan as text in the conversation instead. Do NOT retry this tool call.`,
          isError: true,
        };
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

    // 0.65. Centralized file path policy. Tool handlers declare their file
    // path surface on RegisteredTool.pathPolicy; the executor enforces it
    // after hooks have had a chance to rewrite args, but before permission
    // classification or the handler can touch the filesystem.
    const pathPolicyError = await this.enforceDeclaredPathPolicy(toolDef, call.args);
    if (pathPolicyError) {
      return {
        id: call.id,
        toolName: call.toolName,
        error: pathPolicyError,
        isError: true,
      };
    }

    // A1 hardening: pre_tool_use can no longer pre-approve a tool via
    // `decision === "allow"`. Hooks may relax `allow` and may force
    // `ask`/`deny`, but they cannot promote a `deny`/`ask` decision to
    // `allow`. The only paths to `allow` are the classifier (rules,
    // safe-read, allowlist) and the user (interactive approval).
    if (hookResult.decision === "allow") {
      this.log.info("permission.hook_upgrade_rejected", {
        cat: "permission",
        tool: call.toolName,
        site: "pre_tool_use",
      });
    }

    // pre_tool_use can request interactive confirmation via
    // decision: "ask". We invoke the same handleAsk path the classifier
    // uses, but feed the hook's messages so the user sees the handler's
    // reasoning. If the user approves, we skip the classifier below —
    // the hook and the user together have decided.
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

    // 1. Permission check — skipped only when pre_tool_use issued an
    // `ask` that the user just approved (we don't double-prompt).
    if (hookResult.decision !== "ask") {
      const classifierDecision = this.permission.classify(call.toolName, call.args);
      this.log.info("permission.classify", {
        cat: "permission",
        tool: call.toolName,
        decision: classifierDecision,
        mode: this.permission.getMode(),
      });

      // on_permission_check hook: lets handlers audit and *downgrade*
      // the classifier decision (e.g. `allow → ask/deny`, `deny →
      // ask`). Promotion to `allow` is rejected by clampHookDecision
      // — only the classifier and the user can grant `allow`.
      const permHook = await this.hooks.emit("on_permission_check", {
        toolName: call.toolName,
        args: call.args,
        toolCallId: call.id,
        classifierDecision,
      });
      // A1 hardening: clamp hook decision to downgrades only.
      const clamped = clampHookDecision(classifierDecision, permHook.decision);
      const decision = clamped.decision;
      if (clamped.rejectedUpgrade) {
        this.log.info("permission.hook_upgrade_rejected", {
          cat: "permission",
          tool: call.toolName,
          site: "on_permission_check",
          attempted: permHook.decision,
          classifier: classifierDecision,
        });
      }
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
      // A model calling a tool that isn't in the registry (hallucinated name,
      // or a builtin missing from the active preset's whitelist) must not kill
      // the turn. Feed it back as a normal tool error so the model can retry
      // or pick a different tool — same path as permission denials above.
      if (err instanceof ToolNotFoundError) {
        return {
          id: call.id,
          toolName: call.toolName,
          error: `Tool not found: ${call.toolName}. It is not available in this session — do not call it again; use a different tool.`,
          isError: true,
        };
      }
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

  private resolvePolicyOperation(
    op: ToolPathPolicyOperation,
    args: Record<string, unknown>,
  ): PathOperation {
    if (op === "read" || op === "write") return op;
    const raw = args[op.fromArg];
    const value = typeof raw === "string" ? raw : String(raw ?? "");
    if (op.readValues?.includes(value)) return "read";
    if (op.writeValues?.includes(value)) return "write";
    return op.default;
  }

  private async enforceDeclaredPathPolicy(
    tool: RegisteredTool | undefined,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const policies = tool?.pathPolicy;
    if (!policies?.length) return null;

    for (const policy of policies) {
      const targets = this.resolvePathPolicyTargets(policy, args);
      if (typeof targets === "string") return targets;
      const operation = this.resolvePolicyOperation(policy.operation, args);
      for (const target of targets) {
        const blocked = await enforcePathPolicyWithApproval(target, operation, this.toolCtx);
        if (blocked) return blocked;
      }
    }
    return null;
  }

  private resolvePathPolicyTargets(
    policy: ToolPathPolicy,
    args: Record<string, unknown>,
  ): string[] | string {
    if (policy.kind === "arg") {
      const raw = args[policy.arg];
      if (typeof raw === "string" && raw.length > 0) {
        // Resolve a RELATIVE single-string path arg against ctx.cwd before
        // classification, mirroring the array branch below and the apply_patch
        // branch — otherwise classifyPath's process.cwd()-based resolution
        // mis-places an in-workspace relative path (e.g. Read "src/x.ts") as
        // "outside workspace" and over-prompts. Absolute paths pass through.
        const cwd = this.toolCtx?.cwd ?? process.cwd();
        return [isAbsolutePath(raw) ? raw : resolvePath(cwd, raw)];
      }
      // Array path args (e.g. GenerateImage `referenceImages`, GenerateVideo
      // `images`): enforce EVERY element. Without this an array yielded zero
      // targets, so out-of-workspace reads bypassed the path-policy "ask" gate
      // that Read/Write enforce. http(s) URLs aren't file reads → skip them.
      // Relative paths resolve against ctx.cwd (the workspace) before
      // classification, like the apply_patch branch — otherwise classifyPath's
      // process.cwd()-based resolution would mis-place an in-workspace relative
      // path as "outside" and over-prompt. Non-string / empty elements skipped.
      if (Array.isArray(raw)) {
        const cwd = this.toolCtx?.cwd ?? process.cwd();
        const paths = raw
          .filter((v): v is string => typeof v === "string" && v.length > 0)
          .filter((v) => !/^https?:\/\//i.test(v))
          .map((v) => (isAbsolutePath(v) ? v : resolvePath(cwd, v)));
        if (paths.length > 0) return paths;
      }
      if (policy.defaultToCwd && this.toolCtx?.cwd) return [this.toolCtx.cwd];
      return [];
    }

    const rawPatch = args[policy.arg];
    if (typeof rawPatch !== "string" || rawPatch.length === 0) return [];
    try {
      const parsed = parsePatch(rawPatch, "lenient");
      const cwd = this.toolCtx?.cwd ?? process.cwd();
      const targets: string[] = [];
      for (const hunk of parsed.hunks) {
        targets.push(resolvePath(cwd, hunk.path));
        if (hunk.kind === "update" && hunk.movePath) {
          targets.push(resolvePath(cwd, hunk.movePath));
        }
      }
      return targets;
    } catch (err) {
      return `Error: ${(err as Error).message}`;
    }
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
