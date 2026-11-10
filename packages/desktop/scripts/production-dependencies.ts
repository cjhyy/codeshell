import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DESKTOP_MATERIALIZED_WORKSPACES } from "./materialized-workspaces.js";

interface Manifest {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  packageManager?: string;
}

interface Lockfile {
  lockfileVersion: number;
  configVersion: number;
  workspaces: Record<string, Manifest>;
  overrides?: Record<string, string>;
  packages: Record<string, [string, ...unknown[]]>;
}

export interface ProductionClosure {
  manifest: string;
  lock: string;
}

const workspaces = DESKTOP_MATERIALIZED_WORKSPACES.filter(
  (entry) => entry.installProductionDependencies,
);
const artifactDirectory = "packages/desktop/build/production-dependencies";
const regenerate = "bun packages/desktop/scripts/production-dependencies.ts --write";
const json = (value: unknown): string => JSON.stringify(value, null, 2) + "\n";
const readManifest = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8"));
// Lock tuples include dependency metadata and integrity, not just versions.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

export function createProductionManifest(pkg: Manifest, root: Manifest): Manifest {
  const external = (dependencies: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(dependencies).filter(([, value]) => !value.startsWith("workspace:")),
    );
  return {
    name: pkg.name,
    // This install shell is independent of the application release version.
    // The full workspace manifest (including version) is restored after install.
    dependencies: external(pkg.dependencies),
    optionalDependencies: external(pkg.optionalDependencies),
    overrides: root.overrides ?? {},
  };
}

/** Bun owns closure pruning, peer resolution, rehoisting and platform optional records. */
export function generateProductionClosures(repoRoot: string): Map<string, ProductionClosure> {
  const root = readManifest(join(repoRoot, "package.json"));
  if (root.packageManager !== `bun@${Bun.version}`)
    throw new Error(`Production locks require ${root.packageManager}; running bun@${Bun.version}`);
  const lock = Bun.JSONC.parse(readFileSync(join(repoRoot, "bun.lock"), "utf8")) as Lockfile;
  if (lock.lockfileVersion !== 1 || lock.configVersion !== 1)
    throw new Error("Unsupported root Bun lock format");
  if (canonical(root.overrides ?? {}) !== canonical(lock.overrides ?? {}))
    throw new Error("Root overrides drifted from bun.lock; update the root lock first");
  const records = new Set(Object.values(lock.packages).map(canonical));
  const closures = new Map<string, ProductionClosure>();
  for (const { relativeDir } of workspaces) {
    const pkg = readManifest(join(repoRoot, relativeDir, "package.json"));
    const locked = lock.workspaces[relativeDir];
    for (const field of ["name", "version", "dependencies", "optionalDependencies"] as const) {
      if (canonical(pkg[field] ?? {}) !== canonical(locked?.[field] ?? {}))
        throw new Error(`${relativeDir} ${field} drifted from root bun.lock`);
    }
    const manifest = createProductionManifest(pkg, root);
    const directory = mkdtempSync(join(tmpdir(), "codeshell-production-lock-"));
    try {
      writeFileSync(join(directory, "package.json"), json(manifest));
      // Retain the complete root resolution table as Bun's seed, excluding only
      // workspace links that are materialized separately. Do not resolve ranges
      // afresh or implement a second package-manager graph walker here.
      writeFileSync(
        join(directory, "bun.lock"),
        json({
          ...lock,
          workspaces: {
            "": {
              name: manifest.name,
              dependencies: manifest.dependencies,
              optionalDependencies: manifest.optionalDependencies,
            },
          },
          packages: Object.fromEntries(
            Object.entries(lock.packages).filter(([, entry]) => !entry[0].includes("@workspace:")),
          ),
        }),
      );
      const options = {
        cwd: directory,
        env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(directory, "cache") },
        timeout: 30_000,
        stdio: "pipe" as const,
      };
      execFileSync(
        process.execPath,
        ["install", "--lockfile-only", "--ignore-scripts", "--linker=hoisted"],
        options,
      );
      const generated = readFileSync(join(directory, "bun.lock"), "utf8");
      const parsed = Bun.JSONC.parse(generated) as Lockfile;
      for (const [name, entry] of Object.entries(parsed.packages)) {
        if (!records.has(canonical(entry)))
          throw new Error(`${relativeDir}: ${name} resolved outside root bun.lock`);
      }
      execFileSync(
        process.execPath,
        [
          "install",
          "--production",
          "--frozen-lockfile",
          "--dry-run",
          "--ignore-scripts",
          "--linker=hoisted",
        ],
        options,
      );
      closures.set(relativeDir, { manifest: json(manifest), lock: generated });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
  return closures;
}

/** Missing artifacts fail before generation, builds, or node_modules mutations. */
export function loadProductionClosures(repoRoot: string): Map<string, ProductionClosure> {
  const saved = new Map<string, ProductionClosure>();
  for (const { relativeDir } of workspaces) {
    const directory = join(repoRoot, artifactDirectory, basename(relativeDir));
    for (const file of ["package.json", "bun.lock"]) {
      if (!existsSync(join(directory, file)))
        throw new Error(`Missing production lock artifact ${directory}/${file}; run ${regenerate}`);
    }
    saved.set(relativeDir, {
      manifest: readFileSync(join(directory, "package.json"), "utf8"),
      lock: readFileSync(join(directory, "bun.lock"), "utf8"),
    });
  }
  // Full native regeneration also catches missing transitive/optional entries
  // and wrong rehoisted versions that a tuple-membership check alone would miss.
  for (const [relativeDir, expected] of generateProductionClosures(repoRoot)) {
    const actual = saved.get(relativeDir)!;
    if (actual.manifest !== expected.manifest || actual.lock !== expected.lock)
      throw new Error(`Production lock drift for ${relativeDir}; run ${regenerate}`);
  }
  return saved;
}

export function writeProductionClosures(repoRoot: string): void {
  // Generate both successfully before replacing either saved closure.
  for (const [relativeDir, closure] of generateProductionClosures(repoRoot)) {
    const directory = join(repoRoot, artifactDirectory, basename(relativeDir));
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "package.json"), closure.manifest);
    writeFileSync(join(directory, "bun.lock"), closure.lock);
  }
}

export function installProductionClosure(
  source: string,
  target: string,
  closure: ProductionClosure,
  run: (
    command: string,
    args: string[],
    options: { cwd: string; stdio: "inherit" },
  ) => unknown = execFileSync,
): void {
  const original = readFileSync(join(source, "package.json"), "utf8");
  try {
    writeFileSync(join(target, "package.json"), closure.manifest);
    writeFileSync(join(target, "bun.lock"), closure.lock);
    run(process.execPath, ["install", "--production", "--frozen-lockfile", "--linker=hoisted"], {
      cwd: target,
      stdio: "inherit",
    });
  } finally {
    // Keep runtime exports even on failure, and never ship a minimal-manifest
    // lock next to the restored workspace manifest.
    writeFileSync(join(target, "package.json"), original);
    rmSync(join(target, "bun.lock"), { force: true });
  }
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const [command, ...extra] = process.argv.slice(2);
  if (extra.length || !["--write", "--check"].includes(command ?? ""))
    throw new Error(`Usage: bun ${import.meta.path} --write|--check`);
  if (command === "--write") writeProductionClosures(repoRoot);
  else loadProductionClosures(repoRoot);
  console.log(`Desktop production locks ${command === "--write" ? "generated" : "verified"}`);
}
