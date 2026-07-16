/**
 * Plugin-marketplace plumbing for the 扩展 (extensions) settings UI. Thin wrappers over
 * core's marketplaceManager / pluginInstaller / parseMarketplaceInput so
 * the renderer never imports core directly.
 *
 * Core does NOT re-export the marketplace shape types from its index, so
 * we mirror them as local DTOs here (same pattern as `PluginSummary` in
 * plugins-service.ts) and flatten the nested `{name,email}` author/owner
 * objects down to plain strings for the UI. Keep these in sync with core's
 * src/plugins/types.ts.
 *
 * List is never-throw (returns []) so the page still renders if the
 * known-marketplaces manifest is missing or corrupt; the mutating calls
 * surface errors as `{ ok:false, error }` (or throw on bad input) so the
 * IPC layer can report a clear message.
 */

import {
  listMarketplaces,
  loadMarketplace,
  addMarketplace,
  refreshMarketplace,
  removeMarketplace,
  installPlugin,
  installLocalPlugin,
  parseMarketplaceInput,
  deriveMarketplaceName,
  invalidateSkillCache,
} from "@cjhyy/code-shell-core";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Platform-aware Git download URL for user-facing setup guidance.
 */
export function gitDownloadUrl(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "https://git-scm.com/download/win";
  if (platform === "darwin") return "https://git-scm.com/download/mac";
  if (platform === "linux") return "https://git-scm.com/download/linux";
  return "https://git-scm.com/downloads";
}

export function gitInstallGuidance(opts: { includeUrl?: boolean } = {}): string {
  const includeUrl = opts.includeUrl !== false;
  const platformNote =
    process.platform === "win32"
      ? "Windows 上建议安装 Git for Windows,它会同时提供 git.exe 和 Git Bash。"
      : "请安装 Git 后重启应用。";
  return (
    `未找到 Git。安装/更新插件市场需要 Git。${platformNote}` +
    (includeUrl ? `下载: ${gitDownloadUrl()}。` : "") +
    "若已安装但仍报此错,请在 设置 → Git 可执行文件路径 填写 git.path 指向 git 可执行文件。"
  );
}

/**
 * Turn core's machine-readable git errors into a friendly, actionable message.
 * `GIT_NOT_FOUND:` is emitted by gitOps when no git binary is reachable — the
 * most common first-run snag (git not installed, or a GUI launch that didn't
 * inherit PATH). Anything else passes through unchanged.
 */
function humanizeGitError(error: string | undefined): string | undefined {
  if (!error) return error;
  if (error.startsWith("GIT_NOT_FOUND")) {
    return gitInstallGuidance();
  }
  return error;
}

// Local type mirrors (core does not re-export these). Keep in sync with core.
export type MarketplaceSource =
  | { source: "github"; repo: string }
  | { source: "git"; url: string };

export type MarketplaceFormat = "claude-code" | "codex" | "universal";

export interface ListedMarketplaceDTO {
  name: string;
  source: MarketplaceSource;
  installLocation: string;
  lastUpdated: string;
  pluginCount: number;
  format: MarketplaceFormat;
}

export interface MarketplacePluginDTO {
  name: string;
  description?: string;
  author?: string; // flattened from {name,email}
  category?: string;
  homepage?: string;
  /** Declared in the manifest when present — CC has no version convention, so often absent. */
  version?: string;
}

export interface MarketplaceDetailDTO {
  name: string;
  description?: string;
  owner?: string; // flattened
  plugins: MarketplacePluginDTO[];
}

export type PluginInstallJobStatus = "queued" | "installing" | "installed" | "failed";

export interface PluginInstallJobDTO {
  id: string;
  pluginName: string;
  marketplaceName: string;
  status: PluginInstallJobStatus;
  requestedAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface RecommendedMarketplaceDTO {
  id: string;
  name: string;
  description?: string;
  reason?: string;
  homepage?: string;
  source: MarketplaceSource;
  format?: MarketplaceFormat;
  official?: boolean;
  sort?: number;
  added?: boolean;
  pluginCount?: number;
}

export interface RecommendedMarketplaceListDTO {
  source: "remote" | "cache" | "builtin";
  url?: string;
  error?: string;
  items: RecommendedMarketplaceDTO[];
}

const DEFAULT_RECOMMENDED_MARKETPLACES_URL =
  "https://raw.githubusercontent.com/cjhyy/codeshell/main/packages/desktop/resources/recommended-marketplaces.json";

const BUILTIN_RECOMMENDED_MARKETPLACES: RecommendedMarketplaceDTO[] = [
  {
    id: "mimi-plugins",
    name: "mimi-plugins",
    description: "CodeShell 官方推荐插件市场。",
    reason: "内含默认 skills 与常用插件,适合作为新装后的第一批市场。",
    source: { source: "github", repo: "cjhyy/mimi-plugins" },
    format: "universal",
    official: true,
    sort: 10,
  },
  {
    id: "official",
    name: "official",
    description: "Superpowers/Claude Code 社区插件市场。",
    reason: "用于兼容 Claude Code 格式插件生态。",
    source: { source: "github", repo: "obra/superpowers-marketplace" },
    format: "claude-code",
    sort: 20,
  },
];

function homeDir(): string {
  return process.env.HOME || homedir();
}

function recommendedCachePath(): string {
  return join(homeDir(), ".code-shell", "plugins", "recommended_marketplaces_cache.json");
}

function safeId(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

function sourceKey(source: MarketplaceSource): string {
  return source.source === "github" ? `github:${source.repo}` : `git:${source.url}`;
}

function sameSource(a: MarketplaceSource, b: MarketplaceSource): boolean {
  return sourceKey(a).toLowerCase() === sourceKey(b).toLowerCase();
}

function normalizeRecommendedItem(raw: unknown, index: number): RecommendedMarketplaceDTO | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const source = obj.source as MarketplaceSource | undefined;
  if (
    !source ||
    typeof source !== "object" ||
    !(
      (source.source === "github" && typeof source.repo === "string" && source.repo.trim()) ||
      (source.source === "git" && typeof source.url === "string" && source.url.trim())
    )
  ) {
    return null;
  }
  const name =
    typeof obj.name === "string" && obj.name.trim()
      ? obj.name.trim()
      : source.source === "github"
        ? source.repo.split("/").pop() ?? `marketplace-${index + 1}`
        : source.url.split(/[/:]/).filter(Boolean).pop()?.replace(/\.git$/i, "") ?? `marketplace-${index + 1}`;
  const id = typeof obj.id === "string" && obj.id.trim() ? safeId(obj.id) : safeId(name);
  return {
    id: id || `marketplace-${index + 1}`,
    name,
    ...(typeof obj.description === "string" ? { description: obj.description } : {}),
    ...(typeof obj.reason === "string" ? { reason: obj.reason } : {}),
    ...(typeof obj.homepage === "string" ? { homepage: obj.homepage } : {}),
    source: source.source === "github"
      ? { source: "github", repo: source.repo.trim() }
      : { source: "git", url: source.url.trim() },
    ...(obj.format === "claude-code" || obj.format === "codex" || obj.format === "universal"
      ? { format: obj.format }
      : {}),
    ...(typeof obj.official === "boolean" ? { official: obj.official } : {}),
    ...(typeof obj.sort === "number" && Number.isFinite(obj.sort) ? { sort: obj.sort } : {}),
  };
}

export function parseRecommendedMarketplaces(raw: unknown): RecommendedMarketplaceDTO[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { marketplaces?: unknown }).marketplaces)
      ? (raw as { marketplaces: unknown[] }).marketplaces
      : [];
  return list
    .map((item, index) => normalizeRecommendedItem(item, index))
    .filter((item): item is RecommendedMarketplaceDTO => Boolean(item))
    .sort((a, b) => (a.sort ?? 999) - (b.sort ?? 999) || a.name.localeCompare(b.name));
}

function decorateRecommended(items: RecommendedMarketplaceDTO[]): RecommendedMarketplaceDTO[] {
  const known = listMarketplacesForUi();
  return items.map((item) => {
    const match = known.find((m) => m.name === item.name || sameSource(m.source, item.source));
    return {
      ...item,
      added: Boolean(match),
      pluginCount: match?.pluginCount,
      format: item.format ?? match?.format,
    };
  });
}

async function fetchRecommendedRaw(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function readRecommendedCache(): RecommendedMarketplaceDTO[] | null {
  const path = recommendedCachePath();
  if (!existsSync(path)) return null;
  try {
    return parseRecommendedMarketplaces(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

function writeRecommendedCache(raw: unknown): void {
  const path = recommendedCachePath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw, null, 2));
  } catch {
    // Best effort cache; never block the marketplace UI.
  }
}

export async function listRecommendedMarketplacesForUi(): Promise<RecommendedMarketplaceListDTO> {
  const url = process.env.CODESHELL_RECOMMENDED_MARKETPLACES_URL || DEFAULT_RECOMMENDED_MARKETPLACES_URL;
  try {
    const raw = await fetchRecommendedRaw(url);
    const parsed = parseRecommendedMarketplaces(raw);
    if (parsed.length > 0) {
      writeRecommendedCache(raw);
      return { source: "remote", url, items: decorateRecommended(parsed) };
    }
    throw new Error("recommended marketplace list is empty");
  } catch (err) {
    const cached = readRecommendedCache();
    if (cached && cached.length > 0) {
      return {
        source: "cache",
        url,
        error: (err as Error).message,
        items: decorateRecommended(cached),
      };
    }
    return {
      source: "builtin",
      url,
      error: (err as Error).message,
      items: decorateRecommended(BUILTIN_RECOMMENDED_MARKETPLACES),
    };
  }
}

export function listMarketplacesForUi(): ListedMarketplaceDTO[] {
  try {
    return listMarketplaces() as ListedMarketplaceDTO[];
  } catch {
    return [];
  }
}

export function loadMarketplaceForUi(name: string): MarketplaceDetailDTO | null {
  if (typeof name !== "string" || !name) {
    throw new Error("loadMarketplaceForUi requires name");
  }
  const mp = loadMarketplace(name);
  if (!mp) return null;
  return {
    name: mp.name,
    description: mp.description,
    owner: mp.owner?.name,
    plugins: mp.plugins.map((p) => ({
      name: p.name,
      description: p.description,
      author: p.author?.name,
      category: p.category,
      homepage: p.homepage,
      version: p.version,
    })),
  };
}

/** Parse a user-typed marketplace source string (github repo / git url) and add it. */
export async function addMarketplaceFromInput(
  input: string,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  if (typeof input !== "string" || !input.trim()) {
    return { ok: false, error: "请输入 GitHub 仓库或 git URL" };
  }
  const source = parseMarketplaceInput(input.trim());
  if (!source) {
    return { ok: false, error: "无法识别的市场来源（应为 owner/repo 或 git URL）" };
  }
  const name = deriveMarketplaceName(source);
  const res = await addMarketplace(name, source);
  if (res.ok) return { ok: true, name: res.name };
  return { ok: false, error: humanizeGitError(res.error) };
}

export function removeMarketplaceForUi(name: string): boolean {
  if (typeof name !== "string" || !name) {
    throw new Error("removeMarketplaceForUi requires name");
  }
  return removeMarketplace(name);
}

/** Re-pull a known marketplace from its source (git fetch + reset). */
export async function refreshMarketplaceForUi(
  name: string,
): Promise<{ ok: boolean; error?: string }> {
  if (typeof name !== "string" || !name) {
    throw new Error("refreshMarketplaceForUi requires name");
  }
  const res = await refreshMarketplace(name);
  if (res.ok) return { ok: true };
  return { ok: false, error: humanizeGitError(res.error) };
}

const installJobs = new Map<string, PluginInstallJobDTO>();
const installQueue: string[] = [];
const installListeners = new Set<(jobs: PluginInstallJobDTO[]) => void>();
let activeInstallJobId: string | null = null;

function installJobId(pluginName: string, marketplaceName: string): string {
  return `${marketplaceName}::${pluginName}`;
}

export function listPluginInstallJobsForUi(): PluginInstallJobDTO[] {
  return [...installJobs.values()].sort((a, b) => a.requestedAt - b.requestedAt);
}

export function onPluginInstallJobsChanged(
  cb: (jobs: PluginInstallJobDTO[]) => void,
): () => void {
  installListeners.add(cb);
  return () => installListeners.delete(cb);
}

function emitPluginInstallJobsChanged(): void {
  const snapshot = listPluginInstallJobsForUi();
  for (const cb of installListeners) {
    try {
      cb(snapshot);
    } catch {
      // Listener isolation: one bad window must not stop updates to others.
    }
  }
}

function queueInstallJob(job: PluginInstallJobDTO): void {
  if (!installQueue.includes(job.id)) installQueue.push(job.id);
  emitPluginInstallJobsChanged();
  void drainInstallQueue();
}

async function drainInstallQueue(): Promise<void> {
  if (activeInstallJobId !== null) return;
  const nextId = installQueue.shift();
  if (!nextId) return;
  const job = installJobs.get(nextId);
  if (!job || job.status !== "queued") {
    void drainInstallQueue();
    return;
  }
  activeInstallJobId = nextId;
  installJobs.set(nextId, { ...job, status: "installing", startedAt: Date.now(), error: undefined });
  emitPluginInstallJobsChanged();
  try {
    const res = await installPlugin(job.pluginName, job.marketplaceName);
    if (res.ok) {
      invalidateSkillCache();
      installJobs.set(nextId, {
        ...installJobs.get(nextId)!,
        status: "installed",
        finishedAt: Date.now(),
        error: undefined,
      });
    } else {
      installJobs.set(nextId, {
        ...installJobs.get(nextId)!,
        status: "failed",
        finishedAt: Date.now(),
        error: humanizeGitError(res.error) ?? "安装失败",
      });
    }
  } catch (err) {
    installJobs.set(nextId, {
      ...installJobs.get(nextId)!,
      status: "failed",
      finishedAt: Date.now(),
      error: humanizeGitError(String((err as Error)?.message ?? err)) ?? "安装失败",
    });
  } finally {
    activeInstallJobId = null;
    emitPluginInstallJobsChanged();
    void drainInstallQueue();
  }
}

export async function installPluginForUi(
  pluginName: string,
  marketplaceName: string,
): Promise<{ ok: boolean; job?: PluginInstallJobDTO; error?: string }> {
  if (typeof pluginName !== "string" || !pluginName) {
    throw new Error("installPluginForUi requires pluginName");
  }
  if (typeof marketplaceName !== "string" || !marketplaceName) {
    throw new Error("installPluginForUi requires marketplaceName");
  }
  const id = installJobId(pluginName, marketplaceName);
  const existing = installJobs.get(id);
  if (existing) {
    if (existing.status === "queued" || existing.status === "installing" || existing.status === "installed") {
      return { ok: true, job: existing };
    }
    const job: PluginInstallJobDTO = {
      ...existing,
      status: "queued",
      requestedAt: Date.now(),
      startedAt: undefined,
      finishedAt: undefined,
      error: undefined,
    };
    installJobs.set(id, job);
    queueInstallJob(job);
    return { ok: true, job };
  }
  const job: PluginInstallJobDTO = {
    id,
    pluginName,
    marketplaceName,
    status: "queued",
    requestedAt: Date.now(),
  };
  installJobs.set(id, job);
  queueInstallJob(job);
  return { ok: true, job };
}

export async function retryPluginInstallJobForUi(
  id: string,
): Promise<{ ok: boolean; job?: PluginInstallJobDTO; error?: string }> {
  const existing = installJobs.get(id);
  if (!existing) return { ok: false, error: "找不到安装任务" };
  return installPluginForUi(existing.pluginName, existing.marketplaceName);
}

export async function addRecommendedMarketplaceForUi(
  id: string,
): Promise<{ ok: boolean; name?: string; error?: string }> {
  const list = await listRecommendedMarketplacesForUi();
  const item = list.items.find((m) => m.id === id || m.name === id);
  if (!item) return { ok: false, error: "推荐市场不存在" };
  const res = await addMarketplace(item.name, item.source);
  if (res.ok) return { ok: true, name: res.name };
  return { ok: false, error: humanizeGitError(res.error) };
}

/**
 * Install a plugin from a local directory or a .zip archive (global scope —
 * plugins are not project-scoped). Main owns Date.now (core scripts cannot use
 * it), so we stamp installedAt here. On success bust the skill cache like the
 * marketplace path; the renderer fires "codeshell:settings-changed" to hot-load
 * any hooks the plugin ships.
 */
export type LocalInstallError =
  | { ok: false; alreadyInstalled: true; name: string }
  | { ok: false; error?: string };

/**
 * Map a raw local-install failure message into the UI result shape. Pure so the
 * fragile contract is unit-testable independent of the filesystem.
 *
 * Distinguishes the same-name conflict so the UI can offer an overwrite using
 * the AUTHORITATIVE plugin name. core derives the real name (from the plugin
 * manifest, after extracting a zip) and bakes it into the error "plugin '<name>'
 * already installed", so we extract it here rather than relying on the picker's
 * filename-derived guess. Anything else is humanized (e.g. GIT_NOT_FOUND).
 */
export function classifyLocalInstallError(raw: string): LocalInstallError {
  const m = raw.match(/plugin '(.+?)' already installed/);
  if (m) {
    return { ok: false, alreadyInstalled: true, name: m[1] };
  }
  return { ok: false, error: humanizeGitError(raw) };
}

export async function installLocalPluginForUi(
  input: { kind: "dir" | "zip"; path: string; overwrite?: boolean },
): Promise<{ ok: true; name: string } | LocalInstallError> {
  if (!input || (input.kind !== "dir" && input.kind !== "zip") || typeof input.path !== "string" || !input.path) {
    throw new Error("installLocalPluginForUi requires { kind: 'dir'|'zip', path }");
  }
  try {
    const { name } = await installLocalPlugin(
      { kind: input.kind, path: input.path },
      new Date().toISOString(),
      undefined,
      { overwrite: input.overwrite === true },
    );
    invalidateSkillCache();
    return { ok: true, name };
  } catch (e) {
    const raw = String(e instanceof Error ? e.message : e);
    return classifyLocalInstallError(raw);
  }
}
