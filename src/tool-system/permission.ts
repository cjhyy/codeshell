/**
 * Permission system — classifier + approval backend.
 */

import type {
  PermissionDecision,
  PermissionMode,
  PermissionRule,
  ApprovalRequest,
  ApprovalResult,
} from "../types.js";

export interface ApprovalBackend {
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}

export class HeadlessApprovalBackend implements ApprovalBackend {
  constructor(private readonly mode: "approve-all" | "deny-all" | "approve-read-only") {}

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    switch (this.mode) {
      case "approve-all":
        return { approved: true };
      case "deny-all":
        return { approved: false, reason: "headless deny-all mode" };
      case "approve-read-only": {
        const readOnlyTools = ["Read", "Glob", "Grep", "WebSearch", "WebFetch", "ToolSearch"];
        if (readOnlyTools.includes(req.toolName)) {
          return { approved: true };
        }
        return { approved: false, reason: "read-only mode: write operations denied" };
      }
    }
  }
}

/**
 * Auto approval backend — uses fast-path heuristics to auto-approve safe operations.
 * Falls back to a delegate backend for uncertain cases.
 */
export class AutoApprovalBackend implements ApprovalBackend {
  constructor(private readonly delegate?: ApprovalBackend) {}

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    // Fast-path: auto-approve low-risk operations
    if (req.riskLevel === "low") {
      return { approved: true };
    }

    // Auto-approve common safe patterns
    if (this.isSafeOperation(req)) {
      return { approved: true };
    }

    // Auto-deny high-risk dangerous commands
    if (req.riskLevel === "high") {
      if (this.delegate) {
        return this.delegate.requestApproval(req);
      }
      return { approved: false, reason: "auto mode: high-risk operation denied (no interactive approval available)" };
    }

    // Medium risk: delegate if available, otherwise approve
    if (this.delegate) {
      return this.delegate.requestApproval(req);
    }
    return { approved: true };
  }

  private isSafeOperation(req: ApprovalRequest): boolean {
    const { toolName, args } = req;

    // Write/Edit to known safe paths
    if (toolName === "Write" || toolName === "Edit") {
      const filePath = String(args.file_path ?? "");
      // Allow writes to source code, tests, config, docs
      if (/\.(ts|js|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|toml|md|txt|sh)$/.test(filePath)) {
        return true;
      }
    }

    // Safe bash commands
    if (toolName === "Bash") {
      const cmd = String(args.command ?? "");
      const safePrefixes = [
        "git ", "npm ", "pnpm ", "yarn ", "npx ", "node ",
        "tsc ", "eslint ", "prettier ", "vitest ", "jest ",
        "cargo ", "go ", "python ", "pip ", "make ",
        "ls ", "cat ", "head ", "tail ", "wc ", "echo ",
        "mkdir ", "touch ", "pwd", "whoami", "date", "which ",
      ];
      if (safePrefixes.some((p) => cmd.startsWith(p))) {
        return true;
      }
    }

    return false;
  }
}

/**
 * Interactive approval backend — prompts the user via a callback.
 * Supports "always allow" rules that persist for the session.
 */
export class InteractiveApprovalBackend implements ApprovalBackend {
  private sessionRules = new Map<string, "allow" | "deny">();
  private promptFn: ((request: ApprovalRequest) => Promise<ApprovalResult>) | null = null;

  setPromptFn(fn: (request: ApprovalRequest) => Promise<ApprovalResult>): void {
    this.promptFn = fn;
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    // Check session rules first
    const toolRule = this.sessionRules.get(req.toolName);
    if (toolRule === "allow") return { approved: true };
    if (toolRule === "deny") return { approved: false };

    // If no prompt function is wired, fail closed. Interactive backends are
    // used by UIs that must explicitly provide a prompt callback.
    if (!this.promptFn) {
      return { approved: false, reason: "interactive approval backend has no prompt function" };
    }

    const result = await this.promptFn(req);

    // Store "always" decisions
    if (result.always && result.approved) {
      this.sessionRules.set(req.toolName, "allow");
    } else if (result.always && !result.approved) {
      this.sessionRules.set(req.toolName, "deny");
    }

    return result;
  }

  private ruleKeyFromArgs(args: Record<string, unknown>): string {
    // For file tools, use the file path
    if (args.file_path) return String(args.file_path);
    if (args.command) return String(args.command).slice(0, 50);
    return "";
  }
}

// Singleton interactive backend for use by the UI
let _interactiveBackend: InteractiveApprovalBackend | null = null;

export function getInteractiveApprovalBackend(): InteractiveApprovalBackend {
  if (!_interactiveBackend) {
    _interactiveBackend = new InteractiveApprovalBackend();
  }
  return _interactiveBackend;
}

export function setInteractiveApprovalFn(
  fn: (request: ApprovalRequest) => Promise<ApprovalResult>,
): void {
  getInteractiveApprovalBackend().setPromptFn(fn);
}

// ─── YOLO Classifier — categorize bash commands by safety level ───

type BashSafetyLevel = "safe-read" | "safe-write" | "unsafe" | "dangerous";

const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /rm\s+-r\s+\//,
  />\s*\/dev\/sd/,
  /mkfs\./,
  /dd\s+if=/,
  /:(){ :|:& };:/,
  /chmod\s+-R\s+777/,
  /curl.*\|\s*(ba)?sh/,
  /wget.*\|\s*(ba)?sh/,
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /git\s+clean\s+-[fd]/,
  />\s*\/etc\//,
  /sudo\s+rm/,
  /pkill\s+-9/,
  /kill\s+-9/,
  /shutdown/,
  /reboot/,
  /systemctl\s+(stop|disable|mask)/,
  /DROP\s+(TABLE|DATABASE)/i,
  /TRUNCATE\s+TABLE/i,
];

const SAFE_READ_PATTERNS = [
  /^(cat|head|tail|less|more|wc|file|stat|du|df)\s/,
  /^(ls|tree|find|locate|which|whereis|type)\s/,
  /^(grep|rg|ag|ack|fgrep|egrep)\s/,
  /^(git\s+(status|log|diff|branch|show|blame|remote|tag|stash\s+list|rev-parse|describe))/,
  /^(node|python|ruby|go|rustc|java|javac)\s+--version/,
  /^(npm|pnpm|yarn|cargo|pip|gem|brew)\s+(list|ls|info|show|view|outdated|audit)/,
  /^pwd$/,
  /^whoami$/,
  /^date$/,
  /^(uname|hostname|id)\b/,
  /^echo\s/,
  /^env$/,
  /^printenv/,
];

const SAFE_WRITE_PATTERNS = [
  /^(git\s+(add|commit|stash\s+(save|push)))/,
  /^mkdir\s/,
  /^touch\s/,
  /^(npm|pnpm|yarn)\s+(install|add|remove|uninstall|run|test|build|lint|format)/,
  /^(cargo|go|pip|gem)\s+(build|test|install|run|fmt|clippy|vet)/,
  /^(tsc|eslint|prettier|vitest|jest|mocha|pytest)\b/,
  /^make\b/,
  /^(cp|mv)\s/,
];

export function classifyBashCommand(command: string): BashSafetyLevel {
  const trimmed = command.trim();

  // Check dangerous first (highest priority)
  if (DANGEROUS_PATTERNS.some((p) => p.test(trimmed))) return "dangerous";

  // Check safe-read
  if (SAFE_READ_PATTERNS.some((p) => p.test(trimmed))) return "safe-read";

  // Check safe-write
  if (SAFE_WRITE_PATTERNS.some((p) => p.test(trimmed))) return "safe-write";

  // Piped commands: check the last command in the pipe
  if (trimmed.includes("|")) {
    const parts = trimmed.split("|");
    const last = parts[parts.length - 1].trim();
    if (SAFE_READ_PATTERNS.some((p) => p.test(last))) return "safe-read";
  }

  return "unsafe";
}

// ─── Denial Tracker — rate limit repeated denials ────────────────

interface DenialRecord {
  count: number;
  firstAt: number;
  lastAt: number;
}

export class DenialTracker {
  private denials = new Map<string, DenialRecord>();
  private readonly periodMs: number;
  private readonly maxDenials: number;

  constructor(opts?: { periodMs?: number; maxDenials?: number }) {
    this.periodMs = opts?.periodMs ?? 60 * 60 * 1000; // 1 hour
    this.maxDenials = opts?.maxDenials ?? 5;
  }

  record(toolName: string): void {
    const now = Date.now();
    const existing = this.denials.get(toolName);
    if (existing && now - existing.firstAt < this.periodMs) {
      existing.count++;
      existing.lastAt = now;
    } else {
      this.denials.set(toolName, { count: 1, firstAt: now, lastAt: now });
    }
  }

  recordSuccess(toolName: string): void {
    this.denials.delete(toolName);
  }

  shouldWarn(toolName: string): boolean {
    const record = this.denials.get(toolName);
    if (!record) return false;
    if (Date.now() - record.firstAt > this.periodMs) {
      this.denials.delete(toolName);
      return false;
    }
    return record.count >= this.maxDenials;
  }

  getWarningMessage(toolName: string): string {
    const record = this.denials.get(toolName);
    if (!record) return "";
    return (
      `Tool "${toolName}" has been denied ${record.count} times in the last hour. ` +
      `Please stop attempting this tool and try an alternative approach.`
    );
  }

  clear(): void {
    this.denials.clear();
  }
}

// ─── Runtime permission override ─────────────────────────────
// Allows the UI to toggle bypass mode without recreating the classifier.
let _runtimeBypass = false;

export function setRuntimeBypass(enabled: boolean): void {
  _runtimeBypass = enabled;
}

export function isRuntimeBypass(): boolean {
  return _runtimeBypass;
}

export class PermissionClassifier {
  private denialTracker = new DenialTracker();

  constructor(
    private readonly rules: PermissionRule[],
    private readonly defaultMode: PermissionMode = "default",
    private readonly approvalBackend: ApprovalBackend = new HeadlessApprovalBackend("deny-all"),
  ) {}

  classify(toolName: string, args: Record<string, unknown>): PermissionDecision {
    // Runtime bypass overrides everything
    if (_runtimeBypass) return "allow";

    // Check explicit rules (ordered by specificity)
    for (const rule of this.rules) {
      if (this.matchesRule(rule, toolName, args)) {
        return rule.decision;
      }
    }

    // YOLO classifier for Bash commands
    if (toolName === "Bash") {
      const level = classifyBashCommand(String(args.command ?? ""));
      if (this.defaultMode === "bypassPermissions") return "allow";
      if (level === "dangerous") return "ask";
      if (level === "safe-read") return "allow";
      if (level === "safe-write" && (this.defaultMode === "acceptEdits" || this.defaultMode === "auto")) {
        return "allow";
      }
      if (level === "unsafe") return "ask";
    }

    // Fall back to default mode
    switch (this.defaultMode) {
      case "bypassPermissions":
        return "allow";
      case "dontAsk":
        return "deny";
      case "acceptEdits":
        return "allow";
      default:
        return "ask";
    }
  }

  async handleAsk(toolName: string, args: Record<string, unknown>): Promise<boolean> {
    if (this.defaultMode === "dontAsk") return false;
    if (this.defaultMode === "bypassPermissions") return true;

    // Check denial tracker — if too many denials, auto-deny
    if (this.denialTracker.shouldWarn(toolName)) {
      return false;
    }

    const result = await this.approvalBackend.requestApproval({
      toolName,
      args,
      description: this.describeToolCall(toolName, args),
      riskLevel: this.assessRisk(toolName, args),
    });

    if (result.approved) {
      this.denialTracker.recordSuccess(toolName);
    } else {
      this.denialTracker.record(toolName);
    }

    return result.approved;
  }

  /** Get denial warning message if the model keeps getting denied. */
  getDenialWarning(toolName: string): string | undefined {
    if (this.denialTracker.shouldWarn(toolName)) {
      return this.denialTracker.getWarningMessage(toolName);
    }
    return undefined;
  }

  private matchesRule(
    rule: PermissionRule,
    toolName: string,
    args: Record<string, unknown>,
  ): boolean {
    if (rule.tool !== toolName && rule.tool !== "*") return false;

    if (rule.argsPattern) {
      for (const [key, pattern] of Object.entries(rule.argsPattern)) {
        const argVal = String(args[key] ?? "");
        if (pattern instanceof RegExp) {
          if (!pattern.test(argVal)) return false;
        } else {
          if (!argVal.includes(pattern)) return false;
        }
      }
    }

    return true;
  }

  private isDangerousCommand(args: Record<string, unknown>): boolean {
    const command = String(args.command ?? "");
    return DANGEROUS_PATTERNS.some((p) => p.test(command));
  }

  private assessRisk(toolName: string, args: Record<string, unknown>): "low" | "medium" | "high" {
    if (toolName === "Bash" && this.isDangerousCommand(args)) return "high";
    if (["Write", "Edit"].includes(toolName)) return "medium";
    if (toolName === "Bash") return "medium";
    return "low";
  }

  private describeToolCall(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case "Bash":
        return `Run command: ${String(args.command ?? "").slice(0, 200)}`;
      case "Write":
        return `Write to: ${args.file_path}`;
      case "Edit":
        return `Edit file: ${args.file_path}`;
      default:
        return `${toolName}(${JSON.stringify(args).slice(0, 100)})`;
    }
  }
}
