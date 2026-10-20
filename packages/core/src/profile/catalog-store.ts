/**
 * 已注册的数字人仓库：注册表 + 克隆缓存 + 读取。
 *
 * 与插件市场并列的一等分发通道。数字人不必先成为插件——它有自己的定义格式和
 * 导入/导出原语，仓库只是把「一批定义」打包分发。
 *
 * 磁盘布局：
 *   ~/.code-shell/human-repos.json        —— 注册表（owner/repo 列表）
 *   ~/.code-shell/human-repos/<key>/      —— 各仓库的浅克隆（key 为 owner@repo）
 *
 * 旧版本用有歧义的 `owner-repo` 作 key，那些缓存仍可读（见 legacyRepoDirFor），
 * 下次更新时迁入新布局，删除时只删能确认属于该仓库的那一份。
 */
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
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { codeShellHome } from "../session/session-manager.js";
import { acquireLockOnPath, mutateJsonFile } from "../utils/file-mutex.js";
// gitFetchAndReset is deliberately NOT used any more: updating in place is what
// destroyed the last-known-good tree on a bad upstream commit. Updates clone to
// a staging dir and swap (see addHumanRepo).
import { gitClone, githubRepoToCloneUrl } from "../plugins/gitOps.js";
import {
  CATALOG_REPO_RE,
  legacySourceToRepoKey,
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
const MAX_REPO_REGISTRY_BYTES = 256 * 1024;

export function humanReposRoot(): string {
  return join(codeShellHome(), "human-repos");
}

function registryPath(): string {
  return join(codeShellHome(), "human-repos.json");
}

export function humanRepoDir(repo: string): string {
  return join(humanReposRoot(), sourceToRepoKey(repo));
}

const MAX_GIT_CONFIG_BYTES = 64 * 1024;

function normalizeRepo(repo: string): string {
  return repo.toLowerCase().replace(/\.git$/, "");
}

/** `owner/repo` recorded as the origin of a clone made by addHumanRepo, or null. */
function cloneOriginRepo(dir: string): string | null {
  try {
    const path = join(dir, ".git", "config");
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size > MAX_GIT_CONFIG_BYTES) return null;
    let inOrigin = false;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("[")) {
        inOrigin = trimmed === '[remote "origin"]';
        continue;
      }
      const url = inOrigin ? /^url\s*=\s*https:\/\/github\.com\/(.+)\.git$/.exec(trimmed) : null;
      if (url) return normalizeRepo(url[1]!);
    }
  } catch {
    // No readable git metadata: the caller falls back to registry uniqueness.
  }
  return null;
}

/**
 * A cache written by an older version under the lossy `owner-repo` key, when it
 * provably belongs to `repo`: its git origin names `repo`, or it has no
 * readable origin and `repo` is the only registered source mapping to that key.
 * Anything else may belong to another source and is left alone.
 */
function legacyRepoDirFor(repo: string, registered: readonly RegisteredHumanRepo[]): string | null {
  const key = legacySourceToRepoKey(repo);
  if (!key) return null;
  const dir = join(humanReposRoot(), key);
  if (!existsSync(dir)) return null;
  const origin = cloneOriginRepo(dir);
  if (origin !== null) return origin === normalizeRepo(repo) ? dir : null;
  const claimants = registered.filter((r) => legacySourceToRepoKey(r.repo) === key);
  return claimants.length === 1 && normalizeRepo(claimants[0]!.repo) === normalizeRepo(repo)
    ? dir
    : null;
}

/** The cache tree to read for a registered repo, in the current or legacy layout. */
function readableRepoDir(repo: string, registered: readonly RegisteredHumanRepo[]): string | null {
  const dir = humanRepoDir(repo);
  if (existsSync(dir)) return dir;
  return legacyRepoDirFor(repo, registered);
}

/** Move `repo`'s legacy cache into the current layout. Call under the repo lock. */
function adoptLegacyRepoDir(repo: string, registered: readonly RegisteredHumanRepo[]): void {
  const dir = humanRepoDir(repo);
  if (existsSync(dir)) return;
  const legacy = legacyRepoDirFor(repo, registered);
  if (legacy) renameSync(legacy, dir);
}

export function listHumanRepos(): RegisteredHumanRepo[] {
  let descriptor: number | undefined;
  try {
    // Missing or corrupt registry reads as "no repos" — never fatal.
    const path = registryPath();
    const metadata = lstatSync(path);
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      metadata.size > MAX_REPO_REGISTRY_BYTES
    ) {
      throw new Error("invalid digital-human repo registry");
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_REPO_REGISTRY_BYTES) {
      throw new Error("invalid digital-human repo registry");
    }
    return parseRegistry(readFileSync(descriptor, "utf-8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseRegistry(raw: string | undefined): RegisteredHumanRepo[] {
  if (raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as { repos?: unknown };
    if (!Array.isArray(parsed.repos)) return [];
    const seen = new Set<string>();
    return parsed.repos
      .slice(0, MAX_REPOS)
      .filter(
        (r): r is RegisteredHumanRepo =>
          !!r &&
          typeof r === "object" &&
          typeof (r as RegisteredHumanRepo).repo === "string" &&
          CATALOG_REPO_RE.test((r as RegisteredHumanRepo).repo),
      )
      .filter((r) => {
        const normalized = r.repo.toLowerCase();
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      })
      .map((r) => ({
        repo: r.repo,
        addedAt:
          typeof r.addedAt === "number" && Number.isSafeInteger(r.addedAt) && r.addedAt >= 0
            ? r.addedAt
            : 0,
      }));
  } catch {
    return [];
  }
}

/**
 * Serialize add/update/remove of ONE repo across processes.
 *
 * Distinct from the registry lock inside `updateRegistry`: that one only guards
 * the JSON file, and is held for a moment. This one spans the whole mutation —
 * capacity check, directory swap, registry write — so two processes cannot both
 * decide the repo is absent and clone into the same path, and cannot both slip
 * past MAX_REPOS. Keyed per repo, so unrelated repos still install in parallel.
 *
 * The lock file lives next to the clones and is never the clone dir itself
 * (proper-lockfile creates `<path>.lock`, which must not collide with a tree we
 * rename over).
 */
function withHumanRepoLock<T>(repo: string, run: () => T): T {
  const root = humanReposRoot();
  mkdirSync(root, { recursive: true });
  const lockTarget = join(root, `.${sourceToRepoKey(repo)}.repo-lock`);
  if (!existsSync(lockTarget)) writeFileSync(lockTarget, "", { mode: 0o600 });
  // Lock the marker FILE, not humanReposRoot(): a directory lock would serialize
  // unrelated repos and deadlock against the registry lock taken below.
  // 30s covers a swap that waits behind another process's publish step.
  const release = acquireLockOnPath(lockTarget, 30_000);
  try {
    return run();
  } finally {
    release();
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
    maxBytes: MAX_REPO_REGISTRY_BYTES,
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
  const dir = humanRepoDir(repo);
  mkdirSync(humanReposRoot(), { recursive: true });

  // Clone into a private staging dir FIRST, outside the lock — this is the slow
  // network step and must not hold the lock for the duration. Both the add and
  // the update path stage: cloning straight into `dir` let two processes race
  // into the same path, and the loser's `rmSync(dir)` then deleted the winner's
  // perfectly good clone.
  const staging = `${dir}.staging-${process.pid}-${randomUUID()}`;
  try {
    const cloned = await gitClone(githubRepoToCloneUrl(repo), staging, { full: true });
    if (!cloned.ok) {
      // Only ever removes OUR staging dir (finally below); `dir` is untouched.
      return { ok: false, error: explainGitFailure(cloned.error, repo) };
    }
    const staged = readCatalogFromDir(staging, repo);
    if (staged.entries.length === 0 && staged.errors.length > 0) {
      // A repo that yields nothing usable is a mistake worth surfacing now
      // rather than leaving an empty row in the list. On update this also keeps
      // the last known good tree in place.
      const hadPrevious = readableRepoDir(repo, listHumanRepos()) !== null;
      return {
        ok: false,
        error: hadPrevious
          ? `更新 ${repo} 失败，已保留上一个可用版本：${staged.errors[0]}`
          : staged.errors[0]!,
      };
    }

    // Publish under the repo lock: capacity check, directory swap and registry
    // write must be one critical section. Checking MAX_REPOS before the lock
    // let N processes each observe 31 repos and all proceed past the cap.
    const published = withHumanRepoLock(repo, () => {
      const current = listHumanRepos();
      const alreadyRegistered = current.some((r) => r.repo === repo);
      if (current.length >= MAX_REPOS && !alreadyRegistered) {
        return { ok: false as const, error: `最多只能添加 ${MAX_REPOS} 个数字人仓库` };
      }
      // Move a legacy-layout cache into place first so the swap below retires
      // it like any previous tree instead of leaving it orphaned.
      adoptLegacyRepoDir(repo, current);
      promoteStagedRepo(staging, dir);
      updateRegistry((repos) => [
        ...repos.filter((r) => r.repo !== repo),
        { repo, addedAt: Date.now() },
      ]);
      return { ok: true as const };
    });
    if (!published.ok) return published;

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

/**
 * Swap a validated staging tree into place.
 *
 * Ordering matters for crash safety: promote FIRST (rename staging over a
 * now-absent `dir`), and only retire the old tree around it. The previous
 * `dir → retired` then `staging → dir` sequence left no tree at `dir` at all if
 * the process died in between, and nothing scanned for `.retired-*` on startup,
 * so the UI showed "尚未克隆" with the data still on disk under a name nobody
 * looked for. Here the only window is one where BOTH the old tree (at `retired`)
 * and the new tree (at `staging`) still exist, and `reclaimOrphanedTrees`
 * cleans up whatever is left over on the next call.
 */
function promoteStagedRepo(staging: string, dir: string): void {
  reclaimOrphanedTrees(dir);
  if (!existsSync(dir)) {
    renameSync(staging, dir);
    return;
  }
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
}

/**
 * Recover from a crash during a previous swap.
 *
 * If `dir` is missing but a `.retired-*` sibling exists, a process died between
 * retiring the old tree and promoting the new one. Restore the newest retired
 * tree rather than leaving the repo looking un-cloned, then drop the rest.
 * Runs under the repo lock, so no concurrent swap can be mid-flight.
 */
function reclaimOrphanedTrees(dir: string): void {
  const parent = dirname(dir);
  const prefix = `${basename(dir)}.retired-`;
  let orphans: string[];
  try {
    orphans = readdirSync(parent).filter((name) => name.startsWith(prefix));
  } catch {
    return;
  }
  if (orphans.length === 0) return;
  orphans.sort();
  if (!existsSync(dir)) {
    const restore = orphans.pop()!;
    try {
      renameSync(join(parent, restore), dir);
    } catch {
      // Fall through: leave it for manual recovery rather than deleting data.
    }
  }
  for (const stale of orphans) {
    rmSync(join(parent, stale), { recursive: true, force: true });
  }
}

/**
 * Crash-safety internals, exposed for tests only.
 *
 * `promoteStagedRepo`/`reclaimOrphanedTrees` implement the swap-and-recover
 * protocol. Exercising them through `addHumanRepo` would require network git, so
 * the recovery cases (interrupted swap, stale retired trees) are tested here
 * directly. Not part of the package's public surface.
 */
export const __testables = { promoteStagedRepo, reclaimOrphanedTrees, adoptLegacyRepoDir };

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
  // Same repo lock as add/update: otherwise a remove can delete the tree a
  // concurrent add just published, leaving a registered repo with no clone.
  withHumanRepoLock(repo, () => {
    // Attribute a legacy-layout cache before the registry row disappears.
    const legacy = legacyRepoDirFor(repo, listHumanRepos());
    // Filter inside the registry lock so a concurrent add of a DIFFERENT repo
    // is not lost.
    updateRegistry((repos) => repos.filter((r) => r.repo !== repo));
    for (const dir of legacy ? [humanRepoDir(repo), legacy] : [humanRepoDir(repo)]) {
      rmSync(dir, { recursive: true, force: true });
      // Drop any tree a crashed swap left behind, so a later re-add does not
      // resurrect the old contents via reclaimOrphanedTrees.
      reclaimOrphanedTrees(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

/** 注册表 + 每个仓库的读取结果，供设置页展示。 */
export function listHumanRepoDetails(): HumanRepoListEntry[] {
  const repos = listHumanRepos();
  return repos.map((registered) => {
    const dir = readableRepoDir(registered.repo, repos);
    if (!dir) {
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
  const repos = listHumanRepos();
  for (const { repo } of repos) {
    const dir = readableRepoDir(repo, repos);
    if (!dir) continue;
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
