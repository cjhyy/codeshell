/**
 * A structural guard against one specific mistake that has now been made three
 * times on this options object:
 *
 *   round 1  permissionRules defaulted to `[]`      → user/preset rules dropped
 *   round 2  permissionRules made caller-supplied   → obligation nobody enforced
 *   round 3  projectTrusted optional, default true  → untrusted repo self-authorizes
 *
 * Every instance was the same shape: **a security-relevant input that is
 * optional, with a default that fails open.** Reviews caught all three, but a
 * review is a person remembering; this is the machine remembering.
 *
 * The rule: an input that decides what an untrusted external runtime may do is
 * REQUIRED. If a value must be chosen, the choice belongs to the caller who
 * knows the answer, made visibly, at the call site.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSessionToolHost, type CreateSessionToolHostOptions } from "./session-tool-host.js";
import { ToolRegistry } from "./registry.js";

const SOURCE = readFileSync(new URL("./session-tool-host.ts", import.meta.url), "utf8");

/** A fully-specified, valid options object for the runtime half of the check. */
function baseOptions(): CreateSessionToolHostOptions {
  return {
    businessSessionId: "sess-contract",
    cwd: process.cwd(),
    registry: new ToolRegistry({ builtinTools: [] }),
    permissionMode: "default",
    presetRules: [],
    projectTrusted: false,
    planMode: false,
    exposure: { mode: "allowlist", toolNames: new Set<string>() },
    visibility: { cwd: process.cwd(), hasGoal: false },
  };
}

/**
 * Inputs where "not specified" must never silently resolve to the permissive
 * answer. Each entry names the failure it prevents so a future author who wants
 * to relax one has to argue with the reason, not just delete a line.
 */
const MUST_BE_REQUIRED: ReadonlyArray<{ field: string; because: string }> = [
  {
    field: "permissionMode",
    because: "decides whether the classifier consults rules at all",
  },
  {
    field: "presetRules",
    because: "an empty rule set silently downgrades every tool to the mode default",
  },
  {
    field: "projectTrusted",
    because: "defaulting to trusted lets a cloned repo self-authorize via settings",
  },
  {
    field: "planMode",
    because: "plan mode is a write barrier; defaulting it off widens the surface",
  },
  {
    field: "exposure",
    because: "without it there is no allowlist and nothing is narrowed",
  },
  {
    field: "visibility",
    because: "an absent toolVisibility makes ToolExecutor skip its availability guard",
  },
];

/**
 * Requiredness is asserted against the SOURCE TEXT rather than with a
 * compile-time `IsRequired<…>` helper.
 *
 * A type-level assertion here would be only partially enforced:
 * `packages/core/tsconfig.json` excludes `src/**\/*.test.ts`, so the
 * package-local typecheck skips it. The repo-root `bun run typecheck` DOES
 * include it — but that split means the guard would hold in CI and vanish for
 * anyone running the package check alone, which is the worse kind of guard:
 * present enough to be trusted, absent exactly when someone is iterating.
 *
 * A source scan runs wherever the test runs. It has to cover both spellings of
 * "may be absent": `field?: T` and `field: T | undefined`.
 */
function declarationOf(field: string): string {
  const start = SOURCE.indexOf("export interface CreateSessionToolHostOptions");
  expect(start).toBeGreaterThan(-1);
  // Slice to the closing brace of the interface, tolerating nested object types.
  let depth = 0;
  let end = SOURCE.indexOf("{", start);
  for (let i = end; i < SOURCE.length; i += 1) {
    if (SOURCE[i] === "{") depth += 1;
    else if (SOURCE[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const block = SOURCE.slice(start, end);
  const match = new RegExp(`^\\s*${field}(\\??):([^;]*);`, "m").exec(block);
  expect(match).not.toBeNull();
  return `${match![1]}:${match![2]}`;
}

describe("CreateSessionToolHostOptions contract", () => {
  test.each(MUST_BE_REQUIRED)("$field is required — $because", ({ field }) => {
    const declaration = declarationOf(field);
    // Not optional...
    expect(declaration.startsWith("?")).toBe(false);
    // ...and does not admit `undefined`, which keeps the required marker while
    // still allowing the "not specified" value through.
    expect(/\bundefined\b/.test(declaration)).toBe(false);
    // ...and is not a local alias that could hide `undefined` one level down.
    // Only inline types and imported types are allowed; a bare local identifier
    // (`projectTrusted: MaybeTrusted`) would move the question somewhere this
    // scan does not look.
    const named = /^:\s*([A-Za-z_$][\w$]*)\s*$/.exec(declaration);
    if (named) {
      const alias = new RegExp(`^\\s*(export\\s+)?type\\s+${named[1]}\\b`, "m").exec(SOURCE);
      expect(
        alias === null || !/\bundefined\b/.test(SOURCE.slice(alias.index).split(";")[0] ?? ""),
      ).toBe(true);
    }
  });

  test("options are never re-assigned or spread over with defaults", () => {
    // `options = Object.assign({projectTrusted: true}, options)` reintroduces
    // every default at once while leaving each per-field check untouched.
    const factory = SOURCE.slice(SOURCE.indexOf("export function createSessionToolHost"));
    expect(/\boptions\s*=\s*/.test(factory)).toBe(false);
    expect(/Object\.assign\s*\([^)]*options/.test(factory)).toBe(false);
    expect(/\{\s*\.\.\.\s*(defaults?|DEFAULTS?)[\s,]/.test(factory)).toBe(false);
  });

  test("omitting a required input does not silently yield a permissive host", () => {
    // The runtime half. TypeScript would reject these calls, so go around the
    // type to prove the VALUE is genuinely absent rather than quietly defaulted.
    for (const { field } of MUST_BE_REQUIRED) {
      const options = baseOptions();
      delete (options as Record<string, unknown>)[field];
      let built: { toolContext?: { planMode?: boolean } } | undefined;
      try {
        built = createSessionToolHost(options as never) as never;
      } catch {
        continue; // throwing on a missing required input is the correct outcome
      }
      if (field === "planMode") {
        // The one field whose default would be silently observable: it must not
        // have become `false` out of nowhere.
        expect(built?.toolContext?.planMode).toBeUndefined();
      }
    }
  });

  test("no security-relevant input acquires a fail-open default in the factory", () => {
    // Complements the type check: catches a default introduced INSIDE the
    // factory body, where requiredness of the option cannot help. Covers the
    // `??`, `||` and `!== false` spellings.
    const factory = SOURCE.slice(SOURCE.indexOf("export function createSessionToolHost"));
    for (const { field } of MUST_BE_REQUIRED) {
      const fallback = new RegExp(
        `options\\.${field}\\s*(\\?\\?|\\|\\||!==\\s*false|===\\s*undefined)`,
      ).exec(factory);
      expect(fallback).toBeNull();
    }
    // Destructuring defaults are the other way in, and they are invisible to the
    // per-field scan above.
    expect(/const\s*\{[^}]*=\s*(true|false|\[\])[^}]*\}\s*=\s*options/.test(factory)).toBe(false);
  });

  test("composePermissionRules does not re-introduce a trusted-by-default", () => {
    // The guard above protects session-tool-host.ts, but the value is CONSUMED
    // one call away. `ComposePermissionRulesOptions.projectTrusted` is optional
    // there (the Engine has its own defaulting), so the host must always pass an
    // explicit value rather than relying on the callee's default.
    const factory = SOURCE.slice(SOURCE.indexOf("export function createSessionToolHost"));
    const composeCall = /composePermissionRules\(\{[\s\S]*?\}\)/.exec(factory);
    expect(composeCall).not.toBeNull();
    expect(composeCall![0]).toContain("projectTrusted: options.projectTrusted");
  });
});
