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
  if (!raw) throw new Error("URL 不能为空");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("不是有效的 URL");
  }
  if (url.hostname !== "github.com") {
    throw new Error("当前只支持 github.com 的仓库地址");
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2) throw new Error("URL 缺少 owner/repo");
  const [owner, repoRaw, marker, ref, ...subparts] = parts;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!owner || !repo) throw new Error("URL 缺少 owner/repo");
  if (marker && marker !== "tree" && marker !== "blob") {
    throw new Error(`暂不支持 GitHub URL 类型：${marker}（仅支持仓库或 /tree/）`);
  }
  return {
    owner,
    repo,
    ref: ref || undefined,
    subpath: subparts.length > 0 ? subparts.join("/") : undefined,
  };
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
      const body = await res.text();
      throw new Error(
        /rate limit/i.test(body)
          ? "GitHub API 速率限制（每小时 60 次未鉴权请求），稍后再试"
          : `GitHub 拒绝访问（403）`,
      );
    }
    if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
    return await res.json();
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
  return (await fetchJson(
    `${GITHUB_API_BASE}/repos/${info.owner}/${info.repo}`,
    INSPECT_TIMEOUT_MS,
  )) as RepoMeta;
}

async function getRepoTree(
  info: GithubUrlInfo,
  ref: string,
): Promise<TreeResponse> {
  return (await fetchJson(
    `${GITHUB_API_BASE}/repos/${info.owner}/${info.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
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
  const res = (await fetchJson(
    `${GITHUB_API_BASE}/repos/${info.owner}/${info.repo}/commits/${encodeURIComponent(ref)}`,
    INSPECT_TIMEOUT_MS,
  )) as CommitResponse;
  if (!res || typeof res.sha !== "string" || !res.sha) {
    throw new Error("GitHub commits 响应缺少 sha");
  }
  return res.sha;
}

async function getRawFile(
  info: GithubUrlInfo,
  ref: string,
  pathInRepo: string,
): Promise<string> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), INSPECT_TIMEOUT_MS);
  try {
    const res = await fetch(
      `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${encodeURIComponent(ref)}/${pathInRepo}`,
      { headers: { "User-Agent": USER_AGENT }, signal: controller.signal },
    );
    if (!res.ok) throw new Error(`raw fetch ${res.status} ${res.statusText}`);
    return await res.text();
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
    if (k === "name") out.name = v;
    else if (k === "description") out.description = v;
  }
  return out;
}

export async function inspectRepo(
  rawUrl: string,
  existingNames: string[] = [],
): Promise<RepoInspection> {
  const info = parseGithubUrl(rawUrl);
  const meta = await getRepoMeta(info);
  const ref = info.ref || meta.default_branch;
  const tree = await getRepoTree(info, ref);

  const skillBlobs = tree.tree.filter(
    (n) =>
      n.type === "blob" &&
      n.path.endsWith("SKILL.md") &&
      (!info.subpath || n.path.startsWith(info.subpath.replace(/\/$/, "") + "/") || n.path === info.subpath),
  );

  const isPlugin = tree.tree.some((n) => n.type === "blob" && n.path === "plugin.json");

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
  const tree = await getRepoTree(info, ref);
  const prefix = dirInRepo.replace(/\/$/, "") + "/";
  const files = tree.tree.filter(
    (n) => n.type === "blob" && (n.path === dirInRepo || n.path.startsWith(prefix)),
  );
  if (files.length === 0) throw new Error(`目录在仓库中为空：${dirInRepo}`);

  // Cap to avoid pulling unbounded payloads.
  const MAX_FILES = 200;
  if (files.length > MAX_FILES) {
    throw new Error(`skill 目录文件数 (${files.length}) 超过限制 ${MAX_FILES}`);
  }

  for (const f of files) {
    const relPath = f.path === dirInRepo ? path.basename(f.path) : f.path.slice(prefix.length);
    if (relPath.includes("..")) throw new Error(`拒绝下载越界路径：${f.path}`);
    const localPath = path.join(destDir, relPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://raw.githubusercontent.com/${info.owner}/${info.repo}/${encodeURIComponent(ref)}/${f.path}`,
        { headers: { "User-Agent": USER_AGENT }, signal: controller.signal },
      );
      if (!res.ok) throw new Error(`raw fetch ${res.status} ${res.statusText} for ${f.path}`);
      const buf = Buffer.from(await res.arrayBuffer());
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
  const ref = inspection.url.ref || inspection.defaultBranch;
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codeshell-gh-skill-"));
  try {
    await downloadSkillTree(inspection.url, ref, selected.dirInRepo, tmpRoot);
    try {
      await fs.access(path.join(tmpRoot, "SKILL.md"));
    } catch {
      throw new Error(`下载结果缺少 SKILL.md：${selected.dirInRepo}`);
    }
    const installed = await installSkillFromDirectory(
      tmpRoot,
      scope,
      cwd,
      installName || selected.name,
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
        dirInRepo: selected.dirInRepo,
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
    raw = await fs.readFile(metaPath, "utf8");
  } catch {
    return { filePath, updateAvailable: false, reason: "no source metadata" };
  }

  let meta: SkillSourceMeta;
  try {
    meta = JSON.parse(raw) as SkillSourceMeta;
  } catch {
    return { filePath, updateAvailable: false, reason: "no source metadata" };
  }

  if (!meta || meta.kind !== "github") {
    return { filePath, updateAvailable: false, reason: "not a github source" };
  }

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
    raw = await fs.readFile(metaPath, "utf8");
  } catch {
    return { updated: false, reason: "no source metadata" };
  }

  let meta: SkillSourceMeta;
  try {
    meta = JSON.parse(raw) as SkillSourceMeta;
  } catch {
    return { updated: false, reason: "no source metadata" };
  }

  if (!meta || meta.kind !== "github") {
    return { updated: false, reason: "not a github skill" };
  }

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
