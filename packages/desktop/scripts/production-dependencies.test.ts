import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  createProductionManifest,
  installProductionClosure,
  loadProductionClosures,
} from "./production-dependencies.js";
import {
  RELEASE_PACKAGES,
  packageManifestPath,
} from "../../../scripts/package-release-audit-config.js";
import { verifyReleaseVersions } from "../../../scripts/verify-release-versions.js";

const repoRoot = resolve(import.meta.dir, "../../..");
const artifactPath = "packages/desktop/build/production-dependencies";
const temporary: string[] = [];
const parseLock = (text: string) => Bun.JSONC.parse(text) as { packages: Record<string, any> };
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-production-test-"));
  temporary.push(directory);
  for (const file of [
    "package.json",
    "bun.lock",
    "packages/core/package.json",
    "packages/optimization-lab/package.json",
  ]) {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    cpSync(join(repoRoot, file), join(directory, file));
  }
  cpSync(join(repoRoot, artifactPath), join(directory, artifactPath), { recursive: true });
  return directory;
}

function changeJson(directory: string, file: string, change: (value: any) => void): void {
  const path = join(directory, file);
  const value = Bun.JSONC.parse(readFileSync(path, "utf8"));
  change(value);
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function releaseFixture() {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-production-release-"));
  temporary.push(directory);
  const write = (file: string, content: string) => {
    mkdirSync(dirname(join(directory, file)), { recursive: true });
    writeFileSync(join(directory, file), content);
  };
  // Copy the exact release inputs. Only the root Bun metadata refresh is
  // simulated below; the release script, version checks and git add are real.
  for (const definition of RELEASE_PACKAGES) {
    const file = packageManifestPath(definition);
    write(file, readFileSync(join(repoRoot, file), "utf8"));
  }
  write("bun.lock", readFileSync(join(repoRoot, "bun.lock"), "utf8"));
  cpSync(join(repoRoot, artifactPath), join(directory, artifactPath), { recursive: true });
  const currentVersion: string = JSON.parse(
    readFileSync(join(directory, "package.json"), "utf8"),
  ).version;
  const [, major, minor, patch] = currentVersion.match(/^(\d+)\.(\d+)\.(\d+)/)!;
  const targetVersion = `${major}.${minor}.${Number(patch) + 1}`;
  write("packages/core/src/index.ts", `export const VERSION = "${currentVersion}";\n`);
  write(
    "CHANGELOG.md",
    `## [${targetVersion}]\n\nFixture next release.\n\n## [${currentVersion}]\n\nFixture baseline.\n`,
  );
  write("bunfig.toml", '[install]\nregistry = "http://127.0.0.1:9"\n');
  for (const file of [
    "release.ts",
    "package-release-audit-config.ts",
    "release-push-guard.ts",
    "verify-release-versions.ts",
  ])
    write(`scripts/${file}`, readFileSync(join(repoRoot, "scripts", file), "utf8"));
  const bin = join(directory, "fixture-bin");
  write(
    "fixture-bin/bun",
    `#!${process.execPath}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (JSON.stringify(args) !== JSON.stringify(["install", "--lockfile-only", "--ignore-scripts"]))
  throw new Error("Unexpected Bun invocation: " + JSON.stringify(args));
const root = process.cwd();
const lock = Bun.JSONC.parse(readFileSync(join(root, "bun.lock"), "utf8"));
for (const [path, entry] of Object.entries(lock.workspaces)) {
  if (path) entry.version = JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")).version;
}
writeFileSync(join(root, "bun.lock"), JSON.stringify(lock, null, 2) + "\\n");
const receipt = join(root, ".git", "fixture-bun-calls.json");
const calls = existsSync(receipt) ? JSON.parse(readFileSync(receipt, "utf8")) : [];
writeFileSync(receipt, JSON.stringify([...calls, args]));
`,
  );
  chmodSync(join(bin, "bun"), 0o755);
  write("fixture-bin/bun.cmd", `@"${process.execPath}" "%~dp0bun" %*\r\n`);
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(directory, "absent-git-config"),
    GIT_OPTIONAL_LOCKS: "0",
    BUN_INSTALL_CACHE_DIR: join(directory, ".bun-cache"),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
  };
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, env, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "Release fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("add", ".");
  // Only this disposable fixture gets an initial checkpoint. The release
  // commit is rejected below, and this repository has no remote.
  git("commit", "-q", "-m", "fixture baseline");
  const hook = ".git/hooks/pre-commit";
  write(hook, '#!/bin/sh\necho "FIXTURE: release commit blocked after staging" >&2\nexit 1\n');
  chmodSync(join(directory, hook), 0o755);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, ["scripts/release.ts", "--bump", "patch", ...args], {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
  return { directory, git, run, targetVersion };
}

function snapshot(directory: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (relative: string) => {
    for (const entry of readdirSync(join(directory, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) visit(path);
      else files[path] = readFileSync(join(directory, path)).toString("base64");
    }
  };
  visit("");
  return files;
}

test("standard release dry-run leaves every fixture file, index and ref unchanged", () => {
  const f = releaseFixture();
  const before = snapshot(f.directory);
  const result = f.run("--dry-run");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("dry run: would update");
  expect(result.stdout + result.stderr).not.toContain("bun install");
  expect(snapshot(f.directory)).toEqual(before);
});

test("standard patch bump keeps production artifacts valid and stages every changed release input", () => {
  const f = releaseFixture();
  const head = f.git("rev-parse", "HEAD");
  const artifacts = snapshot(join(f.directory, artifactPath));
  const result = f.run();
  // Exercise the real release script through git add, then stop before commit.
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain("FIXTURE: release commit blocked after staging");
  expect(
    JSON.parse(readFileSync(join(f.directory, ".git/fixture-bun-calls.json"), "utf8")),
  ).toEqual([["install", "--lockfile-only", "--ignore-scripts"]]);
  expect(f.git("rev-parse", "HEAD")).toBe(head);
  verifyReleaseVersions(f.targetVersion, f.directory);
  expect(parseLock(readFileSync(join(f.directory, "bun.lock"), "utf8")).packages).toEqual(
    parseLock(readFileSync(join(repoRoot, "bun.lock"), "utf8")).packages,
  );
  expect(f.git("diff", "--cached", "--name-only").trim().split("\n").sort()).toEqual(
    [...RELEASE_PACKAGES.map(packageManifestPath), "bun.lock", "packages/core/src/index.ts"].sort(),
  );
  expect(f.git("diff", "--name-only")).toBe("");
  expect(snapshot(join(f.directory, artifactPath))).toEqual(artifacts);
  const closures = loadProductionClosures(f.directory);
  expect(closures.size).toBe(2);
  // Release versions remain in the restored runtime manifest, not the install shell.
  const target = join(f.directory, "installed-core");
  mkdirSync(target);
  installProductionClosure(
    join(f.directory, "packages/core"),
    target,
    closures.get("packages/core")!,
    () => {},
  );
  expect(JSON.parse(readFileSync(join(target, "package.json"), "utf8")).version).toBe(
    f.targetVersion,
  );

  // The same predist gate still rejects missing/drifted artifacts after a bump.
  const labLock = join(f.directory, artifactPath, "optimization-lab/bun.lock");
  const saved = readFileSync(labLock);
  rmSync(labLock);
  expect(() => loadProductionClosures(f.directory)).toThrow("Missing production lock artifact");
  writeFileSync(labLock, saved);
  changeJson(f.directory, `${artifactPath}/core/package.json`, (pkg) => {
    pkg.dependencies.extra = "1.0.0";
  });
  expect(() => loadProductionClosures(f.directory)).toThrow("Production lock drift");
});

test("an unsynchronized workspace version still fails against the root lock", () => {
  const directory = fixture();
  changeJson(directory, "packages/core/package.json", (pkg) => {
    pkg.version += "-unsynchronized";
  });
  expect(() => loadProductionClosures(directory)).toThrow("version drifted from root bun.lock");
});

test("isolated production manifests retain root overrides, including transitive overrides", () => {
  const manifest = createProductionManifest(
    { name: "core", dependencies: { sdk: "^1" } },
    { name: "root", overrides: { "proxy-addr": "2.0.8" } },
  );
  expect(manifest.overrides).toEqual({ "proxy-addr": "2.0.8" });
});

test("optional workspace siblings are excluded while external optional dependencies survive", () => {
  const manifest = createProductionManifest(
    {
      name: "core",
      dependencies: { link: "workspace:*", sdk: "^1" },
      optionalDependencies: { capability: "workspace:*", "pdfjs-dist": "6.4.299" },
    },
    { name: "root" },
  );
  expect(manifest.dependencies).toEqual({ sdk: "^1" });
  expect(manifest.optionalDependencies).toEqual({ "pdfjs-dist": "6.4.299" });
});

test("predist validates committed production locks before building or replacing workspace targets", () => {
  const source = readFileSync(new URL("./predist.ts", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("function main()"));
  const validation = main.indexOf("loadProductionClosures(repoRoot)");
  expect(validation).toBeGreaterThanOrEqual(0);
  expect(validation).toBeLessThan(main.indexOf("buildDesktopWorkspaceDependencies();"));
  expect(validation).toBeLessThan(main.indexOf("removeWorkspaceTarget(target, label);"));
  expect(source).not.toContain('["install", "--production", "--linker=hoisted"]');
});

test("committed locks reproduce root resolutions, including rehoisted and every platform optional package", () => {
  const closures = loadProductionClosures(repoRoot);
  const core = parseLock(closures.get("packages/core")!.lock);
  const lab = parseLock(closures.get("packages/optimization-lab")!.lock);
  const root = parseLock(readFileSync(join(repoRoot, "bun.lock"), "utf8"));
  for (const name of ["tldts", "tldts-core", "proxy-addr", "pdfjs-dist", "@napi-rs/canvas"]) {
    expect(core.packages[name]).toEqual(root.packages[name]);
  }
  expect(core.packages.tldts[0]).toBe("tldts@7.4.19");
  expect(core.packages["tldts-core"][0]).toBe("tldts-core@7.4.19");
  // Removing workspace dev dependencies legitimately rehoists the SDK's Node 18 types.
  expect(core.packages["@types/node"][0]).toStartWith("@types/node@18.");
  const optional = Object.keys(root.packages).filter((name) => name.startsWith("@napi-rs/canvas-"));
  expect(optional.length).toBeGreaterThan(5);
  for (const name of optional) expect(core.packages[name]).toEqual(root.packages[name]);
  expect(lab.packages.zod).toEqual(root.packages.zod);
  expect(Object.keys(lab.packages)).toEqual(["zod"]);
});

for (const file of ["core/bun.lock", "core/package.json", "optimization-lab/bun.lock"]) {
  test(`missing ${file} fails before invoking generation`, () => {
    const directory = fixture();
    rmSync(join(directory, artifactPath, file));
    // If generation ran first it would instead fail to parse this root lock.
    writeFileSync(join(directory, "bun.lock"), "invalid root lock");
    expect(() => loadProductionClosures(directory)).toThrow("Missing production lock artifact");
  });
}

for (const field of ["dependencies", "optionalDependencies"]) {
  test(`source ${field} drift fails against the root lock`, () => {
    const directory = fixture();
    changeJson(directory, "packages/core/package.json", (pkg) => {
      pkg[field].added = "1.0.0";
    });
    expect(() => loadProductionClosures(directory)).toThrow(`${field} drifted from root bun.lock`);
  });
}

test("root override drift is refused before resolution", () => {
  const directory = fixture();
  changeJson(directory, "package.json", (pkg) => {
    pkg.overrides["proxy-addr"] = "2.0.7";
  });
  expect(() => loadProductionClosures(directory)).toThrow("Root overrides drifted");
});

test("the generator requires the repository's pinned Bun version", () => {
  const directory = fixture();
  changeJson(directory, "package.json", (pkg) => {
    pkg.packageManager = "bun@0.0.0";
  });
  expect(() => loadProductionClosures(directory)).toThrow("Production locks require bun@0.0.0");
});

test("root transitive integrity changes invalidate the saved production lock", () => {
  const directory = fixture();
  changeJson(directory, "bun.lock", (lock) => {
    lock.packages["tldts-core"][3] = lock.packages.tldts[3];
  });
  expect(() => loadProductionClosures(directory)).toThrow("Production lock drift");
});

for (const name of ["tldts-core", "@napi-rs/canvas-linux-x64-gnu"]) {
  test(`a saved lock missing transitive ${name} fails closed`, () => {
    const directory = fixture();
    changeJson(directory, `${artifactPath}/core/bun.lock`, (lock) => {
      delete lock.packages[name];
    });
    expect(() => loadProductionClosures(directory)).toThrow("Production lock drift");
  });
}

test("a tuple from the root lock in the wrong rehoisted position is rejected", () => {
  const directory = fixture();
  const root = parseLock(readFileSync(join(directory, "bun.lock"), "utf8"));
  changeJson(directory, `${artifactPath}/core/bun.lock`, (lock) => {
    lock.packages["@types/node"] = root.packages["@types/node"];
  });
  expect(() => loadProductionClosures(directory)).toThrow("Production lock drift");
});

for (const fail of [false, true]) {
  test(`frozen installation supplies the matching lock and restores runtime exports on ${fail ? "failure" : "success"}`, () => {
    const directory = fixture();
    const source = join(directory, "packages/core");
    const target = join(directory, "materialized-core");
    mkdirSync(target);
    const original = readFileSync(join(source, "package.json"), "utf8");
    const closure = {
      manifest: readFileSync(join(directory, artifactPath, "core/package.json"), "utf8"),
      lock: readFileSync(join(directory, artifactPath, "core/bun.lock"), "utf8"),
    };
    let called = false;
    const install = () =>
      installProductionClosure(source, target, closure, (command, args, options) => {
        called = true;
        expect(command).toBe(process.execPath);
        expect(args).toEqual(["install", "--production", "--frozen-lockfile", "--linker=hoisted"]);
        expect(options.cwd).toBe(target);
        expect(readFileSync(join(target, "package.json"), "utf8")).toBe(closure.manifest);
        expect(readFileSync(join(target, "bun.lock"), "utf8")).toBe(closure.lock);
        mkdirSync(join(target, "node_modules"));
        if (fail) throw new Error("fixture install failure");
      });
    if (fail) expect(install).toThrow("fixture install failure");
    else install();
    expect(called).toBe(true);
    expect(readFileSync(join(target, "package.json"), "utf8")).toBe(original);
    expect(existsSync(join(target, "bun.lock"))).toBe(false);
    expect(existsSync(join(target, "node_modules"))).toBe(true);
  });
}
