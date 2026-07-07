import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export type ContainedPluginSubpathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

function normPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function isContainedOrRoot(child: string, parent: string): boolean {
  const c = normPath(child);
  const parentPath = normPath(parent);
  const parentPrefix = normPath(parent.endsWith(sep) ? parent : parent + sep);
  return c === parentPath || c.startsWith(parentPrefix);
}

export function validateRelativePluginSubpath(subpath: string, label: string): string | null {
  if (typeof subpath !== "string" || subpath.length === 0) {
    return `${label} must be a non-empty relative path`;
  }
  if (subpath.includes("\0")) {
    return `${label} must not contain NUL bytes: ${subpath}`;
  }
  if (isAbsolute(subpath)) {
    return `${label} must be relative and inside the source tree: ${subpath}`;
  }
  if (subpath.split(/[\\/]+/).includes("..")) {
    return `${label} must not contain parent-directory segments: ${subpath}`;
  }
  return null;
}

export function resolveContainedPluginSubpath(
  root: string,
  subpath: string,
  label: string,
): ContainedPluginSubpathResult {
  const invalid = validateRelativePluginSubpath(subpath, label);
  if (invalid) return { ok: false, error: invalid };

  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    return { ok: false, error: `${label} root could not be resolved: ${(err as Error).message}` };
  }

  const candidate = resolve(root, subpath);
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    return { ok: false, error: `${label} not found in source tree: ${subpath}` };
  }

  if (!isContainedOrRoot(realCandidate, realRoot)) {
    return { ok: false, error: `${label} escapes the source tree: ${subpath}` };
  }
  return { ok: true, path: realCandidate };
}
