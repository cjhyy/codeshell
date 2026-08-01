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
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { codeShellHome } from "../session/session-manager.js";
import { mutateJsonFile } from "../utils/file-mutex.js";
// gitFetchAndReset is deliberately NOT used any more: updating in place is what
// destroyed the last-known-good tree on a bad upstream commit. Updates clone to
// a staging dir and swap (see addHumanRepo).
import { gitClone, githubRepoToCloneUrl } from "../plugins/gitOps.js";
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
    // Missing or corrupt registry reads as "no repos" — never fatal.
    return parseRegistry(readFileSync(registryPath(), "utf-8"));
  } catch {
    return [];
  }
}

function parseRegistry(raw: string | undefined): RegisteredHumanRepo[] {
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as { repos?: unknown };
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
    return [];
  }
}

/**
 * Read-modify-write the registry under a cross-process lock.
 *
 * add/remove used to be `listHumanRepos()` in the caller followed by a bare
 * `writeFileSync` of the whole array. Two windows (or a window plus an agent)
 * mutating different repos would each write back their own stale snapshot, so
 * one of the entries silently disappeared. The single-window UI operation lock
 * did not help, because it does not span processes.
 */
function updateRegistry(
  change: (repos: RegisteredHumanRepo[]) => RegisteredHumanRepo[],
): void {
  mkdirSync(codeShellHome(), { recursive: true });
  mutateJsonFile<RegisteredHumanRepo[]>(registryPath(), {
    parse: parseRegistry,
    serialize: (repos) => `${JSON.stringify({ repos }, null, 2)}\n`,
    mutation: (current) => ({ value: change(current) }),
    mode: 0o600,
  });
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
  const isUpdate = existsSync(dir);

  if (isUpdate) {
    // UPDATE PATH — validate in a staging clone, then swap.
    //
    // This used to `gitFetchAndReset(dir)` in place and validate afterwards. If
    // the new upstream commit invalidated every definition, the code then
    // `rmSync`ed the clone and returned early WITHOUT touching the registry —
    // so the repo stayed registered, its working copy was gone ("尚未克隆" in
    // the UI), and the previously-good version was unrecoverable. A failed
    // update must leave the last known good tree exactly as it was.
    const staging = `${dir}.staging-${process.pid}-${randomUUID()}`;
    try {
      const cloned = await gitClone(githubRepoToCloneUrl(repo), staging, { full: true });
      if (!cloned.ok) {
        return { ok: false, error: explainGitFailure(cloned.error, repo) };
      }
      const staged = readCatalogFromDir(staging, repo);
      if (staged.entries.length === 0 && staged.errors.length > 0) {
        // Keep serving the old tree and report why the update was rejected.
        return {
          ok: false,
          error: `更新 ${repo} 失败，已保留上一个可用版本：${staged.errors[0]}`,
        };
      }

      // Swap: move the old tree aside, promote staging, then drop the old one.
      // Renames are atomic within the same filesystem, so a crash mid-swap
      // leaves either the old or the new tree in place — never a half-copy.
      const retired = `${dir}.retired-${process.pid}-${randomUUID()}`;
      renameSync(dir, retired);
      try {
        renameSync(staging, dir);
      } catch (err) {
        // Promotion failed — put the good tree back before surfacing the error.
        try {
          renameSync(retired, dir);
        } catch {
          // Best effort; the retired copy is still on disk for manual recovery.
        }
        throw err;
      }
      rmSync(retired, { recursive: true, force: true });

      updateRegistry((repos) => [
        ...repos.filter((r) => r.repo !== repo),
        { repo, addedAt: Date.now() },
      ]);
      return {
        ok: true,
        entry: {
          repo,
          addedAt: Date.now(),
          count: staged.entries.length,
          errors: staged.errors,
          cloned: true,
        },
      };
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  // FIRST-ADD PATH — nothing to preserve, so clone straight into place.
  // Full checkout: unlike a plugin marketplace (manifest-only up front) we
  // read every humans/<name>/profile.json right away.
  const cloned = await gitClone(githubRepoToCloneUrl(repo), dir, { full: true });
  if (!cloned.ok) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: explainGitFailure(cloned.error, repo) };
  }

  const read = readCatalogFromDir(dir, repo);
  if (read.entries.length === 0 && read.errors.length > 0) {
    // A repo that yields nothing usable is a mistake worth surfacing now
    // rather than leaving an empty row in the list.
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: read.errors[0] };
  }

  updateRegistry((repos) => [
    ...repos.filter((r) => r.repo !== repo),
    { repo, addedAt: Date.now() },
  ]);

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
  // Filter inside the lock so a concurrent add of a DIFFERENT repo is not lost.
  updateRegistry((repos) => repos.filter((r) => r.repo !== repo));
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
