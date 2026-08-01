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
      "Only list/open/tools. These are read-or-focus, and they have a broadcast " +
      "fallback, so they work without an owning window. invoke stays out for now " +
      "for a DIFFERENT reason than originally recorded: the owner claim it was " +
      "waiting on now exists and is wired (ExternalRuntimeService claims before " +
      "the runtime starts), so the blocker is no longer technical. What is still " +
      "missing is a per-Panel-App risk review — invoke runs third-party Panel App " +
      "code with whatever arguments the model supplies, and argsPatterns cannot " +
      "constrain a nested payload. Enabling it is a policy decision, not a wiring " +
      "one, and it belongs to whoever reviews the first Panel App to be trusted.",
  },
  {
    tool: "Browser",
    kind: "host-loopback",
    status: "exposed",
    reason:
      "Large surface (navigate, click, type, read page content), and the owner " +
      "argument it was waiting on is the same one Panel now has: " +
      "ExternalRuntimeService registers the session and claims the owning window " +
      "before the runtime starts. Exposed because it is a capability the runtime " +
      "genuinely lacks — the differentiator, not a duplicate — and it stays under " +
      "ToolExecutor plus the user's permission rules. Without an owning window it " +
      "fails closed on routing rather than broadcasting.",
  },
  {
    tool: "SwitchSessionWorkspace",
    kind: "host-loopback",
    status: "exposed",
    reason:
      "Changes the session cwd, which every later path/permission decision is " +
      "resolved against — so it is genuinely load-bearing, not merely risky. " +
      "Exposed on the product owner's call. Two properties keep it bounded: the " +
      "switch targets a workspace the session already has, and every subsequent " +
      "call re-resolves its policy against the NEW cwd rather than inheriting the " +
      "old decision. An untrusted target therefore narrows permissions instead of " +
      "carrying trust across.",
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
  // ── Still excluded, and for a different KIND of reason ───────────
  // The four below are not held back out of caution — widening the allowlist
  // does not make them work. Each is excluded by a structural property that
  // would have to be designed away first, so listing them would produce a tool
  // that is advertised and then fails or misbehaves.
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
    status: "excluded",
    reason: "Same recursion hazard as Agent (§12.5).",
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
 * all. Both are narrowed to read-only actions in phase one, and `Panel.invoke`
 * additionally fails closed on owner routing — three independent barriers, by
 * design.
 */
const FIRST_PHASE_ARGS_PATTERNS: ReadonlyMap<string, Readonly<Record<string, string>>> = new Map([
  // Panel.invoke remains the one action-level restriction. It runs third-party
  // Panel App code with whatever arguments the model supplies, and argsPatterns
  // cannot constrain a nested payload — so unlike every tool widened above, the
  // authorization layer genuinely cannot see what is being authorized. Enabling
  // it belongs to whoever reviews the first Panel App to be trusted.
  ["Panel", { action: "list|open|tools" }],
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
      Object.freeze({ ...patterns }),
    ]),
  ),
});
