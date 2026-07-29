/**
 * 已注册的数字人仓库：注册表 + 克隆缓存 + 读取。
 *
 * 与插件市场并列的一等分发通道。数字人不必先成为插件——它有自己的定义格式和
 * 导入/导出原语，仓库只是把「一批定义」打包分发。
 *
 * 磁盘布局：
 *   ~/.code-shell/human-repos.json        —— 注册表（owner/repo 列表）
 *   ~/.code-shell/human-repos/<key>/      —— 各仓库的浅克隆
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "../session/session-manager.js";
import { gitClone, gitFetchAndReset, githubRepoToCloneUrl } from "../plugins/gitOps.js";
import {
  CATALOG_REPO_RE,
  readCatalogFromDir,
  sourceToRepoKey,
  type CatalogEntry,
  type CatalogTeam,
} from "./catalog.js";

export interface RegisteredHumanRepo {
  /** `owner/repo` */
  repo: string;
  addedAt: number;
}

export interface HumanRepoListEntry extends RegisteredHumanRepo {
  /** 该仓库当前提供的数字人数量。 */
  count: number;
  /** 读取过程中的问题（坏定义、缺 manifest）。 */
  errors: string[];
  cloned: boolean;
}

const MAX_REPOS = 32;

export function humanReposRoot(): string {
  return join(codeShellHome(), "human-repos");
}

function registryPath(): string {
  return join(codeShellHome(), "human-repos.json");
}

export function humanRepoDir(repo: string): string {
  return join(humanReposRoot(), sourceToRepoKey(repo));
}

export function listHumanRepos(): RegisteredHumanRepo[] {
  try {
    const parsed = JSON.parse(readFileSync(registryPath(), "utf-8")) as { repos?: unknown };
    if (!Array.isArray(parsed.repos)) return [];
    return parsed.repos
      .filter(
        (r): r is RegisteredHumanRepo =>
          !!r &&
          typeof r === "object" &&
          typeof (r as RegisteredHumanRepo).repo === "string" &&
          CATALOG_REPO_RE.test((r as RegisteredHumanRepo).repo),
      )
      .map((r) => ({ repo: r.repo, addedAt: Number(r.addedAt) || 0 }));
  } catch {
    // Missing or corrupt registry reads as "no repos" — never fatal.
    return [];
  }
}

function writeRegistry(repos: RegisteredHumanRepo[]): void {
  mkdirSync(codeShellHome(), { recursive: true });
  writeFileSync(registryPath(), `${JSON.stringify({ repos }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * 注册并克隆一个数字人仓库。已存在则拉取更新。
 *
 * 克隆是网络+磁盘写入操作，调用方应已取得用户确认。
 */
export async function addHumanRepo(
  repo: string,
): Promise<{ ok: true; entry: HumanRepoListEntry } | { ok: false; error: string }> {
  if (!CATALOG_REPO_RE.test(repo)) {
    return { ok: false, error: `"${repo}" 不是合法的仓库地址（应为 owner/repo）` };
  }
  const existing = listHumanRepos();
  if (existing.length >= MAX_REPOS && !existing.some((r) => r.repo === repo)) {
    return { ok: false, error: `最多只能添加 ${MAX_REPOS} 个数字人仓库` };
  }

  const dir = humanRepoDir(repo);
  mkdirSync(humanReposRoot(), { recursive: true });

  if (existsSync(dir)) {
    const refreshed = await gitFetchAndReset(dir);
    if (!refreshed.ok) return { ok: false, error: explainGitFailure(refreshed.error, repo) };
  } else {
    // Full checkout: unlike a plugin marketplace (manifest-only up front) we
    // read every humans/<name>/profile.json right away.
    const cloned = await gitClone(githubRepoToCloneUrl(repo), dir, { full: true });
    if (!cloned.ok) {
      rmSync(dir, { recursive: true, force: true });
      return { ok: false, error: explainGitFailure(cloned.error, repo) };
    }
  }

  const read = readCatalogFromDir(dir, repo);
  if (read.entries.length === 0 && read.errors.length > 0) {
    // A repo that yields nothing usable is a mistake worth surfacing now
    // rather than leaving an empty row in the list.
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: read.errors[0] };
  }

  const next = existing.filter((r) => r.repo !== repo);
  next.push({ repo, addedAt: Date.now() });
  writeRegistry(next);

  return {
    ok: true,
    entry: {
      repo,
      addedAt: Date.now(),
      count: read.entries.length,
      errors: read.errors,
      cloned: true,
    },
  };
}

/**
 * Turn a raw git failure into something a user can act on.
 *
 * gitOps deliberately returns the full command line (`git clone --depth 1
 * --filter=blob:none … exited 128: …`) because it serves low-level callers.
 * Pasting that into an "add a repo" box tells the user nothing about the actual
 * problem — usually just a typo in the name.
 */
function explainGitFailure(error: string, repo: string): string {
  if (/repository not found|could not read from remote|remote: not found/i.test(error)) {
    return `找不到仓库 ${repo}。请检查拼写，并确认它是公开仓库。`;
  }
  if (/authentication failed|permission denied|terminal prompts disabled/i.test(error)) {
    return `无权访问 ${repo}。私有仓库需要先配置 git 凭据。`;
  }
  if (/could not resolve host|network is unreachable|timed out|operation timed out/i.test(error)) {
    return `无法连接 GitHub，请检查网络后重试。`;
  }
  if (error.startsWith("GIT_NOT_FOUND")) {
    // Already a written, actionable message from gitOps.
    return error;
  }
  // Unrecognized: keep the tail (the actual stderr) and drop the command line,
  // so the user sees the cause rather than our argv.
  const tail = error.includes(": ") ? error.slice(error.lastIndexOf(": ") + 2) : error;
  return `克隆 ${repo} 失败：${tail.trim() || "未知错误"}`;
}

export function removeHumanRepo(repo: string): void {
  if (!CATALOG_REPO_RE.test(repo)) throw new Error("invalid digital-human repo");
  writeRegistry(listHumanRepos().filter((r) => r.repo !== repo));
  rmSync(humanRepoDir(repo), { recursive: true, force: true });
}

/** 注册表 + 每个仓库的读取结果，供设置页展示。 */
export function listHumanRepoDetails(): HumanRepoListEntry[] {
  return listHumanRepos().map((registered) => {
    const dir = humanRepoDir(registered.repo);
    if (!existsSync(dir)) {
      return { ...registered, count: 0, errors: ["尚未克隆"], cloned: false };
    }
    const read = readCatalogFromDir(dir, registered.repo);
    return { ...registered, count: read.entries.length, errors: read.errors, cloned: true };
  });
}

/**
 * 所有已注册仓库提供的数字人。
 *
 * 同名定义按注册顺序先到先得，并记一条冲突说明——静默覆盖会让用户以为装的是
 * 另一个仓库的版本。
 */
export function readAllHumanRepoEntries(): {
  entries: CatalogEntry[];
  teams: CatalogTeam[];
  errors: string[];
} {
  const entries: CatalogEntry[] = [];
  const teams: CatalogTeam[] = [];
  const errors: string[] = [];
  const seen = new Map<string, string>();
  const seenTeams = new Map<string, string>();
  for (const { repo } of listHumanRepos()) {
    const dir = humanRepoDir(repo);
    if (!existsSync(dir)) continue;
    const read = readCatalogFromDir(dir, repo);
    errors.push(...read.errors);
    for (const entry of read.entries) {
      const owner = seen.get(entry.profile.name);
      if (owner) {
        errors.push(`"${entry.profile.name}" 同时存在于 ${owner} 与 ${repo}，已采用前者`);
        continue;
      }
      seen.set(entry.profile.name, repo);
      entries.push(entry);
    }
    for (const team of read.teams) {
      const owner = seenTeams.get(team.id);
      if (owner) {
        errors.push(`团队 "${team.id}" 同时存在于 ${owner} 与 ${repo}，已采用前者`);
        continue;
      }
      seenTeams.set(team.id, repo);
      teams.push(team);
    }
  }
  return { entries, teams, errors };
}
