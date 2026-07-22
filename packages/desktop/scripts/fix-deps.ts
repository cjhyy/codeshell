/**
 * Post-install fix for bun's workspace transitive-dependency linking.
 *
 * Problem: bun downloads every package into `node_modules/.bun/` (a
 * content-addressable store) but on Windows fails to create junctions for
 * transitive dependencies of workspace packages into the workspace package's
 * nested `node_modules/`. The packages physically exist in `.bun` but are
 * not linked anywhere Node's ESM resolver can find them, so the first
 * `import` of a transitive dep throws `ERR_MODULE_NOT_FOUND`.
 *
 * Most affected path: `@cjhyy/code-shell-core` is marked `external` in the
 * desktop esbuild config (see `scripts/build.ts`) and loaded from
 * `node_modules` at runtime by Electron. Core's own direct deps are linked
 * fine, but their transitive deps — e.g. `eventsource-parser` (required by
 * `@modelcontextprotocol/sdk`), `ansi-regex` (required by `strip-ansi`),
 * `pkce-challenge`, `ajv` — are missing entirely.
 *
 * Fix: parse `bun.lock` to build the full dependency tree of
 * `@cjhyy/code-shell-core` with exact resolved versions, then copy each
 * missing package from the `.bun` store into core's nested `node_modules/`.
 *
 * Why we use the lockfile instead of just scanning `.bun`: the store may
 * contain MULTIPLE versions of the same package (e.g. `brace-expansion@1`,
 * `@2`, `@5`). A naive "scan-and-copy" picks whichever version it sees
 * first, which is almost always wrong — wrong major versions break ESM
 * default-import expectations (v2 has `export default`, v5 uses named
 * exports). The lockfile tells us exactly which version each package needs.
 *
 * Why copy instead of junction: bun's own junction creation fails with
 * EEXIST on this workspace layout, and PowerShell `New-Item -Junction`
 * is unreliable when the parent path already contains broken reparse
 * points from a previous failed `bun install`. A plain recursive copy
 * sidesteps all reparse-point issues and is a one-time cost (~1-2 s).
 *
 * Idempotent — safe to run multiple times; existing packages are always
 * left untouched.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  copyFileSync,
  mkdirSync,
} from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

// Resolve semver from core's node_modules — it's a direct dep of core so
// always available there, but may not be visible from this script's
// location (desktop/scripts) during postinstall.
const _require = createRequire(import.meta.url);
const corePkgDir = join(desktopRoot, "node_modules", "@cjhyy", "code-shell-core");
const semver = _require(_require.resolve("semver/package.json", { paths: [corePkgDir] }).replace(/[/\\]package\.json$/, "")) as typeof import("semver");

const bunLockPath = join(repoRoot, "bun.lock");
const bunStore = join(repoRoot, "node_modules", ".bun");
const coreNm = join(
  desktopRoot,
  "node_modules",
  "@cjhyy",
  "code-shell-core",
  "node_modules",
);

// --- Guards ---------------------------------------------------------------

if (!existsSync(bunLockPath)) {
  console.log("[fix-deps] bun.lock not found; skipping.");
  process.exit(0);
}
if (!existsSync(bunStore)) {
  console.log("[fix-deps] no .bun store found; skipping.");
  process.exit(0);
}
if (!existsSync(coreNm)) {
  console.log("[fix-deps] core's nested node_modules not found; skipping.");
  process.exit(0);
}

// --- Parse lockfile -------------------------------------------------------

type LockEntry = [
  string, // resolved version (e.g. "brace-expansion@2.1.1")
  string, // path (empty for top-level, otherwise like "glob/minimatch")
  { dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalPeers?: string[] },
  string, // sha512
];

const lockJson = parseJsonc(readFileSync(bunLockPath, "utf8")) as {
  packages: Record<string, LockEntry>;
  workspaces: Record<string, { name: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
};

/**
 * bun's lockfile has trailing commas (not valid JSON) but no comments.
 * Strip trailing commas before parsing — much simpler than a full JSONC
 * parser, and we don't need to worry about string contents because
 * bun.lock never contains `,}` or `,]` inside string values.
 */
function parseJsonc(text: string): unknown {
  // Remove trailing commas before } or ]
  const cleaned = text.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(cleaned);
}

const lockEntries = lockJson.packages;

// --- Collect already-available packages -----------------------------------

function collectPackages(nmDir: string): Set<string> {
  const result = new Set<string>();
  if (!existsSync(nmDir)) return result;
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(nmDir, { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scopeDir = join(nmDir, entry.name);
      try {
        for (const sub of readdirSync(scopeDir, { withFileTypes: true })) {
          if (sub.isDirectory()) {
            result.add(`${entry.name}/${sub.name}`);
          }
        }
      } catch {
        // skip
      }
    } else {
      result.add(entry.name);
    }
  }
  return result;
}

const available = new Set<string>([
  ...collectPackages(coreNm),
  ...collectPackages(join(desktopRoot, "node_modules")),
  ...collectPackages(join(repoRoot, "node_modules")),
  ...collectPackages(join(repoRoot, "packages", "core", "node_modules")),
]);

// --- Resolve core's full dependency tree from the lockfile ----------------

// Find all lock entries for a given package name, returning them as
// [key, entry] pairs sorted by version (highest first).
function findLockEntries(pkgName: string): [string, LockEntry][] {
  const results: [string, LockEntry][] = [];
  for (const [key, entry] of Object.entries(lockEntries)) {
    // Key can be just the name, or "parent/child" for nested deps.
    // We match if the last path segment equals the package name.
    const segments = key.split("/");
    const lastName = segments[segments.length - 1];
    // For scoped packages, match last two segments.
    if (pkgName.startsWith("@")) {
      const nameParts = pkgName.split("/");
      if (
        segments.length >= 2 &&
        segments[segments.length - 2] === nameParts[0] &&
        lastName === nameParts[1]
      ) {
        results.push([key, entry]);
      }
    } else if (lastName === pkgName) {
      results.push([key, entry]);
    }
  }
  // Sort by resolved version descending
  results.sort((a, b) => {
    const va = a[1][0].split("@").pop() || "0.0.0";
    const vb = b[1][0].split("@").pop() || "0.0.0";
    try {
      return semver.rcompare(va, vb);
    } catch {
      return 0;
    }
  });
  return results;
}

// Find the lock entry key whose resolved version satisfies a range.
function findBestEntry(pkgName: string, range: string): string | null {
  const entries = findLockEntries(pkgName);
  for (const [key, entry] of entries) {
    const version = entry[0].split("@").pop() || "0.0.0";
    try {
      if (semver.satisfies(version, range)) {
        return key;
      }
    } catch {
      // invalid version or range — skip
    }
  }
  return null;
}

// BFS from core's direct deps to collect every needed package.
// Map: packageName -> resolvedVersionString (from lock entry [0])
const needed = new Map<string, string>();
// Also track which lockfile key resolved to which version for dependency
// lookup — since different parents may resolve the same dep differently.
const queue: Array<{ name: string; range: string }> = [];

// Start with core's direct dependencies from the lockfile workspace entry.
const coreWorkspace = lockJson.workspaces["packages/core"];
if (!coreWorkspace) {
  console.log("[fix-deps] core workspace entry not found in lockfile; skipping.");
  process.exit(0);
}

const allCoreDeps = {
  ...(coreWorkspace.dependencies || {}),
};
for (const [name, range] of Object.entries(allCoreDeps)) {
  if (name.startsWith("@cjhyy/")) continue; // skip workspace packages
  queue.push({ name, range });
}

// BFS to resolve the full tree
while (queue.length > 0) {
  const { name, range } = queue.shift()!;
  if (needed.has(name)) continue; // already resolved

  const lockKey = findBestEntry(name, range);
  if (!lockKey) {
    // Can't find in lockfile — skip (probably a workspace package or
    // optional peer that's not installed).
    continue;
  }

  const entry = lockEntries[lockKey];
  const resolvedVer = entry[0]; // e.g. "brace-expansion@2.1.1"
  needed.set(name, resolvedVer);

  // Add transitive deps
  const deps = entry[2].dependencies || {};
  for (const [depName, depRange] of Object.entries(deps)) {
    if (!needed.has(depName) && !depName.startsWith("@cjhyy/")) {
      queue.push({ name: depName, range: depRange });
    }
  }
}

// --- Copy helper ----------------------------------------------------------

function copyDirRecursive(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const dstPath = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, dstPath);
    } else {
      copyFileSync(srcPath, dstPath);
    }
  }
}

// --- Find a package in the .bun store by exact version --------------------

function findInStore(resolvedVer: string): string | null {
  // resolvedVer is like "brace-expansion@2.1.1" or "@scope/pkg@1.2.3"
  // In the .bun store, scoped packages use "+" instead of "/":
  //   "@scope+pkg@1.2.3"
  const storeName = resolvedVer.startsWith("@")
    ? resolvedVer.replace("/", "+")
    : resolvedVer;
  const storeDir = join(bunStore, storeName, "node_modules");
  if (!existsSync(storeDir)) return null;

  // Inside node_modules, find the actual package directory.
  const pkgName = resolvedVer.startsWith("@")
    ? resolvedVer.slice(0, resolvedVer.lastIndexOf("@"))
    : resolvedVer.slice(0, resolvedVer.lastIndexOf("@"));

  const pkgDir = join(storeDir, pkgName);
  if (existsSync(join(pkgDir, "package.json"))) {
    return pkgDir;
  }
  return null;
}

// --- Copy / replace packages ----------------------------------------------

let copied = 0;
let replaced = 0;
let skipped = 0;
let notFound = 0;
const copiedNames: string[] = [];
const replacedNames: string[] = [];

/**
 * Recursively delete a directory. We can't use `rm -rf` because
 * PowerShell's Remove-Item -Recurse follows junctions and would wipe
 * the .bun store. This helper only deletes real files/dirs.
 */
function rmDirRecursive(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory() && !(entry as any).isSymbolicLink?.()) {
      rmDirRecursive(p);
    } else {
      try {
        (require("node:fs") as typeof import("node:fs")).unlinkSync(p);
      } catch {
        // best-effort
      }
    }
  }
  try {
    (require("node:fs") as typeof import("node:fs")).rmdirSync(dir);
  } catch {
    // best-effort
  }
}

for (const [pkgName, resolvedVer] of needed) {
  const src = findInStore(resolvedVer);
  if (!src) {
    notFound++;
    continue;
  }

  const dst = join(coreNm, pkgName);

  if (available.has(pkgName)) {
    // Package exists somewhere — but is it the right major version?
    // If it's in core's own node_modules with a different major version,
    // it's almost certainly wrong (a previous naive install picked the
    // wrong version from the .bun store). Replace it with the exact
    // version the lockfile resolved to.
    if (existsSync(join(dst, "package.json"))) {
      const requiredVersion = resolvedVer.slice(resolvedVer.lastIndexOf("@") + 1);
      const requiredMajor = semver.major(requiredVersion);
      let installedVersion = "";
      try {
        installedVersion = (JSON.parse(readFileSync(join(dst, "package.json"), "utf8")) as { version: string }).version;
      } catch {
        skipped++;
        continue;
      }
      const installedMajor = semver.major(installedVersion);
      if (requiredMajor === installedMajor) {
        // Same major — likely compatible, leave it alone.
        skipped++;
        continue;
      }
      // Different major — replace with the correct version.
      rmDirRecursive(dst);
      try {
        copyDirRecursive(src, dst);
        replaced++;
        replacedNames.push(`${pkgName}@${installedVersion}→${requiredVersion}`);
      } catch (err) {
        console.error(`[fix-deps] failed to replace ${pkgName}: ${(err as Error).message}`);
      }
    } else {
      // It's in desktop/root node_modules, not core's — that's fine,
      // Node will find it via the resolution chain.
      skipped++;
    }
    continue;
  }

  // Package not available anywhere — copy it in.
  try {
    copyDirRecursive(src, dst);
    available.add(pkgName);
    copiedNames.push(pkgName);
    copied++;
  } catch (err) {
    console.error(`[fix-deps] failed to copy ${pkgName}: ${(err as Error).message}`);
  }
}

// --- Report ---------------------------------------------------------------

const totalChanges = copied + replaced;
if (totalChanges > 0) {
  const parts: string[] = [];
  if (copied > 0) parts.push(`${copied} added`);
  if (replaced > 0) parts.push(`${replaced} replaced`);
  parts.push(`${skipped} ok`, `${notFound} not in store`);
  console.log(`[fix-deps] ${parts.join(" · ")} (total needed: ${needed.size}).`);
  if (copied > 0) {
    const preview = copiedNames.slice(0, 10).join(", ");
    const suffix = copiedNames.length > 10 ? `, … (+${copiedNames.length - 10} more)` : "";
    console.log(`[fix-deps] added: ${preview}${suffix}`);
  }
  if (replaced > 0) {
    const preview = replacedNames.slice(0, 10).join(", ");
    const suffix = replacedNames.length > 10 ? `, … (+${replacedNames.length - 10} more)` : "";
    console.log(`[fix-deps] replaced: ${preview}${suffix}`);
  }
} else {
  console.log(`[fix-deps] all ${needed.size} packages at correct versions.`);
}
