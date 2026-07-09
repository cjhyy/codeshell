export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface BuildArgsOpts {
  prompt: string;
  resumeSessionId?: string;
  permissionMode: PermissionMode;
  cwd: string;
  imagePaths?: string[];
  codexImageInputSupported?: boolean;
}

export interface ParsedResult {
  sessionId: string;
  finalText: string;
  isError: boolean;
}

export interface AgentAdapter {
  /** Display name, e.g. "claude" / "codex". */
  kind: string;
  /** Build the CLI argv (command itself excluded). */
  buildArgs(opts: BuildArgsOpts): string[];
  /** Reduce collected stream-json output lines to {sessionId, finalText, isError}. */
  parseResult(lines: string[]): ParsedResult;
  /**
   * When true, the prompt is fed over stdin instead of being passed in argv.
   * claude takes the prompt as `-p <prompt>` (argv) so leaves this unset; codex
   * `exec` reads the prompt from stdin (its argv ends with a bare `-`).
   */
  promptViaStdin?: boolean;
}

/**
 * Soft cost-guard appended to a driven CC's system prompt. Workflow fans out a
 * fleet of agents and is the main token sink; we ask CC to surface intent and
 * get a go-ahead before running one, so a human can intervene (rooms) and the
 * model stays cost-aware even where Workflow isn't hard-disabled. Shared so the
 * room's resident process can reuse the exact same wording.
 */
export const CC_COST_GUARD_PROMPT =
  "Cost guard: before invoking the Workflow tool (which fans out many agents and " +
  "burns a lot of tokens), first state in one short message what workflow you intend " +
  "to run and why, and ask for a go-ahead — do NOT launch a Workflow unprompted. A " +
  "single Task sub-agent is fine without asking.";

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  buildArgs(opts) {
    // -p (print/headless) + stream-json REQUIRES --verbose (verified).
    const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    // Hard-disallow Workflow: driving CC unattended (esp. bypassPermissions),
    // CC's Workflow tool fans out a FLEET of agents — the real token-burn culprit
    // (user: "自动了 2 个 workflow token 就烧没了"). A single Task (one sub-agent)
    // is cheap, so it stays ALLOWED. (We earlier disallowed Task by mistake;
    // Workflow is the one that fans out.) Disabling outright is cleaner than an
    // approval round-trip this path doesn't have.
    args.push("--disallowedTools", "Workflow");
    // Soft constraint (belt-and-suspenders + carries to rooms where Workflow is
    // allowed): ask CC to check in before expensive multi-agent work.
    args.push("--append-system-prompt", CC_COST_GUARD_PROMPT);
    args.push("--permission-mode", opts.permissionMode);
    return args;
  },
  parseResult(lines) {
    let sessionId = "";
    let finalText = "";
    let isError = false;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let d: any;
      try {
        d = JSON.parse(t);
      } catch {
        continue;
      }
      if (typeof d.session_id === "string" && !sessionId) sessionId = d.session_id;
      if (d.type === "result") {
        if (typeof d.session_id === "string") sessionId = d.session_id;
        if (typeof d.result === "string") finalText = d.result;
        isError = Boolean(d.is_error);
      }
    }
    return { sessionId, finalText, isError };
  },
};

/**
 * Drives the OpenAI Codex CLI via `codex exec`. Mirrors claudeAdapter but for
 * codex's different surface:
 *  - prompt is fed over STDIN (argv ends with a bare `-`), not argv → promptViaStdin
 *  - permission is a spawn-time SANDBOX choice, not a per-tool approval loop:
 *      default        → --sandbox read-only      (codex can read, not write)
 *      acceptEdits    → --sandbox workspace-write (codex can write the workspace)
 *      bypassPermissions → --dangerously-bypass-approvals-and-sandbox (full auto)
 *    (Matches the only model codex supports — same choice the `wand` tool makes;
 *    codex has no `--permission-prompt-tool stdio` equivalent.)
 *  - JSONL event shape differs: session id is `thread.started`.thread_id, the
 *    final answer is the last `item.completed` of item.type "agent_message", and
 *    failure is `turn.failed` / `error` events (no `is_error` flag).
 */
export const codexAdapter: AgentAdapter = {
  kind: "codex",
  promptViaStdin: true,
  buildArgs(opts) {
    const args = ["exec", "--json", "--color", "never", "--skip-git-repo-check"];
    if (opts.permissionMode === "bypassPermissions") {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    } else {
      args.push(
        "--sandbox",
        opts.permissionMode === "acceptEdits" ? "workspace-write" : "read-only",
      );
    }
    if (opts.codexImageInputSupported) {
      for (const imagePath of opts.imagePaths ?? []) args.push("-i", imagePath);
    }
    // `resume <thread_id>` continues a prior codex session; the trailing `-`
    // tells codex exec to read the prompt from stdin (we feed it there).
    if (opts.resumeSessionId) args.push("resume", opts.resumeSessionId, "-");
    else args.push("-");
    return args;
  },
  parseResult(lines) {
    let sessionId = "";
    let finalText = "";
    let isError = false;
    const errorBits: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let d: any;
      try {
        d = JSON.parse(t);
      } catch {
        continue;
      }
      if (d.type === "thread.started" && typeof d.thread_id === "string") sessionId = d.thread_id;
      else if (
        d.type === "item.completed" &&
        d.item?.type === "agent_message" &&
        typeof d.item.text === "string"
      ) {
        finalText = d.item.text; // keep the LAST agent_message
      } else if (d.type === "turn.failed") {
        isError = true;
        const msg = d.error?.message ?? d.error ?? "turn failed";
        if (typeof msg === "string") errorBits.push(msg);
      } else if (d.type === "error") {
        isError = true;
        const msg = d.message ?? d.error?.message ?? d.error ?? "error";
        if (typeof msg === "string") errorBits.push(msg);
      }
    }
    // On failure, surface the error text as finalText (so the caller/notification
    // shows *why*), preferring it over any partial agent_message.
    if (isError && errorBits.length) finalText = errorBits.join("\n");
    return { sessionId, finalText, isError };
  },
};
