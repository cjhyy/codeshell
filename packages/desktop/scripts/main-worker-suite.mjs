// Helpers for Desktop Main suites that start REAL worker threads. Production
// runs these workers on Electron/Node; under `bun test` 1.4.5 their replies and
// the test's own timers intermittently stopped being delivered (and
// `expect(promise).rejects` on a worker reply never settled), so these suites
// run under node --test in the "Desktop script suites" step.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * Compile Main modules as the shipped `.mjs` siblings (a client resolves
 * `./<worker>.mjs` next to itself) and import the first entry. Workspace
 * packages stay external and resolve from Desktop's node_modules.
 */
export async function compileMainModules(names) {
  const cache = join(desktop, "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const outdir = mkdtempSync(join(cache, "main-worker-suite-"));
  try {
    await build({
      entryPoints: Object.fromEntries(
        names.map((name) => [name, join(desktop, "src", "main", `${name}.ts`)]),
      ),
      outdir,
      outExtension: { ".js": ".mjs" },
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
    });
    return {
      outdir,
      module: await import(pathToFileURL(join(outdir, `${names[0]}.mjs`)).href),
      remove: () => rmSync(outdir, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(outdir, { recursive: true, force: true });
    throw error;
  }
}

const isRecord = (value) => typeof value === "object" && value !== null;

/** Jest/Bun `toEqual`: recursive equality that ignores properties set to undefined. */
export function equals(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      Array.isArray(expected) &&
      actual.length === expected.length &&
      actual.every((value, index) => equals(value, expected[index]))
    );
  }
  if (!isRecord(actual) || !isRecord(expected)) return false;
  const defined = (value) =>
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
  const keys = defined(actual);
  const expectedKeys = defined(expected);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index] && equals(actual[key], expected[key]))
  );
}

/** Jest/Bun `toMatchObject`: objects match a subset; arrays match element-wise at equal length. */
export function matchesObject(actual, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => matchesObject(actual[index], value))
    );
  }
  if (isRecord(expected)) {
    return (
      isRecord(actual) &&
      Object.keys(expected).every(
        (key) => key in actual && matchesObject(actual[key], expected[key]),
      )
    );
  }
  return equals(actual, expected);
}

function fail(matcher, actual, expected) {
  const show = (value) => {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };
  throw new Error(`expect(${show(actual)}).${matcher}(${show(expected)}) failed`);
}

function thrownMatches(error, expected) {
  if (expected === undefined) return true;
  const message = error instanceof Error ? error.message : String(error);
  return typeof expected === "string" ? message.includes(expected) : expected.test(message);
}

/** The subset of Bun's `expect` these suites use, with the same semantics. */
export function expect(actual) {
  return {
    toBe: (expected) => Object.is(actual, expected) || fail("toBe", actual, expected),
    toEqual: (expected) => equals(actual, expected) || fail("toEqual", actual, expected),
    toMatchObject: (expected) =>
      matchesObject(actual, expected) || fail("toMatchObject", actual, expected),
    toBeNull: () => actual === null || fail("toBeNull", actual, null),
    toBeUndefined: () => actual === undefined || fail("toBeUndefined", actual, undefined),
    toHaveLength: (length) =>
      (isRecord(actual) || typeof actual === "string") && actual.length === length
        ? true
        : fail("toHaveLength", actual, length),
    toBeGreaterThan: (expected) => actual > expected || fail("toBeGreaterThan", actual, expected),
    toBeInstanceOf: (type) => actual instanceof type || fail("toBeInstanceOf", actual, type.name),
    rejects: {
      toThrow: async (expected) => {
        let rejected = false;
        let reason;
        try {
          await actual;
        } catch (error) {
          rejected = true;
          reason = error;
        }
        if (!rejected) fail("rejects.toThrow", "resolved", expected);
        if (!thrownMatches(reason, expected)) fail("rejects.toThrow", String(reason), expected);
      },
    },
  };
}
