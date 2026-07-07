import { resolve } from "node:path";
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
  return (
    s.startsWith("github:") ||
    s.startsWith("https://") ||
    s.startsWith("http://") ||
    s.startsWith("git://") ||
    s.startsWith("file://") ||
    isSshUrl(s)
  );
}

function unsafeTransport(input: string): string | null {
  if (input.startsWith("http://")) return "http://";
  if (input.startsWith("git://")) return "git://";
  if (input.startsWith("file://")) return "file://";
  return null;
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
  if (base.startsWith("github:")) {
    url = githubRepoToCloneUrl(base.slice("github:".length));
  } else {
    url = base;
  }

  const inferredName = subdir ? lastSegment(subdir) : repoNameFromUrl(url);

  const result: ParsedSource = { kind: "remote", url, raw, inferredName };
  if (ref) result.ref = ref;
  if (subdir) result.subdir = subdir;
  return result;
}
