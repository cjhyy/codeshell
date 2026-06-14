// Pre-package step: replace the @cjhyy/code-shell-core workspace SYMLINK with a
// real, self-contained directory inside packages/desktop/node_modules.
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
// All of desktop's OTHER deps are build-time only (esbuild bundles main, vite
// bundles the renderer; only `electron` + this package stay external), so they
// live in devDependencies and electron-builder never walks them. core is the
// ONE runtime dep that must ship as real files — main spawns its
// bin/agent-server-stdio as a child process via the Electron-as-node runtime.
//
// THE FIX
// -------
// Materialize core into a real in-tree directory containing exactly what the
// app needs at runtime: dist/, package.json, and core's own production
// node_modules (dereferenced from bun's .bun store into real files). LICENSE
// and README are deliberately NOT copied — they are the offending out-of-tree
// files and a bundled internal copy needs neither.
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
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const coreSrc = resolve(repoRoot, "packages/core");
const target = resolve(desktopRoot, "node_modules/@cjhyy/code-shell-core");

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[predist] ${msg}`);
}

function main(): void {
  if (!existsSync(coreSrc)) throw new Error(`core package not found at ${coreSrc}`);

  // Drop whatever is currently at the target (symlink, or a stale real dir from
  // a previous run). On Windows a workspace link is a directory JUNCTION, and
  // `rmSync(force)` without `recursive` throws EFAULT on it — so always pass
  // `recursive: true`. For a junction/symlink, `recursive` removes only the
  // link entry, never following it into the real core dir (verified: rm of a
  // junction does not delete the target's contents).
  if (isSymlink(target)) {
    log(`unlinking link -> ${safeReadlink(target)}`);
    rmSync(target, { recursive: true, force: true });
  } else if (existsSync(target)) {
    log(`removing stale real dir`);
    rmSync(target, { recursive: true, force: true });
  }

  mkdirSync(target, { recursive: true });

  // coreSrc is a real path; its dist/package.json are real files.
  copyDir(resolve(coreSrc, "dist"), resolve(target, "dist"));
  copyFile(resolve(coreSrc, "package.json"), resolve(target, "package.json"));

  // core's production deps — the spawned agent-server requires them at runtime.
  // bun nests these as symlinks into the global .bun store; dereference into
  // real files so the packaged app doesn't ship links to absolute store paths
  // that won't exist on the user's machine. Skip dead/orphan links (dev cruft).
  materializeNodeModules(
    resolve(coreSrc, "node_modules"),
    resolve(target, "node_modules"),
  );

  log(`materialized core into node_modules (LICENSE/README excluded)`);
}

function materializeNodeModules(from: string, to: string): void {
  if (!existsSync(from)) {
    log(`core has no node_modules (deps hoisted) — nothing to materialize`);
    return;
  }
  mkdirSync(to, { recursive: true });
  let copied = 0;
  let skipped = 0;
  for (const name of readdirSync(from)) {
    if (name === ".bin" || name === ".vite" || name === ".cache") continue;
    const src = resolve(from, name);
    if (name.startsWith("@")) {
      // Scope dir: copy each inner package independently.
      mkdirSync(resolve(to, name), { recursive: true });
      for (const inner of readdirSync(src)) {
        if (copyPkg(resolve(src, inner), resolve(to, name, inner))) copied++;
        else skipped++;
      }
      continue;
    }
    if (copyPkg(src, resolve(to, name))) copied++;
    else skipped++;
  }
  log(`node_modules: copied ${copied}, skipped ${skipped} dead/orphan link(s)`);
}

/** Copy one package dir, dereferencing links. Returns false on dead link. */
function copyPkg(src: string, dest: string): boolean {
  try {
    statSync(src); // follows links; throws on a dead link → skip
    cpSync(src, dest, { recursive: true, dereference: true });
    return true;
  } catch {
    return false;
  }
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
