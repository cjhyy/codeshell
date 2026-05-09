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
import { logger as rootPermLogger } from "../logging/logger.js";

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
      return {
        approved: false,
        reason: "auto mode: high-risk operation denied (no interactive approval available)",
      };
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
      if (
        /\.(ts|js|tsx|jsx|py|rs|go|java|c|cpp|h|css|html|json|yaml|yml|toml|md|txt|sh)$/.test(
          filePath,
        )
      ) {
        return true;
      }
    }

    // Safe bash commands
    if (toolName === "Bash") {
      const cmd = String(args.command ?? "");
      const safePrefixes = [
        "git ",
        "npm ",
        "pnpm ",
        "yarn ",
        "npx ",
        "node ",
        "tsc ",
        "eslint ",
        "prettier ",
        "vitest ",
        "jest ",
        "cargo ",
        "go ",
        "python ",
        "pip ",
        "make ",
        "ls ",
        "cat ",
        "head ",
        "tail ",
        "wc ",
        "echo ",
        "mkdir ",
        "touch ",
        "pwd",
        "whoami",
        "date",
        "which ",
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
 *
 * Stores "always allow" decisions at two scopes:
 *   - session: in-memory map, lost when the process exits
 *   - project: persisted to <cwd>/.code-shell/settings.local.json so the
 *              same project remembers the rule across REPL restarts
 *
 * The classifier reads project rules from settings on session start (see
 * Engine.buildPermissionConfig), so persisted rules become "auto-allow"
 * the next time the user opens the project.
 */
export class InteractiveApprovalBackend implements ApprovalBackend {
  private sessionRules = new Map<string, "allow" | "deny">();
  private promptFn: ((request: ApprovalRequest) => Promise<ApprovalResult>) | null = null;
  private cwd: string | null = null;
  // Project rules saved during this session. Kept in-memory (not re-read from
  // settings.local.json) so a stream of approvals all stay applied — the
  // previous version passed only the freshly-added rule to the classifier,
  // which silently dropped earlier approvals from the live classifier within
  // the same session. We accumulate here and hand the full list to the callback.
  private savedProjectRules: PermissionRule[] = [];
  private onProjectRules: ((rules: PermissionRule[]) => void) | null = null;

  setPromptFn(fn: (request: ApprovalRequest) => Promise<ApprovalResult>): void {
    this.promptFn = fn;
  }

  /** Inject the project root so persistence writes to the right settings file. */
  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  /**
   * Inject a callback fired when the user approves "for this project". The
   * callback receives the *full* accumulated list of project rules saved in
   * this session, so the classifier can be reconfigured without losing
   * earlier approvals.
   */
  setOnProjectRules(fn: (rules: PermissionRule[]) => void): void {
    this.onProjectRules = fn;
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    // Check session rules first
    const toolRule = this.sessionRules.get(req.toolName);
    if (toolRule === "allow") return { approved: true };
    if (toolRule === "deny") return { approved: false };

    if (!this.promptFn) {
      return { approved: false, reason: "interactive approval backend has no prompt function" };
    }

    const result = await this.promptFn(req);
    const scope = result.scope ?? (result.always ? "session" : "once");

    if (scope === "session" && result.always) {
      this.sessionRules.set(req.toolName, result.approved ? "allow" : "deny");
    } else if (scope === "project" && result.approved) {
      // Project-scope: persist a PermissionRule to settings.local.json.
      // We only persist allow rules — denies stay session-only because a
      // persisted deny is harder to recover from than a session deny.
      const rule = buildProjectRule(req.toolName, req.args);
      if (rule && this.cwd) {
        try {
          persistProjectRule(this.cwd, rule);
          // Dedup against the in-memory list using the same equality used by
          // persistProjectRule so re-prompts on the same tool/argsPattern
          // don't bloat the live rule set.
          const dup = this.savedProjectRules.some(
            (r) =>
              r.tool === rule.tool &&
              r.decision === rule.decision &&
              JSON.stringify(r.argsPattern) === JSON.stringify(rule.argsPattern),
          );
          if (!dup) this.savedProjectRules.push(rule);
          this.onProjectRules?.(this.savedProjectRules);
          rootPermLogger.info("permission.persist", {
            cat: "permission",
            tool: rule.tool,
            decision: rule.decision,
            totalProjectRules: this.savedProjectRules.length,
            duplicate: dup,
          });
        } catch (err) {
          rootPermLogger.error("permission.persist_failed", {
            cat: "permission",
            tool: rule.tool,
            error: (err as Error).message,
          });
          // eslint-disable-next-line no-console
          console.error("Failed to persist project permission rule:", (err as Error).message);
        }
      }
      // Also seed session map so the rest of this REPL session benefits
      // even if the classifier path doesn't pick the rule up immediately.
      this.sessionRules.set(req.toolName, "allow");
    }

    return result;
  }
}

/**
 * Build a PermissionRule from a single approval. Bash narrows to the head
 * command (first whitespace token) so "git status" → allow all `git ...`.
 * Other tools currently allow at tool granularity — file-level whitelists
 * could be added later by extending argsPattern.
 */
function buildProjectRule(toolName: string, args: Record<string, unknown>): PermissionRule | null {
  if (toolName === "Bash") {
    const cmd = String(args.command ?? "").trim();
    const head = cmd.split(/\s+/)[0];
    if (!head) return null;
    return {
      tool: "Bash",
      argsPattern: { command: `^${escapeRegex(head)}(\\s|$)` },
      decision: "allow",
      reason: `Allowed via permission prompt: ${head}`,
    };
  }
  return {
    tool: toolName,
    decision: "allow",
    reason: "Allowed via permission prompt",
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Append a rule to <cwd>/.code-shell/settings.local.json. Local file because
 * permission grants are per-developer and shouldn't be checked into git.
 * Idempotent: skips if an equivalent rule is already present.
 */
function persistProjectRule(cwd: string, rule: PermissionRule): void {
  const dir = `${cwd}/.code-shell`;
  const file = `${dir}/settings.local.json`;
  // Lazy node imports — keep permission.ts free of fs at module load time
  // so it can be used in non-Node contexts (tests, browsers via shim).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let settings: { permissions?: { rules?: PermissionRule[] } } = {};
  if (fs.existsSync(file)) {
    try {
      settings = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      /* start fresh on parse error */
    }
  }
  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.rules) settings.permissions.rules = [];

  // Dedup: same tool + same argsPattern.command (or no pattern) is a match
  const exists = settings.permissions.rules.some(
    (r) =>
      r.tool === rule.tool &&
      r.decision === "allow" &&
      JSON.stringify(r.argsPattern) === JSON.stringify(rule.argsPattern),
  );
  if (exists) return;

  settings.permissions.rules.push(rule);
  // Atomic write: stage to .tmp, then rename, so a crash mid-write can't
  // truncate settings.local.json and lose every saved permission grant.
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, file);
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
  /**
   * Turn-scoped logger so permission events (ask/decision/auto-deny) are
   * tagged with the current turn/turnId. Falls back to the root logger so
   * tests and ad-hoc usages still write log lines.
   */
  private log: typeof rootPermLogger = rootPermLogger;

  constructor(
    private rules: PermissionRule[],
    private defaultMode: PermissionMode = "default",
    private approvalBackend: ApprovalBackend = new HeadlessApprovalBackend("deny-all"),
  ) {}

  setLogger(log: typeof rootPermLogger): void {
    this.log = log;
  }

  /** Replace mode + backend in place so live tool execution sees the change. */
  reconfigure(
    mode: PermissionMode,
    approvalBackend: ApprovalBackend,
    rules?: PermissionRule[],
  ): void {
    this.defaultMode = mode;
    this.approvalBackend = approvalBackend;
    if (rules) this.rules = rules;
  }

  getMode(): PermissionMode {
    return this.defaultMode;
  }

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
      if (
        level === "safe-write" &&
        (this.defaultMode === "acceptEdits" || this.defaultMode === "auto")
      ) {
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
    if (this.defaultMode === "dontAsk") {
      this.log.info("permission.auto_deny", {
        cat: "permission",
        tool: toolName,
        reason: "dontAsk_mode",
      });
      return false;
    }
    if (this.defaultMode === "bypassPermissions") {
      this.log.info("permission.auto_allow", {
        cat: "permission",
        tool: toolName,
        reason: "bypassPermissions_mode",
      });
      return true;
    }

    // Check denial tracker — if too many denials, auto-deny
    if (this.denialTracker.shouldWarn(toolName)) {
      this.log.warn("permission.auto_deny", {
        cat: "permission",
        tool: toolName,
        reason: "denial_tracker_threshold",
      });
      return false;
    }

    const riskLevel = this.assessRisk(toolName, args);
    const span = this.log.span("permission.ask", {
      cat: "permission",
      tool: toolName,
      riskLevel,
    });
    let result: ApprovalResult;
    try {
      result = await this.approvalBackend.requestApproval({
        toolName,
        args,
        description: this.describeToolCall(toolName, args),
        riskLevel,
      });
    } catch (err) {
      span.fail(err, { tool: toolName });
      throw err;
    }

    if (result.approved) {
      this.denialTracker.recordSuccess(toolName);
    } else {
      this.denialTracker.record(toolName);
    }

    span.end({
      tool: toolName,
      approved: result.approved,
      // `scope` is set by the interactive backend when the user picks
      // "for this session" / "for this project"; absent for one-shot answers.
      scope: (result as { scope?: string }).scope,
      reason: !result.approved ? (result as { reason?: string }).reason : undefined,
    });

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

  /**
   * Short, human-friendly subtitle. The UI shows this under the tool title;
   * full args (command bodies, diffs, etc.) come from the args field, so this
   * stays compact — no truncation here, just a label.
   */
  private describeToolCall(toolName: string, args: Record<string, unknown>): string {
    switch (toolName) {
      case "Bash":
        return String(args.description ?? "Run shell command");
      case "Write":
        return `Create or overwrite ${args.file_path}`;
      case "Edit":
        return `Modify ${args.file_path}`;
      default:
        return toolName;
    }
  }
}
