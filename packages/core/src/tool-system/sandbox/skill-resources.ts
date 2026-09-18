import { lstatSync, opendirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { isSensitiveResourcePath, registeredSkillResourceRoots } from "../path-policy.js";
import type { SandboxConfig } from "./index.js";

export interface SkillReadAccess {
  roots: string[];
  files: string[];
  directories: string[];
  traversalDirectories: string[];
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/**
 * A fresh, bounded inventory for each command, using the file tool's Skill
 * registration and credential rules. Only the default CodeShell directory
 * denial has exceptions; any additional matching deny still wins. Exact
 * files (not a subtree grant) keep later-created secrets and symlink escapes
 * from inheriting read access. No file contents are read by this inventory.
 */
export function collectSkillReadAccess(config: SandboxConfig): SkillReadAccess {
  const access: SkillReadAccess = {
    roots: [],
    files: [],
    directories: [],
    traversalDirectories: [],
  };
  let homeRoot: string;
  try {
    homeRoot = realpathSync(join(process.env.HOME ?? homedir(), ".code-shell"));
  } catch {
    return access;
  }
  if (!config.deniedReads.includes(homeRoot)) return access;
  const otherDenies = config.deniedReads.filter((path) => path !== homeRoot);
  const blocked = (path: string) => otherDenies.some((denied) => inside(path, denied));
  const traversal = new Set<string>();
  let remaining = 10_000;

  for (const root of registeredSkillResourceRoots()) {
    if (!inside(root, homeRoot) || blocked(root) || remaining <= 0) continue;
    const pending = [root];
    access.roots.push(root);
    while (pending.length && remaining > 0) {
      const path = pending.pop()!;
      remaining -= 1;
      if (blocked(path) || isSensitiveResourcePath(path) || /[\x00-\x1f\x7f]/.test(path)) continue;
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || realpathSync(path) !== path) continue;
        if (stat.isDirectory()) {
          access.directories.push(path);
          // Bound the pending queue and directory scan as well as the visits.
          const directory = opendirSync(path);
          try {
            while (pending.length < remaining) {
              const entry = directory.readSync();
              if (!entry) break;
              pending.push(join(path, entry.name));
            }
          } finally {
            directory.closeSync();
          }
        } else if (stat.isFile() && stat.nlink === 1) {
          access.files.push(path);
        }
      } catch {
        // Concurrent removal or replacement never broadens the grant.
      }
    }
    for (let parent = dirname(root); inside(parent, homeRoot); parent = dirname(parent)) {
      traversal.add(parent);
      if (parent === homeRoot) break;
    }
  }
  access.traversalDirectories = [...traversal];
  return access;
}
