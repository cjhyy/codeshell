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
async function downloadSkillTree(
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
    return await installSkillFromDirectory(tmpRoot, scope, cwd, installName || selected.name);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
