/**
 * The first-phase Host Tool allowlist for external Agent Runtimes.
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
 *  2. **Host-loopback tools are special** (§9.3). `Panel`, `Browser`,
 *     `SwitchSessionWorkspace` and `InjectCredential` reach back out to a
 *     specific Desktop renderer window to do their work. Passing `ToolExecutor`
 *     does NOT make them callable — owner routing decides that, and it lives
 *     outside the executor. Any such tool needs its owner story argued before it
 *     can be listed.
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
      "fallback, so they work without an owning window. invoke is deferred: it " +
      "refuses to broadcast (running a mutating Panel App tool once per mounted " +
      "window), so it needs the explicit owner claim from §9.3.2 first.",
  },
  {
    tool: "Browser",
    kind: "host-loopback",
    status: "deferred",
    reason:
      "Same loopback as Panel, but a far larger capability surface (navigate, " +
      "click, type, read page content). Needs its own security review and its own " +
      "owner argument before exposure.",
  },
  {
    tool: "SwitchSessionWorkspace",
    kind: "host-loopback",
    status: "excluded",
    reason:
      "Changes the session cwd, which every later path/permission decision is " +
      "resolved against. Coupled to session lifecycle (§13); not something an " +
      "external runtime should reach in phase one.",
  },
  {
    tool: "InjectCredential",
    kind: "host-loopback",
    status: "excluded",
    reason: "Directly touches credentials. §12.4 excludes credential-bearing tools outright.",
  },
  {
    tool: "Agent",
    kind: "self-contained",
    status: "excluded",
    reason:
      "Can spawn another agent, so an external runtime could recurse into itself, " +
      "nest approvals, and escape concurrency/budget limits (§12.5).",
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
      "Engine drive each other's plan state (§12.3).",
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
    status: "excluded",
    reason:
      "Overlaps a native tool the runtime already has. Augmented mode adds only " +
      "what the runtime lacks (§6.3); duplicating file tools invites naming " +
      "conflicts and behavior drift for no gain.",
  },
  {
    tool: "Bash",
    kind: "self-contained",
    status: "excluded",
    reason: "Overlaps a native tool; same reason as Read.",
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
  return Object.freeze({
    has: (value: T) => inner.has(value),
    get size() {
      return inner.size;
    },
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    forEach: (fn: (v: T, v2: T, s: ReadonlySet<T>) => void, thisArg?: unknown) =>
      inner.forEach((a, b) => fn.call(thisArg, a, b, inner), thisArg),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    add: reject,
    delete: reject,
    clear: reject,
  }) as unknown as ReadonlySet<T>;
}

/** Same reasoning as {@link frozenSet}, for the args-pattern map. */
function frozenMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const inner = new Map(entries);
  return Object.freeze({
    get: (key: K) => inner.get(key),
    has: (key: K) => inner.has(key),
    get size() {
      return inner.size;
    },
    keys: () => inner.keys(),
    values: () => inner.values(),
    entries: () => inner.entries(),
    forEach: (fn: (v: V, k: K, m: ReadonlyMap<K, V>) => void, thisArg?: unknown) =>
      inner.forEach((v, k) => fn.call(thisArg, v, k, inner), thisArg),
    [Symbol.iterator]: () => inner[Symbol.iterator](),
    set: reject,
    delete: reject,
    clear: reject,
  }) as unknown as ReadonlyMap<K, V>;
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
