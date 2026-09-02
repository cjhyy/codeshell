/**
 * The Host Tool allowlist for external Agent Runtimes.
 *
 * This is a policy artifact, not plumbing. It exists as one reviewable file —
 * rather than scattered through the Claude/Codex adapters — because the design
 * (§9.1) requires each entry to have been risk-reviewed individually, and a
 * reviewer needs to see the whole surface at once.
 *
 * Two rules shape everything here:
 *
 *  1. **Allowlist only.** No "everything in the registry", no prefix matching.
 *     A tool absent from this file does not exist for an external runtime.
 *     Widening it is an edit to this file, which is the point: it leaves a diff.
 *  2. **Host-loopback tools are special** (§9.3). `Panel`, `Browser`,
 *     `SwitchSessionWorkspace` and `InjectCredential` reach back out to a
 *     specific Desktop renderer window to do their work. Passing `ToolExecutor`
 *     does NOT make them callable — owner routing decides that, and it lives
 *     outside the executor. Any such tool needs its owner story argued before it
 *     can be listed.
 *
 * ## Why this is much wider than the original phase-one list
 *
 * The first cut exposed exactly one tool (`Panel`). That was not the product of
 * a risk judgement so much as of an ordering: tools were held back until each
 * had an argument written, and only one did. The result was a runtime that
 * could list panels and nothing else — no skills, no memory, no file access —
 * which is not a usable Agent Runtime, and made the feature's real state easy
 * to overstate.
 *
 * The widening below was an explicit product-owner decision. The governing
 * principle it rests on: **every tool here still executes through
 * `ToolExecutor`**, so path policy, project trust, the user's permission rules
 * and the approval UI all still apply. An external runtime holding `Bash` from
 * this list is strictly more governed than the same model calling its own
 * built-in shell, which answers only to the runtime's sandbox. Exposure moves
 * capability from an unobservable authorization domain into the user's.
 *
 * That argument does not extend to everything, and four tools remain excluded
 * for structural reasons rather than caution — see the block below them.
 * `InjectCredential` is the highest-risk entry and depends on an in-tool
 * approval that must stay mandatory; if that ever changes, it goes back out.
 */
import type { ExternalToolExposurePolicy } from "./session-tool-host.js";

/** Why a tool is in (or out of) the first-phase allowlist. */
export interface ExposureRationale {
  tool: string;
  /** `self-contained` completes in-process; `host-loopback` calls back to a window. */
  kind: "self-contained" | "host-loopback";
  status: "exposed" | "deferred" | "excluded";
  reason: string;
}

/**
 * The audit trail behind {@link FIRST_PHASE_EXPOSURE}. Kept as data so the
 * "excluded" decisions are visible too — a bare allowlist tells a reviewer what
 * was included but not what was considered and rejected, which is the more
 * useful half when judging whether the surface is sound.
 */
export const FIRST_PHASE_EXPOSURE_RATIONALE: readonly ExposureRationale[] = [
  {
    tool: "Panel",
    kind: "host-loopback",
    status: "exposed",
    reason:
      "list/open/tools plus invoke for the reviewed job-hunt-hq tool catalog. The " +
      "invoke exception is constrained by panel id and exact tool name; the Panel " +
      "App manifest validates the nested payload. Other Panel Apps remain " +
      "discovery/focus-only until they receive their own review.",
  },
  {
    // NOTE the names: there is no tool called "Browser". The registry exposes
    // three separate browser tools, and an allowlist entry for a name that does
    // not exist is silently inert — it neither grants nor denies anything,
    // which is the worst of both (a reviewer reads it as covered).
    tool: "browser_navigate",
    kind: "host-loopback",
    status: "exposed",
    reason:
      "The browser capability the runtime genuinely lacks — the differentiator, " +
      "not a duplicate — and the owner argument it was waiting on is the same one " +
      "Panel now has: ExternalRuntimeService registers the session and claims the " +
      "owning window before the runtime starts. Stays under ToolExecutor plus the " +
      "user's permission rules; without an owning window it fails closed on " +
      "routing rather than broadcasting.",
  },
  {
    tool: "browser_observe",
    kind: "host-loopback",
    status: "exposed",
    reason: "Reads page content. Same owner story as browser_navigate, no mutation.",
  },
  {
    tool: "browser_act",
    kind: "host-loopback",
    status: "exposed",
    reason:
      "Click / type / interact — the mutating third of the browser surface, and " +
      "the one that combines with InjectCredential to act as the logged-in user. " +
      "Exposed on the product owner's call, under the same ToolExecutor rules as " +
      "every other entry here.",
  },
  {
    tool: "InjectCredential",
    kind: "host-loopback",
    status: "exposed",
    reason:
      "Injects saved cookie credentials into the built-in browser to restore a " +
      "login. This is the single highest-risk entry in this file and the one " +
      "reviewers should look at first: it hands a live session cookie to a page, " +
      "and a model that can also drive the Browser can then act as the logged-in " +
      "user. §12.4 excluded credential-bearing tools outright; that blanket rule " +
      "is relaxed here on the product owner's explicit call because credential " +
      "restore is what makes browser automation usable at all. The mitigation is " +
      "NOT the allowlist — it is the tool's own in-tool approval, which stays " +
      "mandatory (see builtin/index.ts) and is never auto-approved for an " +
      "external runtime. If that approval is ever made skippable, this entry must " +
      "go back to excluded.",
  },
  // ── Delegation and state-machine exceptions ──────────────────────
  // Agent and the two plan-state tools remain structurally excluded. DriveAgent
  // is the reviewed exception because the child does not inherit the host
  // bridge and background work is allowed only when the host guarantees an
  // observable completion handoff.
  {
    tool: "Agent",
    kind: "self-contained",
    status: "excluded",
    reason:
      "Can spawn another agent, so an external runtime could recurse into itself, " +
      "nest approvals, and escape concurrency/budget limits (§12.5). Unlike Bash " +
      "or Browser, this is not a permission question: the recursion has no owner " +
      "and no budget to charge, so exposing it would need a nesting model first.",
  },
  {
    tool: "DriveAgent",
    kind: "self-contained",
    status: "exposed",
    reason:
      "Delegates one bounded task to an installed Codex/Claude CLI. External " +
      "sessions may detach it only when the Desktop host promises to drain the " +
      "completion queue and inject a continuation into the same Session; other " +
      "hosts fail closed and require foreground execution. The child CLI does not " +
      "inherit this host bridge, which bounds nesting at one level; the outer call " +
      "still requires the normal DriveAgent approval.",
  },
  {
    tool: "DriveAgentJobs",
    kind: "self-contained",
    status: "exposed",
    reason:
      "Lets the runtime inspect or cancel retained DriveAgent jobs, including " +
      "Desktop-backed background delegations whose completion is delivered through " +
      "the owning Session.",
  },
  {
    tool: "EnterPlanMode",
    kind: "self-contained",
    status: "excluded",
    reason:
      "Engine state-machine tool. Exposing it lets the runtime and the Native " +
      "Engine drive each other's plan state (§12.3) — and an external runtime has " +
      "no Engine plan state of its own to enter, so the call has no coherent " +
      "meaning on this path.",
  },
  {
    tool: "ExitPlanMode",
    kind: "self-contained",
    status: "excluded",
    reason: "Engine state-machine tool; same reason as EnterPlanMode.",
  },
  {
    tool: "Read",
    kind: "self-contained",
    status: "exposed",
    reason:
      "Overlaps a tool the runtime already has, which was the original reason to " +
      "exclude it. That reasoning was wrong about which risk matters: the runtime's " +
      "OWN Read answers to the runtime's sandbox, while this one answers to " +
      "ToolExecutor — path policy, project trust and the user's permission rules. " +
      "Exposing it means the model has a reachable path that IS governed by " +
      "CodeShell, which is the point of augmented mode. Naming overlap is a " +
      "presentation problem (the MCP server prefixes its tools); sandbox " +
      "divergence is a security one.",
  },
  {
    tool: "Bash",
    kind: "self-contained",
    status: "exposed",
    reason:
      "Same argument as Read, and it is the tool where it matters most: the " +
      "runtime's own shell runs under the runtime's approval policy, which the " +
      "user did not configure and cannot see. Routing a shell call through " +
      "ToolExecutor puts it under the user's own permission rules and the " +
      "approval UI. Note this does NOT remove the runtime's own shell — it adds a " +
      "governed alternative.",
  },
  // ── Skills, memory and planning ──────────────────────────────────
  // These are the reason someone runs a model inside CodeShell rather than in a
  // bare terminal. A runtime that cannot reach them is a stranger in the app: it
  // cannot load the user's skills, cannot recall anything, and forgets the
  // session the moment it ends. Phase one excluded them by omission rather than
  // by argument — no rationale entry existed at all, which is how a surface ends
  // up shipping at 1 tool out of 48 without anyone deciding that.
  {
    tool: "Skill",
    kind: "self-contained",
    status: "exposed",
    reason:
      "Loads a SKILL.md body and returns it as the tool result — it reads from " +
      "the scanner, never the disk directly, and executes nothing itself. A skill " +
      "body may TELL the model to run commands, but those become ordinary tool " +
      "calls that face the same authorization as any other. Withholding Skill " +
      "does not withhold that capability; it only withholds the user's own " +
      "curated instructions.",
  },
  {
    tool: "MemoryRead",
    kind: "self-contained",
    status: "exposed",
    reason: "Reads the user's memory store. No side effects.",
  },
  {
    tool: "MemoryList",
    kind: "self-contained",
    status: "exposed",
    reason: "Enumerates memory entries. No side effects.",
  },
  {
    tool: "MemorySave",
    kind: "self-contained",
    status: "exposed",
    reason:
      "Writes to the memory store, so it is a mutation — but a scoped one, into " +
      "a store the user can read and edit, and it carries the same permission " +
      "rules as on the native path.",
  },
  {
    tool: "MemoryDelete",
    kind: "self-contained",
    status: "exposed",
    reason: "Mutation, same store and same rules as MemorySave.",
  },
  {
    tool: "TodoWrite",
    kind: "self-contained",
    status: "exposed",
    reason: "Session-scoped task list. Visible to the user, trivially reversible.",
  },
  {
    tool: "Glob",
    kind: "self-contained",
    status: "exposed",
    reason: "Path search under the same path policy as Read.",
  },
  {
    tool: "Grep",
    kind: "self-contained",
    status: "exposed",
    reason: "Content search under the same path policy as Read.",
  },
  {
    tool: "Write",
    kind: "self-contained",
    status: "exposed",
    reason: "File mutation governed by ToolExecutor. Same argument as Bash.",
  },
  {
    tool: "Edit",
    kind: "self-contained",
    status: "exposed",
    reason: "File mutation governed by ToolExecutor. Same argument as Bash.",
  },
  {
    tool: "WebSearch",
    kind: "self-contained",
    status: "exposed",
    reason: "Read-only network lookup; already available to the model by other means.",
  },
  {
    tool: "WebFetch",
    kind: "self-contained",
    status: "exposed",
    reason: "Read-only fetch, subject to the same URL handling as the native path.",
  },
];

/**
 * Action-level narrowing for tools that multiplex several operations behind one
 * name. Anchored automatically — see `matchesWholeValue`.
 *
 * This is a second, independent layer from the tool's own
 * `defaultPermissionRules`: those decide allow/ask for a call that IS permitted,
 * while this decides whether the action is reachable from an external runtime at
 * all. `Panel.invoke` additionally fails closed on owner routing. Its exception
 * here is limited to the reviewed job-hunt-hq panel and exact tool names; write
 * operations still pass through Panel's schema, owner routing, permission rules,
 * and approval handling.
 */
const JOB_HUNT_TOOL_NAMES = [
  "get_job_search_context",
  "save_candidate_context",
  "save_job_opportunities",
  "save_workflow_progress",
  "save_job_research",
  "save_interview_question_set",
  "save_preparation_plan",
  "save_interview_debrief",
  "save_resume_draft",
].join("|");

const PANEL_ARGUMENT_PATTERNS: readonly Readonly<Record<string, string>>[] = [
  { action: "list|open|tools" },
  {
    action: "invoke",
    panel_id: "panel-app:job-hunt-hq",
    tool_name: JOB_HUNT_TOOL_NAMES,
  },
];

const FIRST_PHASE_ARGS_PATTERNS: NonNullable<ExternalToolExposurePolicy["argsPatterns"]> = new Map([
  ["Panel", PANEL_ARGUMENT_PATTERNS],
]);

/**
 * `ReadonlySet` / `ReadonlyMap` are compile-time only — the underlying `Set` and
 * `Map` stay mutable at runtime, and this policy is a process-wide singleton read
 * live on every `execute()`. Without this, one `argsPatterns.delete("Panel")`
 * anywhere in the process would re-enable `Panel.invoke` for every already-running
 * host: exactly the capability held back pending the §9.3.2 owner claim.
 */
function reject(): never {
  throw new TypeError("The external tool exposure policy is frozen and cannot be widened.");
}

/**
 * Hand out a plain object implementing the read half of `Set`, not a real `Set`.
 *
 * Shadowing `add`/`delete`/`clear` on a `Set` is not enough: the prototype method
 * is still reachable (`Set.prototype.add.call(policySet, "Bash")`), and `delete
 * s.add` un-shadows it. Returning a non-`Set` object removes the mutators
 * entirely — there is no `Set` internal slot to target — and `Object.freeze`
 * stops the read methods from being swapped out.
 */
function frozenSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const inner = new Set(values);
  const view: ReadonlySet<T> = Object.freeze({
    has: (value: T) => inner.has(value),
    get size() {
      return inner.size;
    },
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    // Pass the VIEW as the third argument, never `inner`. Set.prototype.forEach
    // hands the callback the collection itself, so forwarding `inner` would leak
    // a live mutable handle to the very object this wrapper exists to protect —
    // `policy.forEach((_a, _b, s) => s.add("Bash"))` would widen it in one line,
    // through the public frozen API, with no prototype tricks at all.
    forEach: (fn: (v: T, v2: T, s: ReadonlySet<T>) => void, thisArg?: unknown) =>
      inner.forEach((a, b) => fn.call(thisArg, a, b, view)),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    add: reject,
    delete: reject,
    clear: reject,
  }) as unknown as ReadonlySet<T>;
  return view;
}

/** Same reasoning as {@link frozenSet}, for the args-pattern map. */
function frozenMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const inner = new Map(entries);
  const view: ReadonlyMap<K, V> = Object.freeze({
    get: (key: K) => inner.get(key),
    has: (key: K) => inner.has(key),
    get size() {
      return inner.size;
    },
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    // See frozenSet.forEach — arg 3 must be the view, not `inner`.
    forEach: (fn: (v: V, k: K, m: ReadonlyMap<K, V>) => void, thisArg?: unknown) =>
      inner.forEach((v, k) => fn.call(thisArg, v, k, view)),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    set: reject,
    delete: reject,
    clear: reject,
  }) as unknown as ReadonlyMap<K, V>;
  return view;
}

/** The phase-one policy. Pass to `createSessionToolHost({ exposure })`. */
export const FIRST_PHASE_EXPOSURE: ExternalToolExposurePolicy = Object.freeze({
  mode: "allowlist" as const,
  toolNames: frozenSet(
    FIRST_PHASE_EXPOSURE_RATIONALE.filter((entry) => entry.status === "exposed").map(
      (entry) => entry.tool,
    ),
  ),
  argsPatterns: frozenMap(
    [...FIRST_PHASE_ARGS_PATTERNS].map(([tool, patterns]) => [
      tool,
      Array.isArray(patterns)
        ? Object.freeze(patterns.map((pattern) => Object.freeze({ ...pattern })))
        : Object.freeze({ ...patterns }),
    ]),
  ),
});
