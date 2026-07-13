// Pre-package step: replace the core and optional Arena workspace SYMLINKS with
// real, self-contained directories inside packages/desktop/node_modules.
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
// bundles the renderer). core and Arena are runtime deps: main spawns core's
// bin/agent-server-stdio as a child process, and that worker dynamically loads
// the Arena package through core's capability seam.
//
// THE FIX
// -------
// Materialize both packages into real in-tree directories containing exactly
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
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const coreSrc = resolve(repoRoot, "packages/core");
const arenaSrc = resolve(repoRoot, "packages/arena");
const coreTarget = resolve(desktopRoot, "node_modules/@cjhyy/code-shell-core");
const arenaTarget = resolve(desktopRoot, "node_modules/@cjhyy/code-shell-arena");

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[predist] ${msg}`);
}

function main(): void {
  if (!existsSync(coreSrc)) throw new Error(`core package not found at ${coreSrc}`);
  if (!existsSync(arenaSrc)) throw new Error(`Arena package not found at ${arenaSrc}`);

  // Rebuild the desktop bundle FIRST. electron-builder only packs whatever is
  // already in out/**; predist itself just materializes core. Without this, a
  // stale out/ (source changed but never rebuilt) is silently packaged — you
  // ship old main/renderer/mobile code. `build` is fast (esbuild + vite prod)
  // and idempotent, so always running it makes `dist`/`pack` reproducible.
  // (core's own dist must already be built — copyDir below asserts it exists.)
  log("building desktop bundle (out/) before packaging");
  execFileSync("bun", ["run", "build"], { cwd: desktopRoot, stdio: "inherit" });

  // Drop whatever is currently at the target (symlink, or a stale real dir from
  // a previous run). On Windows a workspace link is a directory JUNCTION, and
  // `rmSync(force)` without `recursive` throws EFAULT on it — so always pass
  // `recursive: true`. For a junction/symlink, `recursive` removes only the
  // link entry, never following it into the real core dir (verified: rm of a
  // junction does not delete the target's contents).
  removeWorkspaceTarget(coreTarget, "core");
  removeWorkspaceTarget(arenaTarget, "Arena");

  materializePackage(coreSrc, coreTarget);
  materializePackage(arenaSrc, arenaTarget);

  // Each materialized sibling owns its production closure. Arena imports zod
  // directly, so relying on core's nested node_modules would break Node's
  // sibling-package resolution in the packaged app.
  installProductionDeps(coreSrc, coreTarget, "core");
  installProductionDeps(arenaSrc, arenaTarget, "Arena");
  verifyMaterializedArena();

  log(`materialized core + Arena into node_modules (LICENSE/README excluded)`);
}

function verifyMaterializedArena(): void {
  log("verifying packaged Arena can resolve its runtime dependencies");
  execFileSync("bun", ["--eval", "await import('@cjhyy/code-shell-arena')"], {
    cwd: desktopRoot,
    stdio: "inherit",
  });
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

// Install core's FULL production dependency CLOSURE as real files under the
// materialized target. We deliberately do NOT copy from bun's .bun store: that
// store lays each package's transitive deps out as siblings inside the store
// (e.g. @modelcontextprotocol/sdk's `cross-spawn` lives next to it in the
// store, not in core/node_modules' top level). An earlier version walked only
// core/node_modules' top level and dereferenced each package — which shipped
// the SDK but NOT its transitive `cross-spawn`/`express`/`hono`/…, so the
// packaged app crashed at runtime with `Cannot find package 'cross-spawn'`.
//
// Instead, let bun compute the closure: write a minimal package.json carrying
// ONLY core's `dependencies`, then `bun install --production --linker=hoisted`.
// `--production` drops devDependencies; `--linker=hoisted` produces a flat tree
// of REAL directories (no symlinks into an absolute .bun store path that won't
// exist on the user's machine). This is self-maintaining: when a dep bumps and
// pulls in new transitive deps, they are installed automatically — no manual
// store-walking to keep in sync.
function installProductionDeps(source: string, target: string, label: string): void {
  const pkg = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  // Workspace siblings are materialized by this script and resolve through the
  // desktop node_modules ancestor. Bun cannot install `workspace:*` from the
  // isolated minimal manifest, and doing so would duplicate core inside Arena.
  const dependencies = Object.fromEntries(
    Object.entries(pkg.dependencies ?? {}).filter(
      ([, version]) => !version.startsWith("workspace:"),
    ),
  );

  // Minimal manifest: name/version + prod deps only. Omitting workspace fields
  // (workspaces, scripts, devDependencies) keeps bun from re-linking the
  // monorepo or running lifecycle scripts here.
  writeFileSync(
    resolve(target, "package.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        dependencies,
      },
      null,
      2,
    ) + "\n",
  );

  log(`installing ${label} production dependency closure (bun install --production)`);
  execFileSync("bun", ["install", "--production", "--linker=hoisted"], {
    cwd: target,
    stdio: "inherit",
  });

  // Restore core's REAL package.json (with `main`/`exports` entry points) — the
  // minimal manifest above was only a vehicle for the install. Use an explicit
  // readFileSync→writeFileSync, NOT cpSync: `bun install` leaves the target
  // package.json in a state where cpSync(dereference) silently fails to
  // overwrite it, so the minimal manifest (no main/exports) would ship and the
  // app would fail to resolve `@cjhyy/code-shell-core` and its
  // `/bin/agent-server-stdio` subpath. The node_modules/ bun just created stays.
  writeFileSync(
    resolve(target, "package.json"),
    readFileSync(resolve(source, "package.json"), "utf8"),
  );
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
