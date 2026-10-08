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
  repoRoot: string;
}

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NPM_REGISTRY = "https://registry.npmjs.org/";
const MAX_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];
// Public metadata took 4–6 minutes to appear during v0.9.27. Give the entire
// accepted batch ten minutes, concurrently, rather than ten minutes per package.
const CONFIRMATION_BUDGET_MS = 10 * 60 * 1_000;
const CONFIRMATION_POLL_MS = 10_000;
const REGISTRY_REQUEST_TIMEOUT_MS = 15_000;

export interface PublishAttempt {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: { code?: string; message?: string };
}

export interface PublishRuntime {
  lookupVersion(name: string, version: string, timeoutMs?: number): Promise<boolean>;
  verifyTag(name: string, version: string, tag: string, timeoutMs?: number): Promise<void>;
  publish(command: readonly string[]): PublishAttempt;
  sleep(ms: number): Promise<void>;
  now(): number;
  log(message: string): void;
}

type RegistryRequest = (input: URL, init: RequestInit) => Promise<Response>;

class RegistryLookupError extends Error {
  constructor(
    readonly transient: boolean,
    readonly status?: number,
  ) {
    super(status ? `registry lookup returned HTTP ${status}` : "registry lookup failed");
  }
}

class RegistryTagError extends Error {}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** A public, exact-version read. A missing version is never inferred from an outage. */
export async function registryVersionExists(
  name: string,
  version: string,
  request: RegistryRequest = fetch,
  timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS,
): Promise<boolean> {
  const url = new URL(`${encodeURIComponent(name)}/${encodeURIComponent(version)}`, NPM_REGISTRY);
  // A release may have appeared after an earlier cached 404, including after
  // the registry accepted a publish whose HTTP response never reached us.
  url.searchParams.set("release-check", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let response: Response;
  try {
    response = await request(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RegistryLookupError(true);
  }
  if (response.status === 404) return false;
  if (!response.ok)
    throw new RegistryLookupError(transientStatus(response.status), response.status);
  let manifest: unknown;
  try {
    manifest = await response.json();
  } catch {
    throw new RegistryLookupError(true);
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    (manifest as Record<string, unknown>).name !== name ||
    (manifest as Record<string, unknown>).version !== version
  ) {
    throw new RegistryLookupError(false);
  }
  return true;
}

export async function verifyRegistryTag(
  name: string,
  version: string,
  tag: string,
  request: RegistryRequest = fetch,
  timeoutMs = REGISTRY_REQUEST_TIMEOUT_MS,
): Promise<void> {
  const url = new URL(`-/package/${encodeURIComponent(name)}/dist-tags`, NPM_REGISTRY);
  url.searchParams.set("release-check", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let response: Response;
  try {
    response = await request(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new RegistryLookupError(true);
  }
  if (!response.ok)
    throw new RegistryLookupError(transientStatus(response.status), response.status);
  let tags: unknown;
  try {
    tags = await response.json();
  } catch {
    throw new RegistryLookupError(true);
  }
  if (!tags || typeof tags !== "object" || (tags as Record<string, unknown>)[tag] !== version) {
    throw new RegistryTagError(
      `npm dist-tag ${tag} does not reference ${name}@${version}; inspect the current tag and repair it explicitly if appropriate, without downgrading a newer release`,
    );
  }
}

function publishFailure(result: PublishAttempt): { transient: boolean; summary: string } {
  // Child output may contain credentials or signed URLs. Inspect it locally,
  // but only return fixed error categories and numeric status to the logs.
  const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}\n${result.error?.code ?? ""}\n${result.error?.message ?? ""}`;
  const http = diagnostic.match(
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s*|status\s*[:=]?\s*|E)([45]\d\d)\b|(?:^|\n)\s*(?:error:\s*)?([45]\d\d)\b/i,
  );
  const status = http ? Number(http[1] ?? http[2]) : undefined;
  const network =
    /\b(?:EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH)\b|fetch failed|socket closed|connection reset|timed out|network error/i.test(
      diagnostic,
    );
  const duplicate =
    /cannot (?:publish over|modify pre-existing)|previously published version/i.test(diagnostic);
  return {
    transient: (status !== undefined && transientStatus(status)) || network || duplicate,
    summary:
      status !== undefined ? `HTTP ${status}` : `publisher exit ${result.status ?? "unavailable"}`,
  };
}

function defaultRuntime(repoRoot: string): PublishRuntime {
  return {
    lookupVersion: (name, version, timeoutMs) =>
      registryVersionExists(name, version, fetch, timeoutMs),
    verifyTag: (name, version, tag, timeoutMs) =>
      verifyRegistryTag(name, version, tag, fetch, timeoutMs),
    publish: (command) => {
      const result = spawnSync(command[0], command.slice(1), {
        cwd: repoRoot,
        env: process.env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 8 * 1024 * 1024,
        timeout: 5 * 60 * 1_000,
      });
      return {
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.error,
      };
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => performance.now(),
    log: (message) => console.log(message),
  };
}

async function submitReleasePackage(
  name: string,
  version: string,
  tag: string,
  command: readonly string[],
  runtime: PublishRuntime,
): Promise<"accepted" | "existing"> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let failure: { transient: boolean; summary: string };
    try {
      if (await runtime.lookupVersion(name, version)) {
        await runtime.verifyTag(name, version, tag);
        runtime.log(`✓ ${name}@${version} already exists; keeping its immutable release`);
        return "existing";
      }
      const result = runtime.publish(command);
      if (!result.error && result.status === 0) {
        runtime.log(`Publisher accepted ${name}@${version}; public registry confirmation pending`);
        return "accepted";
      }
      failure = publishFailure(result);
      // Even permanent "version already exists" responses can be an accepted
      // earlier request or another job completing the same release.
      let foundAfterFailure = false;
      try {
        foundAfterFailure = await runtime.lookupVersion(name, version);
      } catch {
        // Preserve the publisher's failure. Never claim success without a
        // confirmed exact-version read; the next attempt rechecks first.
      }
      if (foundAfterFailure) {
        await runtime.verifyTag(name, version, tag);
        runtime.log(`✓ ${name}@${version} is present after the interrupted publish`);
        return "existing";
      }
    } catch (error) {
      failure = {
        transient: error instanceof RegistryLookupError && error.transient,
        summary:
          error instanceof RegistryLookupError || error instanceof RegistryTagError
            ? error.message
            : "publisher could not run",
      };
    }
    if (!failure.transient || attempt === MAX_ATTEMPTS) {
      throw new Error(
        `publish failed for ${name}@${version}: ${failure.summary} (attempt ${attempt}/${MAX_ATTEMPTS})`,
      );
    }
    const delay = RETRY_DELAYS_MS[attempt - 1];
    runtime.log(
      `Retrying ${name}@${version} after ${failure.summary} in ${delay / 1_000}s (${attempt}/${MAX_ATTEMPTS})`,
    );
    await runtime.sleep(delay);
  }
  throw new Error(`publish attempts exhausted for ${name}@${version}`);
}

interface AcceptedPackage {
  name: string;
  version: string;
}

/** Read-only acceptance: never retry a successful publish or change a dist-tag. */
async function confirmAcceptedPackages(
  packages: readonly AcceptedPackage[],
  tag: string,
  runtime: PublishRuntime,
): Promise<void> {
  if (packages.length === 0) return;
  const deadline = runtime.now() + CONFIRMATION_BUDGET_MS;
  const pending = new Map(packages.map((entry) => [entry.name, entry]));
  const reasons = new Map<string, string>();
  const requestTimeout = () =>
    Math.max(1, Math.ceil(Math.min(REGISTRY_REQUEST_TIMEOUT_MS, deadline - runtime.now())));
  while (runtime.now() < deadline) {
    const failures = await Promise.all(
      [...pending.values()].map(async ({ name, version }) => {
        try {
          if (!(await runtime.lookupVersion(name, version, requestTimeout()))) {
            reasons.set(name, "exact version is not visible");
            return;
          }
          if (runtime.now() >= deadline) return;
          await runtime.verifyTag(name, version, tag, requestTimeout());
          if (runtime.now() < deadline) pending.delete(name);
        } catch (error) {
          // A stale/missing tag and transient reads may be propagation delays.
          // Unexpected errors and permanent HTTP/metadata failures remain fatal;
          // never include raw request diagnostics (possibly credentials) in logs.
          const summary =
            error instanceof RegistryLookupError || error instanceof RegistryTagError
              ? error.message
              : "registry confirmation failed";
          if (
            !(error instanceof RegistryTagError) &&
            !(error instanceof RegistryLookupError && (error.transient || error.status === 404))
          ) {
            return `public registry confirmation failed for ${name}@${version}: ${summary}`;
          }
          reasons.set(name, summary);
        }
      }),
    );
    const failure = failures.find((entry) => entry !== undefined);
    if (failure) throw new Error(failure);
    if (pending.size === 0) {
      for (const { name, version } of packages) {
        runtime.log(
          `✓ Published ${name}@${version}; public exact version and dist-tag ${tag} confirmed`,
        );
      }
      return;
    }
    const remaining = deadline - runtime.now();
    if (remaining <= 0) break;
    runtime.log(
      `Waiting for public registry confirmation of ${pending.size} package(s); ${Math.ceil(remaining / 1_000)}s remaining`,
    );
    await runtime.sleep(Math.min(CONFIRMATION_POLL_MS, remaining));
  }
  throw new Error(
    `public registry confirmation timed out after ${CONFIRMATION_BUDGET_MS / 1_000}s: ${[
      ...pending.values(),
    ]
      .map(
        ({ name, version }) =>
          `${name}@${version} (${reasons.get(name) ?? "read deadline reached"})`,
      )
      .join(
        "; ",
      )}; publisher accepted these packages, so inspect public metadata before any explicit recovery; do not automatically republish or move dist-tags`,
  );
}

export async function publishReleasePackage(
  name: string,
  version: string,
  tag: string,
  command: readonly string[],
  runtime: PublishRuntime,
): Promise<"published" | "existing"> {
  const result = await submitReleasePackage(name, version, tag, command, runtime);
  if (result === "existing") return result;
  await confirmAcceptedPackages([{ name, version }], tag, runtime);
  return "published";
}

function readManifest(path: string): PublishManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PublishManifest;
}

export function parsePublishArgs(args: readonly string[]): PublishOptions {
  let mode: PublishMode = "dry-run";
  let tag = "latest";
  let repoRoot = REPO_ROOT;

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
    if (argument === "--repo-root") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--repo-root requires a path");
      repoRoot = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(
      `unknown argument ${argument}; usage: bun run scripts/publish-release-packages.ts [--repo-root <path>] [--tag <tag>] [--list | --dry-run | --execute]`,
    );
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag)) {
    throw new Error(`invalid npm dist-tag ${JSON.stringify(tag)}`);
  }
  return { mode, tag, repoRoot };
}

function loadPublicManifests(repoRoot: string): Map<string, PublishManifest> {
  return new Map(
    PUBLIC_RELEASE_PACKAGES.map((definition) => [
      definition.name,
      readManifest(join(repoRoot, packageManifestPath(definition))),
    ]),
  );
}

export function publishCommands(tag: string): string[][] {
  return PUBLIC_RELEASE_PACKAGES.map((definition) => [
    "bun",
    "publish",
    "--cwd",
    definition.directory,
    "--registry",
    NPM_REGISTRY,
    "--tag",
    tag,
  ]);
}

export async function main(
  args: readonly string[] = process.argv.slice(2),
  runtime?: PublishRuntime,
): Promise<void> {
  const options = parsePublishArgs(args);
  runtime ??= defaultRuntime(options.repoRoot);
  const manifests = loadPublicManifests(options.repoRoot);
  const orderErrors = validatePublicReleaseOrder(manifests);
  if (orderErrors.length > 0) {
    throw new Error(
      `public publish order is invalid:\n${orderErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  }

  const rootVersion = readManifest(join(options.repoRoot, "package.json")).version;
  verifyReleaseVersions(rootVersion, options.repoRoot);
  const commands = publishCommands(options.tag);

  if (options.mode === "list") {
    for (const definition of PUBLIC_RELEASE_PACKAGES) {
      runtime.log(`${definition.name}  ${definition.directory}`);
    }
    return;
  }

  const accepted: AcceptedPackage[] = [];
  for (const [index, command] of commands.entries()) {
    const definition = PUBLIC_RELEASE_PACKAGES[index];
    runtime.log(`${options.mode === "execute" ? "→" : "would run:"} ${command.join(" ")}`);
    if (options.mode !== "execute") continue;
    const result = await submitReleasePackage(
      definition.name,
      rootVersion,
      options.tag,
      command,
      runtime,
    );
    if (result === "accepted") accepted.push({ name: definition.name, version: rootVersion });
  }

  await confirmAcceptedPackages(accepted, options.tag, runtime);

  if (options.mode === "dry-run") {
    runtime.log(
      `Dry run passed: ${commands.length} public packages are version-aligned and topologically ordered.`,
    );
  }
}

const invokedAsMain =
  typeof process.argv[1] === "string" &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedAsMain) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
