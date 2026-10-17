import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { resolveGit } from "@cjhyy/code-shell-core/extension";
import { ALL_DIMENSIONS, type ReviewDimension } from "./review-prompt.js";

export type ReviewTarget =
  | { kind: "working"; mode: "all" | "staged" | "unstaged"; file?: string }
  | { kind: "base"; ref: string; file?: string }
  | { kind: "commit"; commit: string; file?: string };

export interface ReviewArguments {
  target: ReviewTarget;
  json: boolean;
  dimensions: ReviewDimension[];
}

export interface CollectedReviewTarget {
  content: string;
  label: string;
  /** Repository-relative paths, including empty files and metadata-only changes. */
  files: string[];
}

const execFileAsync = promisify(execFile);
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_ADDED_FILE_BYTES = 64 * 1024;
const MAX_FILES = 100;
const DIFF_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-relative",
  "--no-renames",
  "--ignore-submodules=none",
  "--submodule=short",
];

/** Parse slash-command arguments without treating quotes or flags as path fragments. */
export function parseReviewArguments(input: string): ReviewArguments {
  const tokens = tokenizeReviewArguments(input);
  let target: ReviewTarget | undefined;
  let file: string | undefined;
  let json = false;
  let dimensions = [...ALL_DIMENSIONS];
  let dimensionsSeen = false;
  let positional = false;
  const setTarget = (next: ReviewTarget): void => {
    if (target)
      throw new Error(
        "Choose only one review scope: --all, --staged, --unstaged, --base, or --commit.",
      );
    target = next;
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!positional && token === "--") {
      positional = true;
      continue;
    }
    if (!positional && token.startsWith("--")) {
      if (token === "--json") {
        if (json) throw new Error("--json may only be specified once.");
        json = true;
      } else if (token === "--all" || token === "--staged" || token === "--unstaged") {
        setTarget({ kind: "working", mode: token.slice(2) as "all" | "staged" | "unstaged" });
      } else if (/^--(?:base|commit|dimensions)(?:=|$)/.test(token)) {
        const equals = token.indexOf("=");
        const flag = equals < 0 ? token : token.slice(0, equals);
        const value = equals < 0 ? tokens[++index] : token.slice(equals + 1);
        if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
        if (flag === "--base") {
          validateRef(value);
          setTarget({ kind: "base", ref: value });
        } else if (flag === "--commit") {
          if (!/^[a-fA-F0-9]{4,64}$/.test(value)) {
            throw new Error("--commit requires a hexadecimal commit hash (4–64 characters).");
          }
          setTarget({ kind: "commit", commit: value });
        } else {
          if (dimensionsSeen) throw new Error("--dimensions may only be specified once.");
          dimensionsSeen = true;
          const names = value.split(",").map((name) => name.trim().toLowerCase());
          const normalized = names.map((name) => (name === "perf" ? "performance" : name));
          const invalid = normalized.filter(
            (name) => !ALL_DIMENSIONS.includes(name as ReviewDimension),
          );
          if (invalid.length)
            throw new Error(
              `Unknown review dimension: ${invalid.join(", ")}. Use correctness, security, performance, or readability.`,
            );
          dimensions = ALL_DIMENSIONS.filter((name) => normalized.includes(name));
        }
      } else {
        throw new Error(`Unknown review option: ${token}.`);
      }
    } else {
      if (!positional && token.startsWith("-")) {
        throw new Error(`Unknown review option: ${token}. Use -- before a dash-prefixed path.`);
      }
      if (file !== undefined)
        throw new Error(
          "Review accepts one file or directory path. Quote paths containing spaces.",
        );
      if (!token || token.includes("\0")) throw new Error("Invalid review path.");
      file = token;
    }
  }
  return {
    target: {
      ...(target ?? { kind: "working", mode: "all" }),
      ...(file ? { file } : {}),
    } as ReviewTarget,
    json,
    dimensions,
  };
}

function validateRef(ref: string): void {
  if (ref.startsWith("-") || /[\x00-\x20\x7f]/.test(ref) || ref.length > 512) {
    throw new Error("--base requires a valid Git reference.");
  }
}

function tokenizeReviewArguments(input: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && /["\\]/.test(input[index + 1] ?? ""))
        token += input[++index];
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else if (char === "\\" && /[\s'"\\]/.test(input[index + 1] ?? "")) {
      token += input[++index];
      started = true;
    } else {
      token += char;
      started = true;
    }
  }
  if (quote) throw new Error("Unclosed quote in review arguments.");
  if (started) tokens.push(token);
  return tokens;
}

/** Collect a complete bounded patch, or fail explicitly before asking the model to review it. */
export async function collectReviewTarget(
  cwd: string,
  target: ReviewTarget,
): Promise<CollectedReviewTarget> {
  const repoRoot = (await git(cwd, ["rev-parse", "--show-toplevel"]))!.trim();
  const file = target.file === undefined ? undefined : repositoryPath(repoRoot, cwd, target.file);
  const pathspec = file === undefined ? [] : [`:(literal)${file}`];
  const paths = ["--", ...pathspec];
  let range: string[];
  let label: string;
  let unbornAll = false;
  if (target.kind === "base") {
    validateRef(target.ref);
    const base = await resolveCommit(repoRoot, target.ref);
    const head = await resolveCommit(repoRoot, "HEAD");
    const ancestor = (await git(repoRoot, ["merge-base", base, head]))!.trim();
    range = [ancestor, head];
    label = `branch changes since merge-base with ${target.ref}`;
  } else if (target.kind === "commit") {
    if (!/^[a-fA-F0-9]{4,64}$/.test(target.commit)) throw new Error("Invalid review commit hash.");
    const commit = await resolveCommit(repoRoot, target.commit);
    range = [commit];
    label = `commit ${commit}`;
  } else {
    if (!["all", "staged", "unstaged"].includes(target.mode))
      throw new Error("Invalid review scope.");
    const head = await git(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], true);
    unbornAll = target.mode === "all" && head === null;
    range =
      target.mode === "staged" ? ["--cached"] : target.mode === "all" && head ? [head.trim()] : [];
    label = `${target.mode === "all" ? "all uncommitted" : target.mode} changes`;
    const conflicts = await git(repoRoot, ["ls-files", "--unmerged", "-z", ...paths]);
    if (conflicts)
      throw new Error("Review incomplete: resolve unmerged files before reviewing this scope.");
  }

  const command = target.kind === "commit" ? "show" : "diff";
  const prefix = command === "show" ? ["show", "--format=", "--root", "--first-parent"] : ["diff"];
  const options = [...prefix, ...DIFF_OPTIONS];
  let content = "";
  let files: string[] = [];
  if (!unbornAll) {
    const numstat = (await git(repoRoot, [...options, "--numstat", "-z", ...range, ...paths]))!;
    for (const entry of numstat.split("\0").filter(Boolean)) {
      const [added, removed, ...name] = entry.split("\t");
      if (added === "-" || removed === "-") {
        throw new Error(
          `Review incomplete: binary file ${name.join("\t")} cannot be reviewed as text.`,
        );
      }
    }
    files = nulPaths((await git(repoRoot, [...options, "--name-only", "-z", ...range, ...paths]))!);
    enforceFileCount(files.length);
    content = (await git(repoRoot, [...options, "--patch", "--unified=3", ...range, ...paths]))!;
    if (content.includes("\0")) {
      throw new Error(
        "Review incomplete: the patch contains binary data that cannot be reviewed as text.",
      );
    }
  }

  if (target.kind === "working" && target.mode !== "staged") {
    const added = nulPaths(
      (await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z", ...paths]))!,
    );
    if (unbornAll)
      added.unshift(...nulPaths((await git(repoRoot, ["ls-files", "--cached", "-z", ...paths]))!));
    const uniqueAdded = [...new Set(added)];
    enforceFileCount(files.length + uniqueAdded.length);
    for (const path of uniqueAdded) {
      const patch = await addedFilePatch(repoRoot, path, unbornAll);
      if (patch === null) continue; // A staged addition deleted before the first commit has no net change.
      files.push(path);
      content += `${content && !content.endsWith("\n") ? "\n" : ""}${patch}`;
      enforceDiffSize(content);
    }
  }
  enforceDiffSize(content);
  if (file !== undefined && files.length === 0) {
    throw new Error(`No changes in the selected review scope match ${target.file}.`);
  }
  return { content, label: `${label}${target.file ? ` in ${target.file}` : ""}`, files };
}

function repositoryPath(root: string, cwd: string, file: string): string {
  if (!file || file.includes("\0")) throw new Error("Invalid review path.");
  const path = relative(root, resolve(cwd, file));
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error("Review path must be inside the Git repository.");
  return path.split(sep).join("/") || ".";
}

async function resolveCommit(cwd: string, ref: string): Promise<string> {
  return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]))!.trim();
}

function nulPaths(raw: string): string[] {
  return raw.split("\0").filter(Boolean);
}

function enforceFileCount(count: number): void {
  if (count > MAX_FILES)
    throw new Error(
      `Review incomplete: scope exceeds ${MAX_FILES} files. Select a narrower scope or path.`,
    );
}

function enforceDiffSize(content: string): void {
  if (Buffer.byteLength(content) > MAX_DIFF_BYTES)
    throw new Error(
      `Review incomplete: patch exceeds ${MAX_DIFF_BYTES} bytes. Select a narrower scope or path.`,
    );
}

async function git(cwd: string, args: string[], allowMissing = false): Promise<string | null> {
  try {
    const result = await execFileAsync(
      resolveGit(),
      ["--no-pager", "-c", "core.fsmonitor=false", ...args],
      {
        cwd,
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: MAX_DIFF_BYTES,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
    );
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
  } catch (error) {
    const failure = error as Error & {
      code?: string | number;
      stderr?: string | Buffer;
      killed?: boolean;
    };
    if (allowMissing && failure.code === 1) return null;
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      throw new Error(
        `Review incomplete: Git output exceeds ${MAX_DIFF_BYTES} bytes. Select a narrower scope or path.`,
        { cause: error },
      );
    if (failure.code === "ERR_ENCODING_INVALID_ENCODED_DATA") {
      throw new Error("Review incomplete: Git output contains non-UTF-8 data.", { cause: error });
    }
    if (failure.killed)
      throw new Error("Review incomplete: Git collection timed out.", { cause: error });
    throw new Error(
      `Review collection failed: ${String(failure.stderr || failure.message)
        .trim()
        .slice(0, 500)}`,
      { cause: error },
    );
  }
}

async function addedFilePatch(
  repoRoot: string,
  file: string,
  allowDeleted: boolean,
): Promise<string | null> {
  const absolute = resolve(repoRoot, file);
  const bounded = repositoryPath(repoRoot, repoRoot, file);
  let stat;
  try {
    // Refuse symlinks in every component, including a directory replaced after ls-files.
    let component = repoRoot;
    for (const part of bounded.split("/")) {
      component = resolve(component, part);
      const info = await lstat(component);
      if (info.isSymbolicLink()) throw new Error(`Review incomplete: ${file} is a symbolic link.`);
    }
    stat = await lstat(absolute);
  } catch (error) {
    if (allowDeleted && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile()) throw new Error(`Review incomplete: ${file} is not a regular file.`);
  if (stat.size > MAX_ADDED_FILE_BYTES)
    throw new Error(
      `Review incomplete: ${file} exceeds the ${MAX_ADDED_FILE_BYTES}-byte added-file limit.`,
    );
  const handle = await open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > MAX_ADDED_FILE_BYTES ||
      before.dev !== stat.dev ||
      before.ino !== stat.ino
    )
      throw new Error(
        `Review incomplete: ${file} changed during collection or exceeds the added-file limit.`,
      );
    const bytes = Buffer.alloc(MAX_ADDED_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead > MAX_ADDED_FILE_BYTES ||
      before.size !== bytesRead ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(
        `Review incomplete: ${file} changed during collection or exceeds the added-file limit.`,
      );
    }
    const body = bytes.subarray(0, bytesRead);
    if (body.includes(0))
      throw new Error(`Review incomplete: binary file ${file} cannot be reviewed as text.`);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      throw new Error(`Review incomplete: ${file} is not valid UTF-8 text.`);
    }
    const lines = text ? text.split("\n") : [];
    const newline = text.endsWith("\n");
    if (newline) lines.pop();
    const a = quoteGitPath(`a/${file}`);
    const b = quoteGitPath(`b/${file}`);
    return [
      `diff --git ${a} ${b}`,
      `new file mode ${stat.mode & 0o111 ? "100755" : "100644"}`,
      ...(lines.length
        ? [
            "--- /dev/null",
            `+++ ${b}`,
            `@@ -0,0 +1,${lines.length} @@`,
            ...lines.map((line) => `+${line}`),
            ...(!newline ? ["\\ No newline at end of file"] : []),
          ]
        : []),
      "",
    ].join("\n");
  } finally {
    await handle.close();
  }
}

function quoteGitPath(path: string): string {
  return `"${path.replace(/["\\\x00-\x1f\x7f]/g, (char) => (char === '"' || char === "\\" ? `\\${char}` : `\\${char.charCodeAt(0).toString(8).padStart(3, "0")}`))}"`;
}
