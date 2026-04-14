/**
 * Custom exception hierarchy for the code-shell framework.
 */

export class FrameworkError extends Error {
  constructor(
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FrameworkError";
  }
}

// ─── LLM Errors ───────────────────────────────────────────────────

export class LLMError extends FrameworkError {
  constructor(
    message: string,
    public readonly provider?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.name = "LLMError";
  }
}

export class LLMRateLimitError extends LLMError {
  constructor(
    provider: string,
    public readonly retryAfter?: number,
  ) {
    super(`Rate limit exceeded for ${provider}`, provider, { retryAfter });
    this.name = "LLMRateLimitError";
  }
}

export class ContextLimitError extends LLMError {
  constructor(provider?: string) {
    super("Context limit exceeded", provider);
    this.name = "ContextLimitError";
  }
}

// ─── Tool Errors ──────────────────────────────────────────────────

export class ToolError extends FrameworkError {
  constructor(
    message: string,
    public readonly toolName?: string,
    details?: Record<string, unknown>,
  ) {
    super(message, details);
    this.name = "ToolError";
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(toolName: string) {
    super(`Tool not found: ${toolName}`, toolName);
    this.name = "ToolNotFoundError";
  }
}

export class ToolExecutionError extends ToolError {
  constructor(
    toolName: string,
    cause: string,
  ) {
    super(`Tool execution failed: ${toolName} - ${cause}`, toolName, { cause });
    this.name = "ToolExecutionError";
  }
}

export class ToolTimeoutError extends ToolError {
  constructor(
    toolName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Tool timed out after ${timeoutMs}ms: ${toolName}`, toolName, { timeoutMs });
    this.name = "ToolTimeoutError";
  }
}

// ─── Permission Errors ────────────────────────────────────────────

export class PermissionDeniedError extends FrameworkError {
  constructor(
    toolName: string,
    reason?: string,
  ) {
    super(`Permission denied for tool: ${toolName}${reason ? ` - ${reason}` : ""}`, {
      toolName,
      reason,
    });
    this.name = "PermissionDeniedError";
  }
}

// ─── Session Errors ───────────────────────────────────────────────

export class SessionError extends FrameworkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "SessionError";
  }
}

export class TranscriptError extends FrameworkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "TranscriptError";
  }
}

// ─── Config Errors ────────────────────────────────────────────────

export class ConfigError extends FrameworkError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
    this.name = "ConfigError";
  }
}
