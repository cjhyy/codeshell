#!/usr/bin/env bun

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RELEASE_PACKAGES,
  packageManifestPath,
  type PublishManifest,
} from "./package-release-audit-config";

const DEFAULT_REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const CORE_VERSION_FILE = "packages/core/src/index.ts";
const CORE_VERSION_RE =
  /^\s*export\s+const\s+VERSION(?:\s*:\s*[^\n=]+)?\s*=\s*["']([^"']+)["'](?:\s+as\s+const)?\s*;?/m;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function discoverWorkspaceManifestPaths(repoRoot: string): string[] {
  return [
    "package.json",
    ...readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `packages/${entry.name}/package.json`)
      .filter((path) => existsSync(join(repoRoot, path))),
  ].sort();
}

export function collectReleaseVersionErrors(
  expectedVersion: string,
  repoRoot = DEFAULT_REPO_ROOT,
): string[] {
  const errors: string[] = [];
  const fail = (message: string): void => {
    errors.push(message);
  };
  const declaredManifestPaths = RELEASE_PACKAGES.map(packageManifestPath).sort();
  const discoveredManifestPaths = discoverWorkspaceManifestPaths(repoRoot);

  for (const path of discoveredManifestPaths) {
    if (!declaredManifestPaths.includes(path)) {
      fail(`release package declaration is missing workspace manifest ${path}`);
    }
  }
  for (const path of declaredManifestPaths) {
    if (!discoveredManifestPaths.includes(path)) {
      fail(`release package declaration points to missing workspace manifest ${path}`);
    }
  }

  for (const definition of RELEASE_PACKAGES) {
    const manifestPath = packageManifestPath(definition);
    const absolutePath = join(repoRoot, manifestPath);
    if (!existsSync(absolutePath)) continue;
    const manifest = readJson<PublishManifest>(absolutePath);
    if (manifest.name !== definition.name) {
      fail(`${manifestPath} name is ${manifest.name}, expected ${definition.name}`);
    }
    if (manifest.version !== expectedVersion) {
      fail(`${manifestPath} version is ${manifest.version}, expected ${expectedVersion}`);
    }
    if (definition.publish) {
      if (manifest.private === true) {
        fail(`${manifestPath} is public in the release declaration but private in its manifest`);
      }
      if (manifest.publishConfig?.access !== "public") {
        fail(`${manifestPath} must set publishConfig.access to public`);
      }
    } else if (manifest.private !== true) {
      fail(`${manifestPath} is version-only in the release declaration but is not private`);
    }
  }

  const coreSource = readFileSync(join(repoRoot, CORE_VERSION_FILE), "utf8");
  const coreVersion = coreSource.match(CORE_VERSION_RE)?.[1];
  if (!coreVersion) {
    fail(`${CORE_VERSION_FILE} does not export a VERSION constant`);
  } else if (coreVersion !== expectedVersion) {
    fail(`${CORE_VERSION_FILE} VERSION is ${coreVersion}, expected ${expectedVersion}`);
  }

  const lockPath = join(repoRoot, "bun.lock");
  const lock = readFileSync(lockPath, "utf8");
  const workspaceMatch = lock.match(
    /^  "workspaces": \{[\s\S]*?^  \},\n  "(?:overrides|packages)":/m,
  );
  if (!workspaceMatch) {
    fail("bun.lock workspaces block not found");
    return errors;
  }
  const workspaceBlock = workspaceMatch[0];

  for (const definition of RELEASE_PACKAGES) {
    const workspacePath = definition.directory === "." ? "" : definition.directory;
    const entryMatch = workspaceBlock.match(
      new RegExp(
        `^    "${escapeRegex(workspacePath)}": \\{([\\s\\S]*?)(?=^    "[^"]+": \\{|^  \\},)`,
        "m",
      ),
    );
    if (!entryMatch) {
      fail(`bun.lock is missing workspace entry ${workspacePath || "<root>"}`);
      continue;
    }
    const entry = entryMatch[1];
    const name = entry.match(/^\s{6}"name": "([^"]+)"/m)?.[1];
    if (name !== definition.name) {
      fail(
        `bun.lock workspace ${workspacePath || "<root>"} name is ${name ?? "<missing>"}, expected ${definition.name}`,
      );
    }
    if (workspacePath === "") continue;
    const lockVersion = entry.match(/^\s{6}"version": "([^"]+)"/m)?.[1];
    if (lockVersion !== expectedVersion) {
      fail(
        `bun.lock workspace ${workspacePath} version is ${lockVersion ?? "<missing>"}, expected ${expectedVersion}`,
      );
    }
  }

  const staleWorkspaceVersions = [
    ...new Set(
      [...workspaceBlock.matchAll(/^\s{6}"version": "([^"]+)"/gm)]
        .map((match) => match[1])
        .filter((version) => version !== expectedVersion),
    ),
  ];
  if (staleWorkspaceVersions.length > 0) {
    fail(
      `bun.lock contains workspace versions that do not match ${expectedVersion}: ${staleWorkspaceVersions.join(", ")}`,
    );
  }

  const staleOwnPackageSpecs = [
    ...new Set(
      [
        ...lock.matchAll(
          /@cjhyy\/code-shell(?:-[A-Za-z0-9-]+)?@([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)/g,
        ),
      ]
        .filter((match) => match[1] !== expectedVersion)
        .map((match) => match[0]),
    ),
  ];
  if (staleOwnPackageSpecs.length > 0) {
    fail(`bun.lock contains stale CodeShell package specs: ${staleOwnPackageSpecs.join(", ")}`);
  }

  return errors;
}

export function verifyReleaseVersions(expectedVersion: string, repoRoot = DEFAULT_REPO_ROOT): void {
  const errors = collectReleaseVersionErrors(expectedVersion, repoRoot);
  if (errors.length > 0) {
    throw new Error(
      `release version verification failed:\n${errors.map((error) => `- ${error}`).join("\n")}`,
    );
  }
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  if (args.length !== 1 || !args[0]) {
    throw new Error("usage: bun run scripts/verify-release-versions.ts <version>");
  }
  verifyReleaseVersions(args[0]);
  console.log(
    `✓ ${RELEASE_PACKAGES.length} package manifests, bun.lock, and core VERSION agree on ${args[0]}`,
  );
}

const invokedAsMain =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedAsMain) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
