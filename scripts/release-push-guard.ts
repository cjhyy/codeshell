import { execFileSync } from "node:child_process";

/** The only branch a release may be pushed from; its tip is what gets tagged. */
export const RELEASE_BRANCH = "main";

/**
 * `release.ts --push` commits the bump on the current branch, pushes
 * `main`, then tags and pushes the current HEAD. Unless HEAD is `main`, the
 * tag (and the CI release it triggers) points at a commit that never reached
 * main. Returns why pushing must be refused, or null when it is safe.
 */
export function releasePushError(cwd: string): string | null {
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd,
    encoding: "utf8",
  }).trim();
  if (!branch) return `--push needs the ${RELEASE_BRANCH} branch checked out, not a detached HEAD`;
  if (branch !== RELEASE_BRANCH) {
    return `--push only releases from ${RELEASE_BRANCH}; current branch is ${branch}. Merge it into ${RELEASE_BRANCH} first`;
  }
  return null;
}
