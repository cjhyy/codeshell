/**
 * Reviewed external-runtime exposure. Tool owners declare compatibility beside
 * their catalogs; this snapshot is the independent central approval boundary.
 * New or changed declarations do not grant access until their complete schema,
 * permission metadata and argument constraints match the checked-in review.
 */
import { createHash } from "node:crypto";
import type { RegisteredTool } from "../types.js";
import type { BuiltinTool, BuiltinToolExposure } from "./builtin/index.js";
import type { ExternalToolExposurePolicy } from "./session-tool-host.js";
import type {
  ExternalToolCompatibility,
  ExternalToolReview,
} from "./external-tool-compatibility.js";
import reviewedSnapshot from "./external-tool-exposure.reviewed.json" with { type: "json" };

export type ExposureRationale = ExternalToolCompatibility & { tool: string };

export interface ExternalExposureRegistry {
  listToolsDetailed(): RegisteredTool[];
  getExposure(name: string): BuiltinToolExposure | undefined;
}

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined);
    entries.sort(([a], [b]) => compareNames(a, b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash execution-relevant data, not compiled function source, descriptive
 * prose or the `bookkeeping` flag (it only tells a host whether a run did
 * work; it changes nothing about what the tool may do). Presence of imperative guards/resolvers is reviewed here; their behavior
 * remains covered by their owning module's tests and code review.
 */
export function externalToolContractFingerprint(
  definition: RegisteredTool,
  exposure: BuiltinToolExposure,
): string {
  const {
    description: _description,
    bookkeeping: _bookkeeping,
    pathResolver,
    ...metadata
  } = definition;
  const contract = {
    definition: {
      ...metadata,
      ...(pathResolver ? { pathResolver: { operation: pathResolver.operation } } : {}),
    },
    defaultPermissionRules: exposure.defaultPermissionRules ?? [],
    featureFlag: exposure.featureFlag,
    hasAvailabilityGuard: exposure.availability !== undefined,
    hasDefinitionRewriter: exposure.rewriteDefinition !== undefined,
    requires: exposure.requires ?? [],
  };
  return createHash("sha256").update(canonical(contract)).digest("hex");
}

/** Produce review data from the owning contributions, without admitting them. */
export function createExternalToolReviewSnapshot(
  catalog: readonly Pick<BuiltinTool, "definition" | "exposure">[],
): ExternalToolReview[] {
  const seen = new Set<string>();
  const snapshot: ExternalToolReview[] = [];
  for (const { definition, exposure } of catalog) {
    if (seen.has(definition.name))
      throw new Error(`Duplicate tool declaration: ${definition.name}`);
    seen.add(definition.name);
    if (!exposure.external) continue;
    snapshot.push({
      tool: definition.name,
      ...exposure.external,
      contractFingerprint: externalToolContractFingerprint(definition, exposure),
    });
  }
  return snapshot.sort((a, b) => compareNames(a.tool, b.tool));
}

/** Review mismatch is deliberately actionable in tests, never auto-approved. */
export function assertExternalToolReviewSnapshot(
  actual: readonly ExternalToolReview[],
  expected: readonly ExternalToolReview[] = REVIEWED_EXTERNAL_TOOL_EXPOSURE,
): void {
  const sorted = (entries: readonly ExternalToolReview[]) =>
    [...entries].sort((a, b) => compareNames(a.tool, b.tool));
  if (canonical(sorted(actual)) !== canonical(sorted(expected))) {
    throw new Error("External tool declarations differ from the reviewed exposure snapshot.");
  }
}

function freezeReview(entry: ExternalToolReview): ExternalToolReview {
  return Object.freeze({
    ...entry,
    ...(entry.argsPatterns
      ? {
          argsPatterns: Object.freeze(
            entry.argsPatterns.map((pattern) => Object.freeze({ ...pattern })),
          ),
        }
      : {}),
  });
}

export const REVIEWED_EXTERNAL_TOOL_EXPOSURE: readonly ExternalToolReview[] = Object.freeze(
  (reviewedSnapshot as ExternalToolReview[]).map(freezeReview),
);

/** Compatibility view of the original policy, excluding host controller additions. */
export const FIRST_PHASE_EXPOSURE_RATIONALE: readonly ExposureRationale[] = Object.freeze(
  REVIEWED_EXTERNAL_TOOL_EXPOSURE.filter((entry) => !entry.requires),
);

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

function policyFromReviews(entries: readonly ExternalToolReview[]): ExternalToolExposurePolicy {
  return Object.freeze({
    mode: "allowlist" as const,
    toolNames: frozenSet(entries.map((entry) => entry.tool)),
    argsPatterns: frozenMap(
      entries
        .filter((entry) => entry.argsPatterns !== undefined)
        .map(
          (entry) =>
            [
              entry.tool,
              Object.freeze(entry.argsPatterns!.map((pattern) => Object.freeze({ ...pattern }))),
            ] as const,
        ),
    ),
  });
}

/**
 * A declaration must match the independently reviewed record byte-for-byte after
 * canonicalization. Unknown tools, replacements without metadata and contract
 * drift are excluded, including when the caller asks for their names explicitly.
 */
export function deriveExternalToolExposure(
  registry: ExternalExposureRegistry,
  options: { goalController?: boolean } = {},
): ExternalToolExposurePolicy {
  const reviews = new Map(REVIEWED_EXTERNAL_TOOL_EXPOSURE.map((entry) => [entry.tool, entry]));
  const accepted: ExternalToolReview[] = [];
  const seen = new Set<string>();
  for (const definition of registry.listToolsDetailed()) {
    if (seen.has(definition.name))
      throw new Error(`Duplicate tool registration: ${definition.name}`);
    seen.add(definition.name);
    const exposure = registry.getExposure(definition.name);
    const declaration = exposure?.external;
    const reviewed = reviews.get(definition.name);
    if (!exposure || !declaration || !reviewed || declaration.status !== "exposed") continue;
    if (declaration.requires === "goal-controller" && options.goalController !== true) continue;
    const actual = {
      tool: definition.name,
      ...declaration,
      contractFingerprint: externalToolContractFingerprint(definition, exposure),
    };
    if (canonical(actual) === canonical(reviewed)) accepted.push(reviewed);
  }
  return policyFromReviews(accepted);
}

/** Explicit host exposure may narrow the reviewed surface, never widen it. */
export function intersectExternalToolExposure(
  reviewed: ExternalToolExposurePolicy,
  requested?: ExternalToolExposurePolicy,
): ExternalToolExposurePolicy {
  if (!requested) return reviewed;
  const toolNames = [...reviewed.toolNames].filter((name) => requested.toolNames.has(name));
  const patterns: Array<readonly [string, readonly Readonly<Record<string, string>>[]]> = [];
  for (const name of toolNames) {
    const left = reviewed.argsPatterns?.get(name);
    const right = requested.argsPatterns?.get(name);
    if (!left && !right) continue;
    const alternatives = (value: typeof left): readonly Readonly<Record<string, string>>[] =>
      !value ? [{}] : Array.isArray(value) ? value : [value as Readonly<Record<string, string>>];
    const combined = alternatives(left).flatMap((a) =>
      alternatives(right).map((b) => {
        const pattern: Record<string, string> = { ...a };
        for (const [key, value] of Object.entries(b)) {
          pattern[key] =
            pattern[key] === undefined || pattern[key] === value
              ? value
              : `(?=(?:${pattern[key]})$)(?:${value})`;
        }
        return Object.freeze(pattern);
      }),
    );
    patterns.push([name, Object.freeze(combined)]);
  }
  return Object.freeze({
    mode: "allowlist",
    toolNames: frozenSet(toolNames),
    argsPatterns: frozenMap(patterns),
  });
}

/** Compatibility export; production factories derive from their composed registry. */
export const FIRST_PHASE_EXPOSURE: ExternalToolExposurePolicy = policyFromReviews(
  REVIEWED_EXTERNAL_TOOL_EXPOSURE.filter((entry) => entry.status === "exposed" && !entry.requires),
);
