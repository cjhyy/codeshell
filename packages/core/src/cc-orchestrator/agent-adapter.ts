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

export const claudeAdapter: AgentAdapter = {
  kind: "claude",
  buildArgs(opts) {
    // -p (print/headless) + stream-json REQUIRES --verbose (verified).
    const args = ["-p", opts.prompt, "--output-format", "stream-json", "--verbose"];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
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
