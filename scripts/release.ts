#!/usr/bin/env bun
/**
 * One-shot release helper: bump every package to the same version, verify they
 * agree, commit `chore: release <version>`, and (optionally) push + tag to fire
 * the tag-driven GitHub Actions release workflow.
 *
 * Why this exists
 * ---------------
 * The release depends on every workspace package.json `version`, the public
 * core `VERSION` export, and the workspace version references in `bun.lock`.
 * The shared release declaration keeps this helper, CI verification, tarball
 * audit, and npm publish order on one package set.
 * electron-builder names its artifacts and writes latest-*.yml from
 * package.json's version — NOT the git tag. Two real incidents came from doing
 * this by hand:
 *   - moved a tag but never rebuilt the release → users auto-updated to a stale
 *     build (see codeshell-release-version-tag-desync-root-cause).
 *   - tagged rc.10 while package.json still said rc.9 → artifacts were named
 *     rc.9 and latest-mac.yml pointed back at rc.9.
 * This script makes the bump atomic and asserts consistency so the CI
 * `verify-version` gate never even has to fire.
 *
 * Usage
 * -----
 *   bun run scripts/release.ts 0.6.0-beta.1        # explicit beta version
 *   bun run scripts/release.ts --bump beta         # auto-increment beta number
 *   bun run scripts/release.ts 0.6.0-rc.11          # bump + local commit
 *   bun run scripts/release.ts 0.6.0-rc.11 --dry-run # verify and preview only
 *   bun run scripts/release.ts --bump rc            # auto-increment the rc number
 *   bun run scripts/release.ts 0.6.0-rc.11 --push   # also push main + tag → CI
 *
 * Flags:
 *   --push        after committing, push main and push an annotated tag v<version>.
 *   --dry-run     verify the current release state and print the planned bump;
 *                 do not edit, install, stage, commit, tag, or push.
 *   --bump <part> compute the next version instead of passing it explicitly.
 *                 part ∈ { beta, rc, patch, minor, major }.
 *                 `beta`/`rc` bump or append -beta.N/-rc.N.
 *   --allow-dirty skip the clean-tree check (default: refuse if other changes exist).
 *
 * Safe by default: without --push it only edits files + commits locally, so you
 * can review before anything leaves the machine.
 */

import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { RELEASE_PACKAGES, packageManifestPath } from "./package-release-audit-config";
import { verifyReleaseVersions } from "./verify-release-versions";

const ROOT = resolve(import.meta.dir, "..");
const PKG_FILES = RELEASE_PACKAGES.map(packageManifestPath);
const LOCKFILE = "bun.lock";
const CORE_VERSION_FILE = "packages/core/src/index.ts";
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(rc|beta)\.(\d+))?$/;
const CORE_VERSION_RE = /^export const VERSION = "([^"]+)";$/m;
const VERSION_FORMAT = "X.Y.Z, X.Y.Z-rc.N, or X.Y.Z-beta.N";

function die(msg: string): never {
  console.error(`\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
}

function readVersion(rel: string): string {
  return JSON.parse(readFileSync(resolve(ROOT, rel), "utf8")).version;
}

function rewriteManifestVersion(rel: string, current: string, target: string): void {
  const path = resolve(ROOT, rel);
  const before = readFileSync(path, "utf8");
  const versionField = /^(\s*"version"\s*:\s*")([^"]+)(")/m;
  const found = before.match(versionField)?.[2];
  if (found !== current) {
    die(`${rel} version is ${found ?? "<missing>"}, expected ${current}`);
  }
  writeFileSync(path, before.replace(versionField, `$1${target}$3`));
}

/** Compute the next version from the current one for `--bump <part>`. */
function computeBump(current: string, part: string): string {
  const match = current.match(VERSION_RE);
  if (!match) die(`can't --bump ${part} from non-standard version "${current}"`);

  const [, major, minor, patch, prereleaseKind, prereleaseNumber] = match;
  const base = `${major}.${minor}.${patch}`;

  if (part === "beta" || part === "rc") {
    if (prereleaseKind === part && prereleaseNumber) {
      return `${base}-${part}.${Number(prereleaseNumber) + 1}`;
    }
    return `${base}-${part}.1`;
  }

  let a = Number(major);
  let b = Number(minor);
  let c = Number(patch);
  if (part === "patch") c += 1;
  else if (part === "minor") ((b += 1), (c = 0));
  else if (part === "major") ((a += 1), (b = 0), (c = 0));
  else die(`unknown --bump part "${part}" (use beta|rc|patch|minor|major)`);
  return `${a}.${b}.${c}`;
}

// ── parse args ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const push = argv.includes("--push");
const dryRun = argv.includes("--dry-run");
const allowDirty = argv.includes("--allow-dirty");
const bumpIdx = argv.indexOf("--bump");
const bumpValueIdx = bumpIdx === -1 ? -1 : bumpIdx + 1;
const positional = argv.filter((a, i) => !a.startsWith("--") && i !== bumpValueIdx);

const current = readVersion("package.json");
let target: string;
if (bumpIdx !== -1) {
  const part = argv[bumpIdx + 1];
  if (!part) die("--bump needs a part: beta|rc|patch|minor|major");
  target = computeBump(current, part);
} else if (positional[0]) {
  target = positional[0];
} else {
  die("give a version (e.g. 0.6.0-beta.1) or --bump beta");
}

if (!VERSION_RE.test(target)) {
  die(`version "${target}" is not ${VERSION_FORMAT}`);
}
if (target === current) die(`version is already ${target} — nothing to bump`);
if (dryRun && push) die("--dry-run cannot be combined with --push");

console.log(`\x1b[36m→ ${current}  →  ${target}\x1b[0m`);

// ── clean-tree check ────────────────────────────────────────────────────────
const status = (await $`git status --porcelain`.cwd(ROOT).text()).trim();
if (status && !allowDirty && !dryRun) {
  die(`working tree not clean — commit/stash first, or pass --allow-dirty:\n${status}`);
}

try {
  verifyReleaseVersions(current, ROOT);
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}

if (dryRun) {
  console.log(
    `\x1b[32m✓ dry run: would update ${PKG_FILES.length} package manifests, bun.lock, and core VERSION to ${target}\x1b[0m`,
  );
  process.exit(0);
}

// ── rewrite versions ────────────────────────────────────────────────────────
const files = [...PKG_FILES, LOCKFILE, CORE_VERSION_FILE];
const coreVersionPath = resolve(ROOT, CORE_VERSION_FILE);
const coreBefore = readFileSync(coreVersionPath, "utf8");
const coreVersion = coreBefore.match(CORE_VERSION_RE)?.[1];
if (!coreVersion) die(`could not find VERSION export in ${CORE_VERSION_FILE}`);
if (coreVersion !== current) {
  die(
    `${CORE_VERSION_FILE} VERSION is ${coreVersion}, expected current package version ${current}`,
  );
}

for (const rel of PKG_FILES) rewriteManifestVersion(rel, current, target);

const coreAfter = coreBefore.replace(CORE_VERSION_RE, `export const VERSION = "${target}";`);
if (coreAfter !== coreBefore) writeFileSync(coreVersionPath, coreAfter);

// Let Bun update only workspace metadata and any generated own-package specs.
// A literal replace across bun.lock is unsafe: third-party packages may happen
// to use the same version number as CodeShell.
await $`bun install --lockfile-only --ignore-scripts`.cwd(ROOT);

// ── verify consistency (the whole point) ────────────────────────────────────
try {
  verifyReleaseVersions(target, ROOT);
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
}
console.log(
  `\x1b[32m✓ all ${PKG_FILES.length} package.json + bun.lock + core VERSION now ${target}\x1b[0m`,
);

// ── commit ──────────────────────────────────────────────────────────────────
await $`git add ${files}`.cwd(ROOT);
await $`git commit -m ${`chore: release ${target}`}`.cwd(ROOT);
console.log(`\x1b[32m✓ committed "chore: release ${target}"\x1b[0m`);

if (!push) {
  console.log(
    `\nLocal release commit created (no --push). Review, then:\n` +
      `  git push origin main\n` +
      `  git tag -a v${target} -m "release ${target}" && git push origin v${target}\n`,
  );
  process.exit(0);
}

// ── push main + tag → fires CI ──────────────────────────────────────────────
await $`git push origin main`.cwd(ROOT);
await $`git tag -a ${`v${target}`} -m ${`release ${target}`}`.cwd(ROOT);
await $`git push origin ${`v${target}`}`.cwd(ROOT);
console.log(`\x1b[32m✓ pushed main + tag v${target} — CI release workflow triggered\x1b[0m`);
console.log(
  `\nVerify when CI finishes:\n` +
    `  curl -sL https://github.com/cjhyy/codeshell/releases/download/v${target}/latest-mac.yml | grep version\n` +
    `  → must read "version: ${target}"\n`,
);
