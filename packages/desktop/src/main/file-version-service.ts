import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { sanitizeGitBlobRef } from "@cjhyy/code-shell-core/internal";
import { createReadOnlyGitRunner, gitRepositoryId } from "@cjhyy/code-shell-capability-coding/git";
import type { FileVersionResult } from "../shared/file-version.js";

const MAX_BYTES = 2_000_000;

/** Read only from the authorized repository. worktreePath is display metadata. */
export async function readGitBlobVersion(
  authorizedRoot: string,
  unknownRef: unknown,
): Promise<FileVersionResult> {
  const ref = sanitizeGitBlobRef(unknownRef);
  if (!ref) throw new Error("Invalid Git blob version reference");
  const root = await realpath(authorizedRoot);
  if (!(await stat(root)).isDirectory()) throw new Error("Invalid authorized root");
  const run = createReadOnlyGitRunner({ deadline: performance.now() + 4000 });
  let top: string;
  let commonDir: string;
  try {
    const discovery = (
      await run(root, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ])
    )
      .toString("utf8")
      .trimEnd()
      .split("\n");
    if (discovery.length !== 2) return { status: "unavailable", reason: "not-a-repository" };
    [top, commonDir] = (await Promise.all(discovery.map((p) => realpath(p)))) as [string, string];
  } catch {
    return { status: "unavailable", reason: "not-a-repository" };
  }
  const prefix = relative(top, root).split(sep).join("/");
  if (
    isAbsolute(prefix) ||
    prefix.split("/").includes("..") ||
    (prefix && !ref.repoPath.startsWith(prefix + "/"))
  )
    throw new Error("Version path escapes authorized root");
  try {
    if (!ref.repositoryId || ref.repositoryId !== (await gitRepositoryId(commonDir)))
      return { status: "unavailable", reason: "repository-mismatch" };
    const git = (args: string[], maxBuffer?: number) => run(top, args, maxBuffer);
    try {
      if ((await git(["cat-file", "-t", ref.commit])).toString("utf8").trim() !== "commit")
        return { status: "unavailable", reason: "mismatch" };
    } catch {
      return { status: "unavailable", reason: "object-missing" };
    }
    const entries = (await git(["ls-tree", "-z", "--full-tree", ref.commit, "--", ref.repoPath]))
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (entries.length !== 1) return { status: "unavailable", reason: "mismatch" };
    const tab = entries[0]!.indexOf("\t");
    const [mode, type, blob] = entries[0]!.slice(0, tab).split(" ");
    if (
      entries[0]!.slice(tab + 1) !== ref.repoPath ||
      !["100644", "100755"].includes(mode!) ||
      type !== "blob" ||
      blob !== ref.blob
    )
      return { status: "unavailable", reason: "mismatch" };
    let size: number;
    try {
      size = Number((await git(["cat-file", "-s", ref.blob])).toString("ascii").trim());
    } catch {
      return { status: "unavailable", reason: "object-missing" };
    }
    if (!Number.isSafeInteger(size) || size < 0)
      return { status: "unavailable", reason: "read-failed" };
    if (size > MAX_BYTES) return { status: "unavailable", reason: "too-large" };
    let bytes: Buffer;
    try {
      bytes = await git(["cat-file", "blob", ref.blob], MAX_BYTES + 1);
    } catch {
      return { status: "unavailable", reason: "object-missing" };
    }
    if (
      bytes.length !== size ||
      createHash(ref.blob.length === 64 ? "sha256" : "sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex") !== ref.blob
    )
      return { status: "unavailable", reason: "mismatch" };
    if (bytes.includes(0)) return { status: "unavailable", reason: "binary" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { status: "unavailable", reason: "invalid-utf8" };
    }
    return { status: "ok", text, size, commit: ref.commit, blob: ref.blob, repoPath: ref.repoPath };
  } catch {
    return { status: "unavailable", reason: "read-failed" };
  }
}
