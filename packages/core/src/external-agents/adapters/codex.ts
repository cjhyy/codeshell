import { ClaudeCodeAdapter } from "./claude-code.js";

/**
 * Codex CLI adapter. v1 intentionally reuses the same process-management
 * behavior as the Claude Code adapter (detached process group, stdout/stderr
 * streaming, process-group kill). The actual command/args come from config,
 * so spawning `codex` vs `claude` is a config concern, not a behavior change.
 */
export class CodexAdapter extends ClaudeCodeAdapter {}
