import { resolve } from "node:path";
import { valid as validSemver, validRange as validSemverRange } from "semver";
import { githubRepoToCloneUrl } from "../gitOps.js";
import { PluginInstallError } from "./types.js";

/**
 * Result of classifying a `plugin install <source>` argument. Pure parse — no
 * I/O, no execution. `local` resolves to an absolute path; `remote` carries a
 * git-cloneable URL plus optional ref/subdir and the original raw string
 * (written back into .cs-meta.json so `plugin list`/`update` see the git
 * source, not the throwaway clone path). See spec
 * docs/superpowers/specs/2026-05-29-plugin-remote-install-design.md §4–§5.
 */
export type ParsedSource =
  | { kind: "local"; path: string }
  | {
      kind: "npm";
      packageName: string;
      selector: string;
      selectorKind: "exact" | "tag";
      raw: string;
      inferredName: string;
    }
  | {
      kind: "remote";
      url: string;
      ref?: string;
      subdir?: string;
      raw: string;
      inferredName: string;
    };

export interface ParseSourceOptions {
  allowUnsafeTransport?: boolean;
}

/** SSH shorthand `git@host:org/repo.git` — has a `:` after the `git@host` part. */
function isSshUrl(s: string): boolean {
  return /^[^/]+@[^/]+:/.test(s) && !s.includes("://");
}

function isRemote(s: string): boolean {
  const lower = s.toLowerCase();
  return lower.startsWith("github:") || /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || isSshUrl(s);
}

const MAX_NPM_PACKAGE_NAME = 214;
const MAX_NPM_SELECTOR = 128;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const NPM_DIST_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parse the intentionally small npm Phase-A source grammar. */
export function parseNpmPluginSource(input: string): Extract<ParsedSource, { kind: "npm" }> {
  if (!input.startsWith("npm:")) {
    throw new PluginInstallError("npm plugin source must start with npm:");
  }
  const spec = input.slice("npm:".length);
  let packageName = spec;
  let selector = "latest";

  // Scoped names contain their own leading '@'. A selector separator is only
  // an '@' after the slash; unscoped names use their last '@'.
  const selectorAt = spec.startsWith("@")
    ? (() => {
        const slash = spec.indexOf("/");
        return slash < 0 ? -1 : spec.lastIndexOf("@") > slash ? spec.lastIndexOf("@") : -1;
      })()
    : spec.lastIndexOf("@");
  if (selectorAt >= 0) {
    packageName = spec.slice(0, selectorAt);
    selector = spec.slice(selectorAt + 1);
  }

  if (
    packageName.length === 0 ||
    packageName.length > MAX_NPM_PACKAGE_NAME ||
    !NPM_PACKAGE_NAME.test(packageName)
  ) {
    throw new PluginInstallError(`invalid public npm package name: ${packageName || "(empty)"}`);
  }
  const exact = validSemver(selector);
  if (
    selector.length === 0 ||
    selector.length > MAX_NPM_SELECTOR ||
    (!exact && (!NPM_DIST_TAG.test(selector) || validSemverRange(selector) !== null))
  ) {
    throw new PluginInstallError(
      `npm selector must be an exact version or dist-tag (ranges are not supported): ${selector || "(empty)"}`,
    );
  }

  const inferredName = packageName.split("/").pop() ?? packageName;
  return {
    kind: "npm",
    packageName,
    selector: exact ?? selector,
    selectorKind: exact ? "exact" : "tag",
    raw: input,
    inferredName,
  };
}

function unsafeTransport(input: string): string | null {
  const scheme = input.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (!scheme) return null;
  if (scheme === "https") return null;
  return `${scheme}://`;
}

function lowerUrlScheme(input: string): string {
  return input.replace(/^([a-z][a-z0-9+.-]*):/i, (scheme) => scheme.toLowerCase());
}

function hasGithubScheme(input: string): boolean {
  return input.slice(0, "github:".length).toLowerCase() === "github:";
}

function stripGithubScheme(input: string): string {
  return input.slice("github:".length);
}

/** Last path segment of a repo url/path, with a trailing `.git` stripped. */
function repoNameFromUrl(url: string): string {
  const noGit = url.replace(/\.git$/, "");
  const seg = noGit.split(/[/:]/).filter(Boolean).pop() ?? noGit;
  return seg;
}

/** Last path segment of a subdir. */
function lastSegment(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function parseSource(input: string, options: ParseSourceOptions = {}): ParsedSource {
  if (input.startsWith("npm:")) return parseNpmPluginSource(input);
  if (!isRemote(input)) {
    return { kind: "local", path: resolve(input) };
  }

  const unsafe = unsafeTransport(input);
  if (unsafe && !options.allowUnsafeTransport) {
    throw new PluginInstallError(
      `unsafe plugin source transport '${unsafe}' is disabled by default; use https://, github:, SSH, or pass allowUnsafeTransport explicitly`,
    );
  }

  const raw = input;

  // 1. Split off `#subdir` (last `#`).
  let rest = input;
  let subdir: string | undefined;
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    subdir = rest.slice(hashIdx + 1) || undefined;
    rest = rest.slice(0, hashIdx);
  }

  // 2. Split off `@ref`. SSH form `git@host:...` contains its own `@`, so
  //    strip the leading `user@` first, then look for a ref `@` in the tail.
  let ref: string | undefined;
  let base = rest;
  if (isSshUrl(rest)) {
    const at = rest.indexOf("@");
    const head = rest.slice(0, at + 1); // "git@"
    const tail = rest.slice(at + 1); // "host:org/repo.git@ref"
    const tailAt = tail.lastIndexOf("@");
    if (tailAt >= 0) {
      ref = tail.slice(tailAt + 1) || undefined;
      base = head + tail.slice(0, tailAt);
    }
  } else {
    const at = rest.lastIndexOf("@");
    if (at >= 0) {
      ref = rest.slice(at + 1) || undefined;
      base = rest.slice(0, at);
    }
  }

  // 3. Normalize url.
  let url: string;
  if (hasGithubScheme(base)) {
    url = githubRepoToCloneUrl(stripGithubScheme(base));
  } else {
    url = lowerUrlScheme(base);
  }

  const inferredName = subdir ? lastSegment(subdir) : repoNameFromUrl(url);

  const result: ParsedSource = { kind: "remote", url, raw, inferredName };
  if (ref) result.ref = ref;
  if (subdir) result.subdir = subdir;
  return result;
}
