/** Host-only Skill file management shared by Desktop and the Hub. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { promises as fs } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseDocument } from "yaml";
import { userHome } from "../settings/manager.js";
import { acquireFileLock } from "../utils/file-mutex.js";
import { invalidateSkillCache } from "./scanner.js";
import { parseFrontmatter, quoteProblematicValues } from "./frontmatter.js";

export const MAX_SKILL_MARKDOWN_BYTES = 2 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_BYTES = 50 * 1024 * 1024;
export const MAX_SKILL_BUNDLE_FILES = 200;

export interface InstalledSkill {
  name: string;
  targetDir: string;
  filePath: string;
}
export interface SkillBundleFile {
  path: string;
  size: number;
  executable: boolean;
}
export interface SkillBundle {
  revision: string;
  files: SkillBundleFile[];
  bytes: number;
  content: string;
}

export class SkillConflictError extends Error {
  constructor(message = "Skill 已发生变化，请刷新后重试。") {
    super(message);
    this.name = "SkillConflictError";
  }
}

export function assertSafeSkillName(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("Skill 名称须为 1–128 个字母、数字、短横线、下划线或点，不能包含路径。");
  }
  return value;
}

/** Accept the scanner's compatibility YAML, but never silently discard broken frontmatter. */
export function validateSkillMarkdown(content: unknown): string {
  if (typeof content !== "string" || !content.trim() || content.includes("\0"))
    throw new Error("SKILL.md 内容不能为空或包含空字符。");
  if (Buffer.byteLength(content) > MAX_SKILL_MARKDOWN_BYTES)
    throw new Error("SKILL.md 不得超过 2 MiB。");
  if (/^---\s*(?:\r?\n|$)/.test(content)) {
    const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content);
    if (!match) throw new Error("Frontmatter 缺少结束的 ---。");
    let parsed = parseDocument(match[1]!);
    if (parsed.errors.length) parsed = parseDocument(quoteProblematicValues(match[1]!));
    if (parsed.errors.length) throw new Error("Frontmatter YAML 格式无效，请检查缩进与引号。");
    const value: unknown = parsed.toJS();
    if (value !== null && (!value || typeof value !== "object" || Array.isArray(value)))
      throw new Error("Frontmatter 必须是键值配置。");
    if (value && typeof value === "object") {
      const data = value as Record<string, unknown>;
      if (data.name !== undefined && typeof data.name !== "string")
        throw new Error("Frontmatter 的 name 必须是文字。");
      if (data.description !== undefined && typeof data.description !== "string")
        throw new Error("Frontmatter 的 description 必须是文字。");
    }
  }
  return content;
}

export function skillMarkdownSummary(content: string): { description: string } {
  const parsed = parseFrontmatter(content);
  return {
    description:
      typeof parsed.frontmatter.description === "string"
        ? parsed.frontmatter.description.trim()
        : "",
  };
}

function realDirectory(path: string): string {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Skill 路径必须是真实目录，不能使用符号链接。");
  return realpathSync(path);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve each owned directory separately so mkdir never follows a linked state root. */
export function skillRoot(scope: "user" | "project", cwd?: string, create = false): string {
  if (scope === "project" && !cwd) throw new Error("project scope requires cwd");
  const base = realpathSync(scope === "user" ? userHome() : cwd!);
  let current = base;
  for (const part of [".code-shell", "skills"]) {
    current = join(current, part);
    if (create && !existsSync(current)) mkdirSync(current, { mode: 0o700 });
    realDirectory(current);
  }
  return current;
}

/** Only a direct child of an explicitly owned skill root can be edited or removed. */
export function assertOwnedSkillDirectory(filePath: string, roots: string[]): string {
  if (basename(filePath) !== "SKILL.md") throw new Error("invalid SKILL.md path");
  const dir = dirname(resolve(filePath));
  realDirectory(dir);
  const fileInfo = lstatSync(filePath);
  if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new Error("unsafe SKILL.md file");
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // Reject links along the known .code-shell/.agents state directory as well.
    realDirectory(dirname(root));
    const canonicalRoot = realDirectory(root);
    const rel = relative(canonicalRoot, realpathSync(dir));
    if (
      rel &&
      !rel.startsWith("..") &&
      !isAbsolute(rel) &&
      !rel.includes(sep) &&
      dirname(realpathSync(filePath)) === realpathSync(dir)
    )
      return dir;
  }
  throw new Error("Skill 不在可管理的工作区技能目录中。");
}

export function readBoundedSkillFile(
  filePath: string,
  maxBytes = MAX_SKILL_MARKDOWN_BYTES,
): Buffer {
  const fd = openSync(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes)
      throw new Error("Skill 文件不是受支持的普通文件，或超过大小限制。");
    const data = readFileSync(fd);
    if (data.length > maxBytes) throw new Error("Skill 文件超过大小限制。");
    return data;
  } finally {
    closeSync(fd);
  }
}

/** Hash the full bounded bundle, including scripts/assets and provenance, for optimistic updates. */
export function readSkillBundle(directory: string): SkillBundle {
  const root = realDirectory(directory);
  const hash = createHash("sha256");
  const files: SkillBundleFile[] = [];
  let bytes = 0;
  let content: string | undefined;
  const visit = (dir: string, prefix: string, depth: number) => {
    if (depth > 16) throw new Error("Skill 目录层级过深。");
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.name === ".git") continue;
      if (entry.isSymbolicLink()) throw new Error("Skill 包含符号链接，不能直接管理。");
      const file = join(dir, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        realDirectory(file);
        visit(file, key, depth + 1);
        continue;
      }
      if (!entry.isFile()) throw new Error("Skill 包含不受支持的文件类型。");
      const data = readBoundedSkillFile(
        file,
        Math.min(10 * 1024 * 1024, MAX_SKILL_BUNDLE_BYTES - bytes),
      );
      bytes += data.length;
      if (files.length >= MAX_SKILL_BUNDLE_FILES) throw new Error("Skill 文件数超过 200 个。");
      const executable = Boolean(lstatSync(file).mode & 0o111);
      hash.update(`${key}\0${executable}\0${data.length}\0`).update(data);
      files.push({ path: key, size: data.length, executable });
      if (key === "SKILL.md") content = validateSkillMarkdown(data.toString("utf8"));
    }
  };
  visit(root, "", 0);
  if (content === undefined) throw new Error("Skill 目录缺少 SKILL.md。");
  return { revision: hash.digest("hex"), files, bytes, content };
}

function skillMutationDirectory(root: string): string {
  realDirectory(dirname(root));
  realDirectory(root);
  // This container has no SKILL.md, so scanners never expose staged or backed-up
  // bundles as installed Skills. Its parent need not be writable.
  const anchor = join(root, ".skill-mutation");
  try {
    mkdirSync(anchor, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return realDirectory(anchor);
}

/** Download/copy before locking; only bounded synchronous final swaps hold this shared lock. */
export function withSkillDirectoryLock<T>(root: string, action: () => T): T {
  const anchor = skillMutationDirectory(root);
  const release = acquireFileLock(join(anchor, "mutation"));
  try {
    return action();
  } finally {
    release();
  }
}

/** Allocate a same-filesystem stage that Skill discovery cannot see. */
export async function createSkillStageDirectory(root: string): Promise<string> {
  return fs.mkdtemp(join(skillMutationDirectory(root), ".skill-stage-"));
}

export async function stageSkillDirectory(source: string, root: string): Promise<string> {
  const bundle = readSkillBundle(source);
  const stage = await createSkillStageDirectory(root);
  try {
    for (const file of bundle.files) {
      const target = join(stage, file.path);
      await fs.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const data = readBoundedSkillFile(join(source, file.path), file.size);
      await fs.writeFile(target, data, { mode: file.executable ? 0o700 : 0o600 });
    }
    if (readSkillBundle(stage).revision !== bundle.revision)
      throw new SkillConflictError("复制期间 Skill 发生变化，请重试。");
    return stage;
  } catch (error) {
    await fs.rm(stage, { recursive: true, force: true });
    throw error;
  }
}

export function commitSkillDirectory(
  stage: string,
  root: string,
  name: string,
  expectedRevision?: string,
): InstalledSkill {
  assertSafeSkillName(name);
  const target = join(root, name);
  const stageBundle = readSkillBundle(stage);
  return withSkillDirectoryLock(root, () => {
    if (expectedRevision === undefined) {
      if (pathExists(target)) throw new SkillConflictError(`Skill「${name}」已存在。`);
    } else {
      assertOwnedSkillDirectory(join(target, "SKILL.md"), [root]);
      if (readSkillBundle(target).revision !== expectedRevision) throw new SkillConflictError();
    }
    const backup = join(skillMutationDirectory(root), `.skill-backup-${randomUUID()}`);
    let backedUp = false;
    let installed = false;
    try {
      if (expectedRevision !== undefined) {
        renameSync(target, backup);
        backedUp = true;
      }
      renameSync(stage, target);
      installed = true;
      if (readSkillBundle(target).revision !== stageBundle.revision)
        throw new Error("Skill 安装校验失败。");
    } catch (error) {
      if (backedUp) {
        rmSync(target, { recursive: true, force: true });
        renameSync(backup, target);
      } else if (installed) {
        rmSync(target, { recursive: true, force: true });
      }
      throw error;
    }
    if (backedUp) rmSync(backup, { recursive: true, force: true });
    invalidateSkillCache();
    return { name, targetDir: target, filePath: join(target, "SKILL.md") };
  });
}

export async function installSkillFromDirectory(
  sourceDir: string,
  scope: "user" | "project",
  cwd?: string,
  requestedName?: string,
): Promise<InstalledSkill> {
  const name = (requestedName || basename(sourceDir))
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  assertSafeSkillName(name);
  const root = skillRoot(scope, cwd, true);
  const stage = await stageSkillDirectory(resolve(sourceDir), root);
  try {
    return commitSkillDirectory(stage, root, name);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

export function editSkillMarkdown(
  filePath: string,
  roots: string[],
  content: string,
  expectedRevision: string,
): SkillBundle {
  validateSkillMarkdown(content);
  const dir = assertOwnedSkillDirectory(filePath, roots);
  const root = dirname(dir);
  return withSkillDirectoryLock(root, () => {
    assertOwnedSkillDirectory(filePath, roots);
    if (readSkillBundle(dir).revision !== expectedRevision) throw new SkillConflictError();
    const temporary = join(dir, `.SKILL-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, filePath);
    } finally {
      rmSync(temporary, { force: true });
    }
    invalidateSkillCache();
    return readSkillBundle(dir);
  });
}

export function removeOwnedSkill(
  filePath: string,
  roots: string[],
  expectedRevision: string,
): void {
  const dir = assertOwnedSkillDirectory(filePath, roots);
  const root = dirname(dir);
  withSkillDirectoryLock(root, () => {
    assertOwnedSkillDirectory(filePath, roots);
    if (readSkillBundle(dir).revision !== expectedRevision) throw new SkillConflictError();
    // Rename first makes discovery stop atomically and never follows an external child.
    const trash = join(skillMutationDirectory(root), `.skill-removed-${randomUUID()}`);
    renameSync(dir, trash);
    try {
      rmSync(trash, { recursive: true, force: true });
    } catch (error) {
      renameSync(trash, dir);
      throw error;
    }
    invalidateSkillCache();
  });
}
