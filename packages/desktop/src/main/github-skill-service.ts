/**
 * GitHub skill installer — pastes a GitHub URL, returns a preview of
 * skills detected in the repo, then installs the selected one.
 *
 * Flow:
 *   1. parseGithubUrl: accept https://github.com/<owner>/<repo>[/tree/<ref>/<subpath>]
 *   2. inspectRepo: list the repo tree, find SKILL.md files, parse the
 *      frontmatter (name, description) to produce a preview.
 *   3. installFromGithub: download the tarball for the chosen ref, find
 *      the right SKILL.md, hand off to installSkillFromDirectory.
 *
 * The renderer always sees inspect → preview → confirm → install. The
 * main process never auto-installs based on URL parse alone.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  installSkillFromDirectory,
  type InstalledSkill,
} from "./skills-service.js";
import { dlog } from "./desktop-logger.js";

export interface GithubUrlInfo {
  owner: string;
  repo: string;
  /** Branch / tag / commit ref (e.g. main). undefined → repo default. */
  ref?: string;
  /** Optional subpath the user pointed at (when using /tree/<ref>/<subpath>). */
  subpath?: string;
}

export interface DetectedSkill {
  /** Skill name from SKILL.md frontmatter (or folder name as fallback). */
  name: string;
  description: string;
  /** Path of the SKILL.md inside the repo, e.g. "skills/foo/SKILL.md". */
  pathInRepo: string;
  /** Folder containing SKILL.md, e.g. "skills/foo". */
  dirInRepo: string;
  /** True when an installed skill with this folder name already exists. */
  alreadyInstalled?: boolean;
}

export interface RepoInspection {
  url: GithubUrlInfo;
  /** Repo default branch (used as ref if URL didn't pin one). */
  defaultBranch: string;
  skills: DetectedSkill[];
  /** Heuristic: looks like a Claude Code plugin (plugin.json at root). */
  isPlugin: boolean;
  /** Total SKILL.md files seen across the tree. */
  totalDetected: number;
  /** Hint text to surface in the UI when nothing was found. */
  warning?: string;
}

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "code-shell-desktop";
const INSPECT_TIMEOUT_MS = 15_000;
const INSTALL_TIMEOUT_MS = 60_000;
const MAX_API_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_SKILL_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SKILL_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FRONTMATTER_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_META_BYTES = 64 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

/** Filename of the source-meta sidecar written next to an installed SKILL.md. */
export const SKILL_META_FILE = ".cs-skill-meta.json";

/**
 * Source provenance recorded next to a GitHub-installed SKILL.md so the skill
 * can be update-checked later. Locally-installed skills (plain directory) get
 * no sidecar and are therefore not update-checkable — by design.
 */
export interface SkillSourceMeta {
  kind: "github";
  owner: string;
  repo: string;
  /** Concrete ref used at install (inspection.url.ref || defaultBranch). */
  ref: string;
  /** Path of SKILL.md (or its dir) in the repo, e.g. "skills/foo". */
  dirInRepo: string;
  /** Commit sha of `ref` at install time. */
  commit: string;
  installedAt: string;
}

export interface SkillUpdateCheck {
  filePath: string;
  updateAvailable: boolean;
  currentCommit?: string;
  latestCommit?: string;
  reason?: string;
}

export function parseGithubUrl(raw: string): GithubUrlInfo {
  if (!raw || raw.length > 8_192 || raw.includes("\0")) throw new Error("URL 不能为空或过长");
  // WHATWG URL parsing normalizes literal and percent-encoded dot segments
  // before exposing pathname, so reject them from the original input first.
  if (/(?:^|\/)(?:\.|%2e){1,2}(?:\/|$|[?#])/i.test(raw.trim())) {
    throw new Error("GitHub URL 路径包含越界片段");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("不是有效的 URL");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password
  ) {
    throw new Error("当前只支持 github.com 的仓库地址");
  }
  let parts: string[];
  try {
    parts = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .map((part) => decodeURIComponent(part));
  } catch {
    throw new Error("GitHub URL 路径编码无效");
  }
  if (parts.length < 2) throw new Error("URL 缺少 owner/repo");
  const [owner, repoRaw, marker, ref, ...subparts] = parts;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!owner || !repo) throw new Error("URL 缺少 owner/repo");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)) {
    throw new Error("GitHub owner 格式无效");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) throw new Error("GitHub repo 格式无效");
  if (marker && marker !== "tree" && marker !== "blob") {
    throw new Error(`暂不支持 GitHub URL 类型：${marker}（仅支持仓库或 /tree/）`);
  }
  const subpath = subparts.length > 0 ? subparts.join("/") : undefined;
  if (ref && (ref.length > 512 || ref.includes("\0"))) throw new Error("GitHub ref 过长");
  if (subpath && (!safeRepoPath(subpath) || subpath.length > 4_096)) {
    throw new Error("GitHub 子路径无效");
  }
  return {
    owner,
    repo,
    ref: ref || undefined,
    subpath,
  };
}

function safeRepoPath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("\\") || value.includes("\0")) {
    return false;
  }
  return value.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

function assertGithubInfo(info: GithubUrlInfo, ref?: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(info.owner)) {
    throw new Error("invalid GitHub owner");
  }
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(info.repo)) throw new Error("invalid GitHub repo");
  if (ref !== undefined && (!ref || ref.length > 512 || ref.includes("\0"))) {
    throw new Error("invalid GitHub ref");
  }
}

function parseSkillSourceMeta(value: unknown): SkillSourceMeta | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.kind !== "github" ||
    typeof raw.owner !== "string" ||
    typeof raw.repo !== "string" ||
    typeof raw.ref !== "string" ||
    typeof raw.dirInRepo !== "string" ||
    typeof raw.commit !== "string" ||
    !raw.commit ||
    raw.commit.length > 128 ||
    raw.commit.includes("\0") ||
    typeof raw.installedAt !== "string" ||
    raw.installedAt.length > 128 ||
    !safeRepoPath(raw.dirInRepo) ||
    raw.dirInRepo.length > 4_096
  ) {
    return null;
  }
  try {
    assertGithubInfo({ owner: raw.owner, repo: raw.repo }, raw.ref);
  } catch {
    return null;
  }
  return {
    kind: "github",
    owner: raw.owner,
    repo: raw.repo,
    ref: raw.ref,
    dirInRepo: raw.dirInRepo,
    commit: raw.commit,
    installedAt: raw.installedAt,
  };
}

function isTreeNode(value: unknown): value is TreeNode {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const node = value as Record<string, unknown>;
  return (
    typeof node.path === "string" &&
    node.path.length <= 4_096 &&
    safeRepoPath(node.path) &&
    (node.type === "blob" || node.type === "tree" || node.type === "commit") &&
    typeof node.sha === "string" &&
    node.sha.length <= 128
  );
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<Buffer> {
  const declared = response.headers.get("content-length");
  if (declared) {
    const size = Number(declared);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
    }
  }
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`${label} exceeds the size limit`);
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("file exceeds the size limit");
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    if (res.status === 404) throw new Error("找不到仓库（404）");
    if (res.status === 403) {
      const body = (
        await readBoundedResponse(res, MAX_ERROR_RESPONSE_BYTES, "GitHub error response")
      ).toString("utf8");
      throw new Error(
        /rate limit/i.test(body)
          ? "GitHub API 速率限制（每小时 60 次未鉴权请求），稍后再试"
          : `GitHub 拒绝访问（403）`,
      );
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
    return JSON.parse(
      (await readBoundedResponse(res, MAX_API_RESPONSE_BYTES, "GitHub API response")).toString(
        "utf8",
      ),
    ) as unknown;
  } finally {
    clearTimeout(t);
  }
}

interface RepoMeta {
  default_branch: string;
}

interface TreeNode {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
}

interface TreeResponse {
  sha: string;
  tree: TreeNode[];
  truncated?: boolean;
}

async function getRepoMeta(info: GithubUrlInfo): Promise<RepoMeta> {
  assertGithubInfo(info);
  return (await fetchJson(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}`,
    INSPECT_TIMEOUT_MS,
  )) as RepoMeta;
}

async function getRepoTree(
  info: GithubUrlInfo,
  ref: string,
): Promise<TreeResponse> {
  assertGithubInfo(info, ref);
  return (await fetchJson(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    INSPECT_TIMEOUT_MS,
  )) as TreeResponse;
}

interface CommitResponse {
  sha: string;
}

/**
 * Resolve the current commit sha that `ref` points at. Uses the commits
 * endpoint, which returns `{ sha, ... }` for the tip commit of a branch/tag
 * (or the commit itself when ref is already a sha).
 */
export async function getRefCommit(
  info: GithubUrlInfo,
  ref: string,
): Promise<string> {
  assertGithubInfo(info, ref);
  const res = (await fetchJson(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/commits/${encodeURIComponent(ref)}`,
    INSPECT_TIMEOUT_MS,
  )) as CommitResponse;
  if (!res || typeof res.sha !== "string" || !res.sha || res.sha.length > 128) {
    throw new Error("GitHub commits 响应缺少 sha");
  }
  return res.sha;
}

async function getRawFile(
  info: GithubUrlInfo,
  ref: string,
  pathInRepo: string,
): Promise<string> {
  assertGithubInfo(info, ref);
  if (!safeRepoPath(pathInRepo) || pathInRepo.length > 4_096) {
    throw new Error("invalid GitHub file path");
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), INSPECT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/${encodeURIComponent(ref)}/${pathInRepo
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`,
      { headers: { "User-Agent": USER_AGENT }, signal: controller.signal },
    );
    if (!res.ok) throw new Error(`raw fetch ${res.status} ${res.statusText}`);
    return (await readBoundedResponse(res, MAX_FRONTMATTER_FILE_BYTES, "SKILL.md preview")).toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
}

function parseFrontmatter(md: string): ParsedFrontmatter {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: ParsedFrontmatter = {};
  for (const line of m[1].split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const k = trimmed.slice(0, colon).trim();
    let v = trimmed.slice(colon + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k === "name") out.name = v.slice(0, 512);
    else if (k === "description") out.description = v.slice(0, 4_096);
  }
  return out;
}

export async function inspectRepo(
  rawUrl: string,
  existingNames: string[] = [],
): Promise<RepoInspection> {
  const info = parseGithubUrl(rawUrl);
  const meta = await getRepoMeta(info);
  if (!meta || typeof meta.default_branch !== "string" || !meta.default_branch || meta.default_branch.length > 512) {
    throw new Error("GitHub repository response has an invalid default branch");
  }
  const ref = info.ref || meta.default_branch;
  const tree = await getRepoTree(info, ref);
  if (!tree || !Array.isArray(tree.tree)) throw new Error("GitHub tree response is invalid");
  const nodes = tree.tree.filter(isTreeNode);

  const skillBlobs = nodes.filter(
    (n) =>
      n.type === "blob" &&
      n.path.endsWith("SKILL.md") &&
      (!info.subpath || n.path.startsWith(info.subpath.replace(/\/$/, "") + "/") || n.path === info.subpath),
  );

  const isPlugin = nodes.some((n) => n.type === "blob" && n.path === "plugin.json");

  // Limit how many frontmatter fetches we issue (rate limit).
  const MAX_DETAILED = 25;
  const subset = skillBlobs.slice(0, MAX_DETAILED);
  const detailed = await Promise.all(
    subset.map(async (blob) => {
      const dir = blob.path.replace(/\/SKILL\.md$/, "");
      let parsed: ParsedFrontmatter = {};
      try {
        const text = await getRawFile(info, ref, blob.path);
        parsed = parseFrontmatter(text);
      } catch (e) {
        dlog("main", "github-skill-inspect-failed", {
          path: blob.path,
          error: (e as Error).message,
        });
      }
      const folderName = dir.split("/").pop() ?? "skill";
      const name = parsed.name || folderName;
      return {
        name,
        description: parsed.description ?? "",
        pathInRepo: blob.path,
        dirInRepo: dir,
        alreadyInstalled: existingNames.includes(name) || existingNames.includes(folderName),
      } satisfies DetectedSkill;
    }),
  );

  let warning: string | undefined;
  if (skillBlobs.length === 0) {
    warning = info.subpath
      ? `在 ${info.subpath} 下没有找到 SKILL.md`
      : "仓库里没有找到 SKILL.md。如果是 plugin 仓库，请进入子目录后再试。";
  } else if (skillBlobs.length > MAX_DETAILED) {
    warning = `仓库内共发现 ${skillBlobs.length} 个 SKILL.md，仅展示前 ${MAX_DETAILED} 个详情。`;
  }
  if (tree.truncated) {
    warning = (warning ? warning + " " : "") + "仓库太大，目录树未完整返回。";
  }

  return {
    url: info,
    defaultBranch: meta.default_branch,
    skills: detailed,
    isPlugin,
    totalDetected: skillBlobs.length,
    warning,
  };
}

// ─── install ───────────────────────────────────────────────────────────────

/**
 * Download every blob under `dirInRepo` (recursively) to a local directory.
 * We use the GitHub git/trees API to enumerate, then raw.githubusercontent
 * for each file. This avoids a tarball dependency and only pulls the files
 * we actually need (good when the source is a monorepo).
 */
export async function downloadSkillTree(
  info: GithubUrlInfo,
  ref: string,
  dirInRepo: string,
  destDir: string,
): Promise<void> {
  assertGithubInfo(info, ref);
  if (!safeRepoPath(dirInRepo) || dirInRepo.length > 4_096) {
    throw new Error("invalid skill directory path");
  }
  const tree = await getRepoTree(info, ref);
  if (!tree || !Array.isArray(tree.tree)) throw new Error("GitHub tree response is invalid");
  const nodes = tree.tree.filter(isTreeNode);
  const prefix = dirInRepo.replace(/\/$/, "") + "/";
  const files = nodes.filter(
    (n) => n.type === "blob" && (n.path === dirInRepo || n.path.startsWith(prefix)),
  );
  if (files.length === 0) throw new Error(`目录在仓库中为空：${dirInRepo}`);

  // Cap to avoid pulling unbounded payloads.
  const MAX_FILES = 200;
  if (files.length > MAX_FILES) {
    throw new Error(`skill 目录文件数 (${files.length}) 超过限制 ${MAX_FILES}`);
  }

  let downloadedBytes = 0;
  for (const f of files) {
    const relPath = f.path === dirInRepo ? path.basename(f.path) : f.path.slice(prefix.length);
    if (!safeRepoPath(relPath)) throw new Error(`拒绝下载越界路径：${f.path}`);
    const localPath = path.join(destDir, relPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/${encodeURIComponent(ref)}/${f.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`,
        { headers: { "User-Agent": USER_AGENT }, signal: controller.signal },
      );
      if (!res.ok) throw new Error(`raw fetch ${res.status} ${res.statusText} for ${f.path}`);
      const remaining = MAX_SKILL_TOTAL_BYTES - downloadedBytes;
      if (remaining <= 0) throw new Error("skill download exceeds the total size limit");
      const buf = await readBoundedResponse(
        res,
        Math.min(MAX_SKILL_FILE_BYTES, remaining),
        `skill file ${f.path}`,
      );
      downloadedBytes += buf.byteLength;
      await fs.writeFile(localPath, buf);
    } finally {
      clearTimeout(t);
    }
  }
}

export interface InstallFromGithubInput {
  /** Inspection result for the URL the user pasted. */
  inspection: RepoInspection;
  /** Skill the user chose from the preview list (must exist in inspection.skills). */
  selected: DetectedSkill;
  scope: "user" | "project";
  cwd?: string;
  /** Optional override for the installed folder name (after frontmatter). */
  installName?: string;
}

export async function installFromGithub(
  input: InstallFromGithubInput,
): Promise<InstalledSkill> {
  const { inspection, selected, scope, cwd, installName } = input;
  const reviewedSelection = inspection.skills.find(
    (candidate) =>
      candidate.name === selected.name &&
      candidate.pathInRepo === selected.pathInRepo &&
      candidate.dirInRepo === selected.dirInRepo,
  );
  if (!reviewedSelection) {
    throw new Error("selected skill was not part of the inspected repository preview");
  }
  const ref = inspection.url.ref || inspection.defaultBranch;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeshell-gh-skill-"));
  try {
    await downloadSkillTree(inspection.url, ref, reviewedSelection.dirInRepo, tmpRoot);
    try {
      await fs.access(path.join(tmpRoot, "SKILL.md"));
    } catch {
      throw new Error(`下载结果缺少 SKILL.md：${reviewedSelection.dirInRepo}`);
    }
    const installed = await installSkillFromDirectory(
      tmpRoot,
      scope,
      cwd,
      installName || reviewedSelection.name,
    );

    // Record source provenance so the skill is update-checkable later. A
    // failure to resolve the commit sha must NOT fail the install — we just
    // skip the sidecar (the skill still installs; it just won't be
    // update-checkable).
    try {
      const commit = await getRefCommit(inspection.url, ref);
      const meta: SkillSourceMeta = {
        kind: "github",
        owner: inspection.url.owner,
        repo: inspection.url.repo,
        ref,
        dirInRepo: reviewedSelection.dirInRepo,
        commit,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(path.dirname(installed.filePath), SKILL_META_FILE),
        JSON.stringify(meta, null, 2),
        "utf8",
      );
    } catch (e) {
      dlog("main", "github-skill-meta-write-failed", {
        name: installed.name,
        error: (e as Error).message,
      });
    }

    return installed;
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ─── update check ────────────────────────────────────────────────────────────

/**
 * Check whether a GitHub-sourced skill has a newer commit upstream, WITHOUT
 * re-downloading. Reads the `.cs-skill-meta.json` sidecar next to the given
 * SKILL.md and compares the recorded install commit against the ref's current
 * tip. Locally-installed skills (no sidecar), unreadable/foreign sidecars, and
 * fetch failures all resolve to `updateAvailable: false` with an explanatory
 * `reason` rather than throwing.
 */
export async function checkSkillUpdate(
  filePath: string,
): Promise<SkillUpdateCheck> {
  const metaPath = path.join(path.dirname(filePath), SKILL_META_FILE);

  let raw: string;
  try {
    raw = await readBoundedFile(metaPath, MAX_SOURCE_META_BYTES);
  } catch {
    return { filePath, updateAvailable: false, reason: "no source metadata" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { filePath, updateAvailable: false, reason: "no source metadata" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { filePath, updateAvailable: false, reason: "no source metadata" };
  }
  if ((parsed as Record<string, unknown>).kind !== "github") {
    return { filePath, updateAvailable: false, reason: "not a github source" };
  }
  const meta = parseSkillSourceMeta(parsed);
  if (!meta) return { filePath, updateAvailable: false, reason: "invalid source metadata" };

  let latest: string;
  try {
    latest = await getRefCommit(
      { owner: meta.owner, repo: meta.repo, ref: meta.ref },
      meta.ref,
    );
  } catch (e) {
    return {
      filePath,
      updateAvailable: false,
      currentCommit: meta.commit,
      reason: String((e as Error)?.message ?? e),
    };
  }

  const updateAvailable = latest.toLowerCase() !== meta.commit.toLowerCase();
  return {
    filePath,
    updateAvailable,
    currentCommit: meta.commit,
    latestCommit: latest,
  };
}

// ─── update (apply) ──────────────────────────────────────────────────────────

export interface SkillUpdateResult {
  updated: boolean;
  reason: string;
}

/**
 * Seam for testing: the two network calls `updateSkillFromSource` makes. Tests
 * inject canned implementations so the atomic-replace + rollback + sidecar
 * rewrite logic can be exercised without touching the network. Production
 * passes the real `getRefCommit` / `downloadSkillTree`.
 */
export interface SkillUpdateDeps {
  getRefCommit: (info: GithubUrlInfo, ref: string) => Promise<string>;
  downloadSkillTree: (
    info: GithubUrlInfo,
    ref: string,
    dirInRepo: string,
    destDir: string,
  ) => Promise<void>;
}

const defaultUpdateDeps: SkillUpdateDeps = { getRefCommit, downloadSkillTree };

/**
 * Re-download a GitHub-sourced skill and atomically replace it on disk. Mirrors
 * the plugin updater (core/plugins/installer/update.ts → reinstallAtomic): a
 * failed update leaves the OLD skill (and its sidecar) intact.
 *
 * Flow:
 *   1. Read `.cs-skill-meta.json` next to the SKILL.md. Missing / non-github →
 *      `{ updated:false }` with a reason (no throw).
 *   2. Resolve the ref's current tip. If it equals the recorded commit
 *      (case-insensitive) → `{ updated:false, reason:"already up to date" }`,
 *      skipping the download entirely.
 *   3. Otherwise download the subtree to a fresh tmp dir, verify SKILL.md, then
 *      atomically swap: rename the live dir to a sibling `.bak-<pid>` backup,
 *      copy the download into place, write a fresh sidecar with the new commit.
 *      On any failure: drop the partial dir, restore the backup, rethrow noting
 *      the old version was kept. The tmp download dir is always removed.
 *
 * Async fs only (runs in the Electron main process). process.pid (not
 * Date.now(), unavailable here) makes the backup name unique.
 */
export async function updateSkillFromSource(
  filePath: string,
  deps: SkillUpdateDeps = defaultUpdateDeps,
): Promise<SkillUpdateResult> {
  const dir = path.dirname(filePath);
  const metaPath = path.join(dir, SKILL_META_FILE);

  let raw: string;
  try {
    raw = await readBoundedFile(metaPath, MAX_SOURCE_META_BYTES);
  } catch {
    return { updated: false, reason: "no source metadata" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { updated: false, reason: "no source metadata" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { updated: false, reason: "no source metadata" };
  }
  if ((parsed as Record<string, unknown>).kind !== "github") {
    return { updated: false, reason: "not a github skill" };
  }
  const meta = parseSkillSourceMeta(parsed);
  if (!meta) return { updated: false, reason: "invalid source metadata" };

  const info: GithubUrlInfo = { owner: meta.owner, repo: meta.repo, ref: meta.ref };

  const latest = await deps.getRefCommit(info, meta.ref);
  if (latest.toLowerCase() === meta.commit.toLowerCase()) {
    return { updated: false, reason: "already up to date" };
  }

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeshell-gh-skill-upd-"));
  try {
    await deps.downloadSkillTree(info, meta.ref, meta.dirInRepo, tmpRoot);
    try {
      await fs.access(path.join(tmpRoot, "SKILL.md"));
    } catch {
      throw new Error(`下载结果缺少 SKILL.md：${meta.dirInRepo}`);
    }

    const backup = `${dir}.bak-${process.pid}`;
    await fs.rm(backup, { recursive: true, force: true });
    await fs.rename(dir, backup);

    try {
      await fs.cp(tmpRoot, dir, {
        recursive: true,
        filter: (src) => !path.basename(src).startsWith(".git"),
      });
      const nextMeta: SkillSourceMeta = {
        kind: "github",
        owner: meta.owner,
        repo: meta.repo,
        ref: meta.ref,
        dirInRepo: meta.dirInRepo,
        commit: latest,
        installedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(dir, SKILL_META_FILE),
        JSON.stringify(nextMeta, null, 2),
        "utf8",
      );
    } catch (err) {
      // Roll back: drop the partial new dir, restore the backup verbatim.
      await fs.rm(dir, { recursive: true, force: true });
      await fs.rename(backup, dir);
      throw new Error(
        `更新失败，已保留(restored/kept)旧版本：${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }

    // Success — drop the backup (best-effort).
    await fs.rm(backup, { recursive: true, force: true });
    return { updated: true, reason: "updated" };
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
