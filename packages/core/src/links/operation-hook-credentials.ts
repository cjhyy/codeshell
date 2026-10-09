import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isSensitiveResourcePath } from "../tool-system/path-policy.js";

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== "..");
}

export interface HookCredentialPolicy {
  readonly excludedRoots: readonly string[];
  readonly stateRoots: readonly string[];
  assertCurrent(): void;
}

/** Canonical existing ancestors plus a not-yet-created suffix, without opening bytes. */
function canonicalKnownRoot(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (true) {
    try {
      return join(realpathSync(current), ...suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        lstatSync(current);
        throw new Error("Known credential root is unsafe", { cause: error });
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing;
      }
      const parent = dirname(current);
      if (parent === current)
        throw new Error("Known credential root is unavailable", { cause: error });
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}

/** Frozen native startup paths; callers cannot supply these through a Hook plan. */
export function createHookCredentialPolicy(options: {
  nativeHome: string;
  temporaryRoot: string;
  sensitiveRoots: readonly string[];
  stateRoot?: string;
}): HookCredentialPolicy {
  const stateRoot = options.stateRoot ?? join(options.nativeHome, ".code-shell");
  const excludedSources = [
    ...[".ssh", ".aws", ".config/gcloud", ".gnupg", ".kube", ".docker", "Library/Keychains"].map(
      (name) => join(options.nativeHome, name),
    ),
    ...options.sensitiveRoots,
    join(options.temporaryRoot, "codeshell-cookie-leases"),
  ];
  const stateSources = [stateRoot, join(options.nativeHome, ".code-shell")];
  const excludedRoots = excludedSources.map(canonicalKnownRoot);
  const stateRoots = stateSources.map(canonicalKnownRoot);
  return Object.freeze({
    excludedRoots: Object.freeze(excludedRoots),
    stateRoots: Object.freeze([...new Set(stateRoots)]),
    assertCurrent() {
      if (
        excludedSources.some((path, index) => canonicalKnownRoot(path) !== excludedRoots[index]) ||
        stateSources.some((path, index) => canonicalKnownRoot(path) !== stateRoots[index])
      )
        throw new Error("Known credential root custody changed");
    },
  });
}

function knownStateContainer(relativeState: string): boolean {
  return (
    /^(?:settings(?:\.(?:local|managed))?\.(?:json|ya?ml)|credentials\.json)(?:\.|$)/.test(
      relativeState,
    ) ||
    /^plugins\/(?:.*\/)?(?:\.mcp|mcp-servers)\.json(?:\.|$)/.test(relativeState) ||
    /^browser-runtime\/(?:profiles(?:\/|$)|chrome-native\.json(?:\.|$))/.test(relativeState) ||
    /^im-gateway\/(?:config|desktop-control)\.json(?:\.|$)/.test(relativeState) ||
    /^chat\/wechat\/accounts(?:\/|$)/.test(relativeState) ||
    /^(?:(?:serve|desktop)\/)?(?:access\.json(?:\.|$)|project-runtime-secrets(?:\/|$)|project-control\/registry\.json(?:\.|$))/.test(
      relativeState,
    )
  );
}

/** Finite known Host containers; this does not inspect or classify file contents. */
export function assertHookResourceNotCredential(path: string, policy: HookCredentialPolicy): void {
  const knownState =
    /(?:^|\/)\.code-shell\/(?:settings(?:\.(?:local|managed))?\.(?:json|ya?ml)|credentials\.json)(?:\.|$)/.test(
      path.split(sep).join("/"),
    ) ||
    policy.stateRoots.some(
      (root) =>
        within(root, path) && knownStateContainer(relative(root, path).split(sep).join("/")),
    );
  if (
    policy.excludedRoots.some((root) => within(root, path)) ||
    knownState ||
    isSensitiveResourcePath(basename(path))
  )
    throw new Error("Hook resource is a known credential container");
}
