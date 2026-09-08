import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { devNull } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { resolvePanelAppBindingProjectPath } from "@cjhyy/code-shell-core";
import { PanelManagementError } from "./management.js";

export interface HubPanelBinding {
  bindingCwd: string;
  /** Cheap synchronous topology check; never derives a new target after startup. */
  assertBinding: () => void;
}

function refused(): never {
  throw new PanelManagementError(
    403,
    "panel_binding_unavailable",
    "无法核验面板所属项目，或 Git 工作区关联已经变化。请检查工作区后重启服务，再绑定面板。",
  );
}

function metadata(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function readPointer(file: string): { content: string; identity: string } {
  const descriptor = openSync(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size > 8192) refused();
    const content = readFileSync(descriptor, "utf8");
    if (Buffer.byteLength(content) > 8192 || content.includes("\0")) refused();
    return { content, identity: `${info.dev}:${info.ino}` };
  } finally {
    closeSync(descriptor);
  }
}

function nearestGit(cwd: string): { root: string; path: string; info: Stats } | undefined {
  let current = cwd;
  for (let depth = 0; depth < 256; depth++) {
    const path = join(current, ".git");
    const info = metadata(path);
    if (info) {
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) refused();
      return { root: current, path, info };
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
  return refused();
}

function sameIdentity(actual: Stats, expected: Stats) {
  return actual.dev === expected.dev && actual.ino === expected.ino;
}

function directoryGuard(path: string): () => void {
  const canonical = realpathSync(path);
  const info = lstatSync(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) refused();
  return () => {
    if (realpathSync(path) !== canonical) refused();
    const current = lstatSync(canonical);
    if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, info))
      refused();
  };
}

function pointerGuard(path: string): () => void {
  const initial = readPointer(path);
  return () => {
    const current = readPointer(path);
    if (current.content !== initial.content || current.identity !== initial.identity) refused();
  };
}

/**
 * --cwd authorizes that workspace, not an arbitrary path written into .git.
 * Verify Git's forward and reverse worktree relationship once, then freeze the
 * binding target shared by management, storage, and Core's Skill scanner.
 * An unsupported or changed topology disables panels without stopping the Hub.
 */
export function createHubPanelBinding(cwdInput: string): HubPanelBinding {
  const cwd = resolve(cwdInput);
  try {
    const guards: Array<() => void> = [directoryGuard(cwd)];
    const initial = nearestGit(cwd);
    let bindingCwd = cwd;
    if (initial) {
      const environment = { ...process.env };
      for (const key of Object.keys(environment))
        if (key.startsWith("GIT_")) delete environment[key];
      environment.GIT_CONFIG_NOSYSTEM = "1";
      environment.GIT_CONFIG_GLOBAL = devNull;
      environment.GIT_OPTIONAL_LOCKS = "0";
      const git = (at: string, ...args: string[]) =>
        execFileSync("git", ["-c", "core.fsmonitor=false", "-C", at, ...args], {
          env: environment,
          encoding: "utf8",
          timeout: 3000,
          maxBuffer: 256 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }).trimEnd();
      const top = realpathSync(git(cwd, "rev-parse", "--show-toplevel"));
      const gitDir = realpathSync(git(cwd, "rev-parse", "--absolute-git-dir"));
      const common = realpathSync(resolve(cwd, git(cwd, "rev-parse", "--git-common-dir")));
      if (top !== realpathSync(initial.root)) refused();
      bindingCwd = resolvePanelAppBindingProjectPath(cwd);
      guards.push(directoryGuard(initial.root), directoryGuard(common));
      if (initial.info.isDirectory()) {
        if (
          gitDir !== realpathSync(initial.path) ||
          common !== gitDir ||
          realpathSync(bindingCwd) !== top
        )
          refused();
        guards.push(directoryGuard(initial.path));
      } else {
        // Standard linked worktrees must point into the main repository's own
        // registry, whose back-pointer names this exact .git file.
        if (basename(common) !== ".git") refused();
        const main = dirname(common);
        const relativeGitDir = gitDir.slice(common.length + 1);
        if (
          !gitDir.startsWith(common + sep) ||
          !/^worktrees[\\/][^\\/]+$/.test(relativeGitDir) ||
          realpathSync(bindingCwd) !== realpathSync(main)
        )
          refused();
        if (realpathSync(git(main, "rev-parse", "--show-toplevel")) !== realpathSync(main))
          refused();
        if (realpathSync(git(main, "rev-parse", "--absolute-git-dir")) !== common) refused();
        const backPointer = join(gitDir, "gitdir");
        const commonPointer = join(gitDir, "commondir");
        if (realpathSync(readPointer(backPointer).content.trim()) !== realpathSync(initial.path))
          refused();
        if (realpathSync(resolve(gitDir, readPointer(commonPointer).content.trim())) !== common)
          refused();
        const listed = git(main, "worktree", "list", "--porcelain", "-z")
          .split("\0")
          .filter((line) => line.startsWith("worktree "))
          .map((line) => line.slice(9));
        if (!listed.includes(top) || !listed.includes(realpathSync(main))) refused();
        guards.push(
          directoryGuard(main),
          directoryGuard(gitDir),
          pointerGuard(initial.path),
          pointerGuard(backPointer),
          pointerGuard(commonPointer),
        );
      }
    }
    const frozen = bindingCwd;
    const assertBinding = () => {
      try {
        for (const check of guards) check();
        const current = nearestGit(cwd);
        if (initial) {
          if (
            !current ||
            current.path !== initial.path ||
            !sameIdentity(current.info, initial.info)
          )
            refused();
        } else if (current && (current.root !== cwd || !current.info.isDirectory())) refused();
        if (resolvePanelAppBindingProjectPath(cwd) !== frozen) refused();
      } catch {
        refused();
      }
    };
    assertBinding();
    return { bindingCwd: frozen, assertBinding };
  } catch {
    return { bindingCwd: cwd, assertBinding: refused };
  }
}
