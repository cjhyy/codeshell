import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  generateProductionClosures,
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

function driftDiagnostic(directory: string) {
  let message = "";
  try {
    loadProductionClosures(directory);
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message).toStartWith("Production lock drift for packages/core;");
  expect(message).toContain("; diagnostics=");
  expect(message.length).toBeLessThan(4096);
  expect(message).not.toContain(directory);
  return { message, details: JSON.parse(message.split("; diagnostics=")[1]) };
}

const keyDigest = (key: string) => createHash("sha256").update(key).digest("hex");

test("drift diagnostics distinguish LF/CRLF text from a changed production closure", () => {
  const directory = fixture();
  const native = generateProductionClosures(directory).get("packages/core")!;
  for (const [field, file] of [
    ["manifest", "core/package.json"],
    ["lock", "core/bun.lock"],
  ] as const) {
    // Invert the observed native EOL rather than assuming Windows Bun writes LF.
    const newline = native[field].includes("\r\n") ? "\n" : "\r\n";
    writeFileSync(join(directory, artifactPath, file), native[field].replace(/\r?\n/g, newline));
  }
  const { details } = driftDiagnostic(directory);
  expect(details.runtime).toEqual({
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
  });
  for (const artifact of [details.manifest, details.lock]) {
    expect(artifact.byteEqual).toBe(false);
    expect(artifact.semanticEqual).toBe(true);
    if (artifact.generated.crlf === 0) {
      expect(artifact.saved.crlf).toBeGreaterThan(0);
      expect(artifact.saved.lf).toBe(0);
    } else {
      expect(artifact.saved.crlf).toBe(0);
      expect(artifact.saved.lf).toBeGreaterThan(0);
    }
    expect(artifact.saved.sha256).not.toBe(artifact.generated.sha256);
    expect(artifact.saved.semanticSha256).toBe(artifact.generated.semanticSha256);
    expect(artifact.firstDifference).toBeUndefined();
  }
});

test("drift diagnostics retain strict rejection of object ordering and whitespace differences", () => {
  const directory = fixture();
  for (const file of ["core/package.json", "core/bun.lock"]) {
    const path = join(directory, artifactPath, file);
    const value = Bun.JSONC.parse(readFileSync(path, "utf8"));
    writeFileSync(
      path,
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).reverse())
          : item,
      ),
    );
  }
  const { details } = driftDiagnostic(directory);
  for (const artifact of [details.manifest, details.lock]) {
    expect(artifact.byteEqual).toBe(false);
    expect(artifact.semanticEqual).toBe(true);
    expect(artifact.saved.semanticSha256).toBe(artifact.generated.semanticSha256);
  }
});

for (const { name, file, change, path } of [
  {
    name: "tuple integrity",
    file: "bun.lock",
    change: (v: any) => {
      v.packages["tldts-core"][3] = "DO_NOT_LOG_INTEGRITY";
    },
    path: ["packages", "tldts-core", "3"],
  },
  {
    name: "tuple array order",
    file: "bun.lock",
    change: (v: any) => {
      v.packages["tldts-core"].reverse();
    },
    path: ["packages", "tldts-core", "0"],
  },
  {
    name: "Windows optional record",
    file: "bun.lock",
    change: (v: any) => {
      delete v.packages["@napi-rs/canvas-win32-x64-msvc"];
    },
    path: ["packages", "@napi-rs/canvas-win32-x64-msvc"],
  },
  {
    name: "unknown lock field",
    file: "bun.lock",
    change: (v: any) => {
      v.extra = { nested: "DO_NOT_LOG_UNKNOWN" };
    },
    path: ["extra"],
  },
  {
    name: "manifest dependency",
    file: "package.json",
    change: (v: any) => {
      v.dependencies.tldts = "DO_NOT_LOG_DEPENDENCY";
    },
    path: ["dependencies", "tldts"],
  },
  {
    name: "manifest override",
    file: "package.json",
    change: (v: any) => {
      v.overrides["proxy-addr"] = "DO_NOT_LOG_OVERRIDE";
    },
    path: ["overrides", "proxy-addr"],
  },
]) {
  test(`drift diagnostics identify semantic ${name} changes without printing values`, () => {
    const directory = fixture();
    changeJson(directory, `${artifactPath}/core/${file}`, change);
    const { message, details } = driftDiagnostic(directory);
    const artifact = file === "bun.lock" ? details.lock : details.manifest;
    expect(artifact.semanticEqual).toBe(false);
    expect(artifact.saved.semanticSha256).not.toBe(artifact.generated.semanticSha256);
    const safePath = JSON.parse(artifact.firstDifference.path);
    const dynamicIndex = path.length === 1 ? 0 : 1;
    if (dynamicIndex === 1) expect(safePath[0]).toBe(path[0]);
    expect(safePath[dynamicIndex]).toMatch(
      new RegExp(`^key#\\d+:sha256=${keyDigest(path[dynamicIndex])}$`),
    );
    if (path.length === 3) expect(safePath[2]).toBe(Number(path[2]));
    if (name === "Windows optional record") {
      const native = parseLock(readFileSync(join(repoRoot, artifactPath, "core/bun.lock"), "utf8"));
      const index = Object.keys(native.packages).sort().indexOf(path[1]);
      expect(safePath[1]).toBe(`key#${index}:sha256=${keyDigest(path[1])}`);
    }
    expect(artifact.firstDifference.truncated).toBe(false);
    expect(message).not.toContain("DO_NOT_LOG_");
  });
}

test("drift diagnostics bound and escape long field paths", () => {
  const directory = fixture();
  const key = "\n\u001b".repeat(2_000);
  changeJson(directory, `${artifactPath}/core/bun.lock`, (value) => {
    value[key] = "DO_NOT_LOG_VALUE";
  });
  const { message, details } = driftDiagnostic(directory);
  expect(details.lock.firstDifference.path.length).toBeLessThanOrEqual(256);
  expect(details.lock.firstDifference.truncated).toBe(false);
  expect(JSON.parse(details.lock.firstDifference.path)[0]).toMatch(
    new RegExp(`^key#\\d+:sha256=${keyDigest(key)}$`),
  );
  expect(details.lock.firstDifference.path).not.toContain("\\n");
  expect(details.lock.firstDifference.path).not.toContain("\\u001b");
  expect(details.lock.firstDifference.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(message).not.toContain("\n");
  expect(message).not.toContain("\u001b");
  expect(message).not.toContain("DO_NOT_LOG_VALUE");
});

for (const location of [
  "unknown",
  "packages",
  "optionalDependencies",
  "overrides",
  "schema-name",
]) {
  test(`drift diagnostics redact dynamic ${location} keys rather than logging credentials`, () => {
    const directory = fixture();
    const credential = "https://user:password@host/private-token\n\u001b[31m";
    const key = location === "schema-name" ? "name" : credential;
    const file = ["unknown", "packages"].includes(location) ? "bun.lock" : "package.json";
    changeJson(directory, `${artifactPath}/core/${file}`, (value) => {
      const dictionary =
        location === "unknown"
          ? value
          : value[location === "schema-name" ? "optionalDependencies" : location];
      dictionary[key] = "DO_NOT_LOG_VALUE";
    });
    const { message, details } = driftDiagnostic(directory);
    const artifact = file === "bun.lock" ? details.lock : details.manifest;
    expect(artifact.semanticEqual).toBe(false);
    const safePath = JSON.parse(artifact.firstDifference.path);
    expect(safePath.at(-1)).toMatch(new RegExp(`^key#\\d+:sha256=${keyDigest(key)}$`));
    for (const forbidden of [
      "user",
      "password",
      "host",
      "private-token",
      "DO_NOT_LOG_VALUE",
      "\n",
      "\u001b",
    ])
      expect(message).not.toContain(forbidden);
    expect(artifact.firstDifference.path).not.toContain("\\n");
    expect(artifact.firstDifference.path).not.toContain("\\u001b");
  });
}

for (const operation of [
  "byte statistics",
  "raw hash",
  "semantic hash",
  "semantic stringify",
  "path stringify",
  "final stringify",
]) {
  test(`drift diagnostics preserve the original rejection when ${operation} throws`, () => {
    const directory = fixture();
    const sentinel = "DO_NOT_LOG_DIAGNOSTIC_VALUE";
    changeJson(directory, `${artifactPath}/core/package.json`, (value) => {
      value.diagnosticFixture = sentinel;
    });
    const saved = readFileSync(join(directory, artifactPath, "core/package.json"), "utf8");
    let hits = 0;
    const fail = () => {
      hits++;
      throw new Error("DO_NOT_LOG_DIAGNOSTIC_FAILURE");
    };
    let hook: { mockRestore(): void };
    if (operation === "byte statistics") {
      const byteLength = Buffer.byteLength;
      hook = spyOn(Buffer, "byteLength").mockImplementation((value, ...args) => {
        if (value === saved) fail();
        return byteLength(value, ...args);
      });
    } else if (operation.endsWith("hash")) {
      const prototype = Object.getPrototypeOf(createHash("sha256"));
      const update = prototype.update;
      hook = spyOn(prototype, "update").mockImplementation(function (
        this: ReturnType<typeof createHash>,
        value,
        ...args
      ) {
        if (
          operation === "raw hash"
            ? value === saved
            : typeof value === "string" && value !== saved && value.includes(sentinel)
        )
          fail();
        return update.call(this, value, ...args);
      });
    } else {
      const stringify = JSON.stringify;
      hook = spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
        if (
          operation === "semantic stringify"
            ? value?.diagnosticFixture === sentinel
            : operation === "path stringify"
              ? Array.isArray(value) && args.length === 0
              : value?.runtime?.bun === Bun.version && value?.manifest && value?.lock
        )
          fail();
        return (stringify as any)(value, ...args);
      });
    }
    let error: unknown;
    try {
      loadProductionClosures(directory);
    } catch (caught) {
      error = caught;
    } finally {
      hook.mockRestore();
    }
    expect(hits).toBeGreaterThan(0);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("Error");
    expect((error as Error).message).toBe(
      'Production lock drift for packages/core; run bun packages/desktop/scripts/production-dependencies.ts --write; diagnostics={"unavailable":true}',
    );
  });
}

test("drift diagnostics report invalid JSON without exposing parser input", () => {
  const directory = fixture();
  for (const file of ["core/package.json", "core/bun.lock"])
    writeFileSync(join(directory, artifactPath, file), "DO_NOT_LOG_INVALID_INPUT");
  const { message, details } = driftDiagnostic(directory);
  for (const artifact of [details.manifest, details.lock]) {
    expect(artifact.semanticEqual).toBeNull();
    expect(artifact.saved.parseError).toBe(true);
    expect(artifact.saved.semanticSha256).toBeUndefined();
  }
  expect(message).not.toContain("DO_NOT_LOG_INVALID_INPUT");
});

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
