export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface BuildArgsOpts {
  prompt: string;
  resumeSessionId?: string;
  permissionMode: PermissionMode;
  cwd: string;
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
      try { d = JSON.parse(t); } catch { continue; }
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

// codex adapter placeholder — future work; do NOT implement now.
