// Pre-package step: replace the Link, core and capability workspace
// SYMLINKS with real, self-contained directories inside desktop/node_modules.
//
// WHY THIS EXISTS
// ---------------
// code-shell-core is a workspace package. bun links it as a symlink:
//   packages/desktop/node_modules/@cjhyy/code-shell-core -> ../../../core
// At package time electron-builder follows that symlink into packages/core and
// then trips its hard "file must be under <app>" guard on core's sibling
// LICENSE — failing on a clean checkout with:
//   ⨯ packages/core/LICENSE must be under packages/desktop/
// (electron-userland/electron-builder#3238). The guard fires while walking the
// symlink target, so neither a negative `files` glob nor trimming core's own
// `files` field avoids it — both were tried and don't work.
//
// The materialized workspace list below drives every production copy operation.
// Core, coding, Pet, and Optimization Lab are runtime deps: main spawns the coding
// worker, which dynamically loads the capabilities through core's extension seam.
// Link is also copied for runtime consumers of its manifests. Other workspaces
// are build-time deps (esbuild bundles main, vite bundles the renderer).
// Host is built before main and bundled by esbuild; it needs no separate
// materialized runtime directory or additional production dependency closure.
//
// THE FIX
// -------
// Materialize the runtime packages into real in-tree directories containing exactly
// what the app needs at runtime: dist/ + package.json, plus core's production
// dependency closure. LICENSE and README are deliberately NOT copied — they
// are the offending out-of-tree files and a bundled internal copy needs neither.
//
// Idempotent and best-effort: dead/orphan symlinks in a dev box's node_modules
// are skipped rather than aborting. A clean CI checkout has none. We do not
// restore the symlink afterwards — the materialized dir still resolves the
// package for dev, and `bun install` re-links on the next install.

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesktopWorkspaceDependencies } from "./build-workspace-dependencies.js";
import { installProductionClosure, loadProductionClosures } from "./production-dependencies.js";
import {
  assertMaterializedWorkspaceDependencies,
  DESKTOP_MATERIALIZED_WORKSPACES,
  readRepositoryWorkspaceNames,
  type ProductionWorkspaceManifest,
} from "./materialized-workspaces.js";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const materializedWorkspaces = DESKTOP_MATERIALIZED_WORKSPACES.map((entry) => ({
  ...entry,
  source: resolve(repoRoot, entry.relativeDir),
  target: resolve(desktopRoot, "node_modules", entry.packageName),
}));

function readManifest(directory: string): ProductionWorkspaceManifest {
  return JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
}

function verifyWorkspaceMaterialization(): void {
  const workspaceNames = readRepositoryWorkspaceNames(repoRoot);
  assertMaterializedWorkspaceDependencies(readManifest(desktopRoot), workspaceNames);
  for (const { source } of materializedWorkspaces) {
    assertMaterializedWorkspaceDependencies(readManifest(source), workspaceNames);
  }
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[predist] ${msg}`);
}

function main(): void {
  for (const { label, source } of materializedWorkspaces) {
    if (!existsSync(source)) throw new Error(`${label} package not found at ${source}`);
  }
  // Fail before building or modifying node_modules if a new production workspace
  // dependency would make electron-builder follow a symlink outside this app.
  verifyWorkspaceMaterialization();
  const productionClosures = loadProductionClosures(repoRoot);
  // Rebuild every direct desktop workspace dependency, in dependency order,
  // BEFORE the desktop bundle. Previously this step only asserted that
  // each `dist` existed (see copyDir) — so whatever a developer or CI job had
  // left on disk got shipped. `bun run --cwd packages/desktop dist` only triggers
  // desktop's own build, so core/pet/coding dist could predate the source by any amount.
  // Building here makes `dist`/`pack` reproducible from a clean checkout and
  // removes the "did you remember to run the root build first?" failure mode.
  buildDesktopWorkspaceDependencies();

  // electron-builder only packs whatever is already in out/**. Materializing
  // runtime packages alone would silently ship a stale main/renderer/mobile
  // bundle whenever sources changed without rebuilding out/.
  // `build` is fast (esbuild + vite prod) and idempotent.
  log("building desktop bundle (out/) before packaging");
  execFileSync("bun", ["run", "build"], { cwd: desktopRoot, stdio: "inherit" });

  // Drop whatever is currently at the target (symlink, or a stale real dir from
  // a previous run). On Windows a workspace link is a directory JUNCTION, and
  // `rmSync(force)` without `recursive` throws EFAULT on it — so always pass
  // `recursive: true`. For a junction/symlink, `recursive` removes only the
  // link entry, never following it into the real core dir (verified: rm of a
  // junction does not delete the target's contents).
  for (const { label, source, target } of materializedWorkspaces) {
    removeWorkspaceTarget(target, label);
    materializePackage(source, target);
  }

  // Each materialized sibling owns its production closure.
  // Optimization Lab imports zod directly; core's nested node_modules cannot serve
  // sibling-package resolution in the packaged app.
  for (const {
    label,
    relativeDir,
    source,
    target,
    installProductionDependencies,
  } of materializedWorkspaces) {
    if (!installProductionDependencies) continue;
    log(`installing ${label} locked production dependency closure`);
    installProductionClosure(source, target, productionClosures.get(relativeDir)!);
  }
  verifyMaterializedCapabilities();

  log(
    `materialized ${materializedWorkspaces.map(({ label }) => label).join(" + ")} into node_modules (LICENSE/README excluded)`,
  );
}

function verifyMaterializedCapabilities(): void {
  log("verifying packaged capabilities can resolve their runtime dependencies");
  execFileSync(
    "bun",
    [
      "--eval",
      materializedWorkspaces
        .map(({ importSpecifier }) => `await import(${JSON.stringify(importSpecifier)})`)
        .join("; "),
    ],
    { cwd: desktopRoot, stdio: "inherit" },
  );
}

function removeWorkspaceTarget(target: string, label: string): void {
  if (isSymlink(target)) {
    log(`unlinking ${label} link -> ${safeReadlink(target)}`);
    rmSync(target, { recursive: true, force: true });
  } else if (existsSync(target)) {
    log(`removing stale ${label} real dir`);
    rmSync(target, { recursive: true, force: true });
  }
}

function materializePackage(source: string, target: string): void {
  mkdirSync(target, { recursive: true });
  copyDir(resolve(source, "dist"), resolve(target, "dist"));
  copyFile(resolve(source, "package.json"), resolve(target, "package.json"));
}

function copyDir(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`expected ${from} to exist (build core first)`);
  cpSync(from, to, { recursive: true, dereference: true });
}

function copyFile(from: string, to: string): void {
  if (!existsSync(from)) throw new Error(`expected ${from} to exist`);
  cpSync(from, to, { dereference: true });
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeReadlink(p: string): string {
  try {
    return readlinkSync(p);
  } catch {
    return "(unreadable)";
  }
}

main();
