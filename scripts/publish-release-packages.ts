#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  PUBLIC_RELEASE_PACKAGES,
  packageManifestPath,
  validatePublicReleaseOrder,
  type PublishManifest,
} from "./package-release-audit-config";
import { verifyReleaseVersions } from "./verify-release-versions";

type PublishMode = "dry-run" | "execute" | "list";

interface PublishOptions {
  mode: PublishMode;
  tag: string;
}

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readManifest(path: string): PublishManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PublishManifest;
}

export function parsePublishArgs(args: readonly string[]): PublishOptions {
  let mode: PublishMode = "dry-run";
  let tag = "latest";

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--execute") {
      if (mode === "list") throw new Error("--execute cannot be combined with --list");
      mode = "execute";
      continue;
    }
    if (argument === "--dry-run") {
      if (mode === "execute") throw new Error("--dry-run cannot be combined with --execute");
      mode = "dry-run";
      continue;
    }
    if (argument === "--list") {
      if (mode === "execute") throw new Error("--list cannot be combined with --execute");
      mode = "list";
      continue;
    }
    if (argument === "--tag") {
      const value = args[index + 1];
      if (!value) throw new Error("--tag requires a value");
      tag = value;
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${argument}; usage: bun run scripts/publish-release-packages.ts [--tag <tag>] [--list | --dry-run | --execute]`,
    );
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error(`invalid npm dist-tag ${JSON.stringify(tag)}`);
  }
  return { mode, tag };
}

function loadPublicManifests(): Map<string, PublishManifest> {
  return new Map(
    PUBLIC_RELEASE_PACKAGES.map((definition) => [
      definition.name,
      readManifest(join(REPO_ROOT, packageManifestPath(definition))),
    ]),
  );
}

export function publishCommands(tag: string): string[][] {
  return PUBLIC_RELEASE_PACKAGES.map((definition) => [
    "bun",
    "publish",
    "--cwd",
    definition.directory,
    "--tag",
    tag,
  ]);
}

export function main(args: readonly string[] = process.argv.slice(2)): void {
  const options = parsePublishArgs(args);
  const manifests = loadPublicManifests();
  const orderErrors = validatePublicReleaseOrder(manifests);
  if (orderErrors.length > 0) {
    throw new Error(
      `public publish order is invalid:\n${orderErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  const rootVersion = readManifest(join(REPO_ROOT, "package.json")).version;
  verifyReleaseVersions(rootVersion);
  const commands = publishCommands(options.tag);

  if (options.mode === "list") {
    for (const definition of PUBLIC_RELEASE_PACKAGES) {
      console.log(`${definition.name}  ${definition.directory}`);
    }
    return;
  }

  for (const [index, command] of commands.entries()) {
    const definition = PUBLIC_RELEASE_PACKAGES[index];
    console.log(`${options.mode === "execute" ? "→" : "would run:"} ${command.join(" ")}`);
    if (options.mode !== "execute") continue;
    const result = spawnSync(command[0], command.slice(1), {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error) {
      throw new Error(`could not publish ${definition.name}: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`publish failed for ${definition.name} with exit ${result.status}`);
    }
  }

  if (options.mode === "dry-run") {
    console.log(
      `Dry run passed: ${commands.length} public packages are version-aligned and topologically ordered.`,
    );
  }
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
