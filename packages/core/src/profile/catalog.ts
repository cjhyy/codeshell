/**
 * 数字人仓库（catalog）：从 git 仓库读取一批数字人定义。
 *
 * 与插件市场并列而非寄生：数字人有自己的一等分发原语（导入/导出 + 本仓库），
 * 不需要先成为插件。仓库布局与 cjhyy/mimi-humans 一致：
 *
 *   humans.json          —— 目录清单（name/label/description/category/tags）
 *   humans/<name>/profile.json —— WorkspaceProfile 定义（含可选 requires）
 *
 * 本模块只做**读取与校验**，克隆/更新由 host 驱动（涉及网络与磁盘写入）。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WorkspaceProfileSchema, type WorkspaceProfile } from "./types.js";

/** `owner/repo`，与 SKILL_REPO_RE 同源，供仓库地址复用。 */
export const CATALOG_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 单个目录段的安全名，挡住 `..`、分隔符与 NUL。 */
const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface HumansManifestEntry {
  name: string;
  label?: string;
  description?: string;
  category?: string;
  tags?: string[];
}

export interface HumansManifest {
  name?: string;
  description?: string;
  humans: HumansManifestEntry[];
}

export interface CatalogEntry {
  profile: WorkspaceProfile;
  /** 来源仓库 `owner/repo`，用于展示与去重。 */
  sourceRepo: string;
  category?: string;
  tags: string[];
}

export interface CatalogReadResult {
  entries: CatalogEntry[];
  /** 逐条目的失败原因；一个坏定义不该让整个仓库不可用。 */
  errors: string[];
}

/**
 * `owner/repo` → 一个安全的目录段。小写化保证同一仓库不同大小写写法命中同一份
 * 缓存；斜杠换成 `-` 后仍需通过 SAFE_SEGMENT_RE，杜绝路径逃逸。
 */
export function sourceToRepoKey(repo: string): string {
  if (!CATALOG_REPO_RE.test(repo)) {
    throw new Error(`invalid digital-human repo "${repo}" (expected owner/repo)`);
  }
  const key = repo
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace("/", "-");
  if (!SAFE_SEGMENT_RE.test(key)) {
    throw new Error(`digital-human repo "${repo}" does not map to a safe directory name`);
  }
  return key;
}

/** 解析 humans.json。缺 humans 数组按空目录处理；JSON 坏了才抛。 */
export function parseHumansManifest(raw: string): HumansManifest {
  const value = JSON.parse(raw) as Record<string, unknown>;
  const rawHumans = Array.isArray(value.humans) ? value.humans : [];
  const humans: HumansManifestEntry[] = [];
  for (const item of rawHumans) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name) continue;
    humans.push({
      name: entry.name,
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      ...(typeof entry.description === "string" ? { description: entry.description } : {}),
      ...(typeof entry.category === "string" ? { category: entry.category } : {}),
      tags: Array.isArray(entry.tags)
        ? entry.tags.filter((t): t is string => typeof t === "string")
        : [],
    });
  }
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    humans,
  };
}

/** 读取一个已克隆的数字人仓库目录。 */
export function readCatalogFromDir(dir: string, sourceRepo: string): CatalogReadResult {
  const manifestPath = join(dir, "humans.json");
  if (!existsSync(manifestPath)) {
    return { entries: [], errors: [`${sourceRepo}: humans.json not found`] };
  }

  let manifest: HumansManifest;
  try {
    manifest = parseHumansManifest(readFileSync(manifestPath, "utf-8"));
  } catch (error) {
    return {
      entries: [],
      errors: [`${sourceRepo}: humans.json is not valid JSON (${describe(error)})`],
    };
  }

  const entries: CatalogEntry[] = [];
  const errors: string[] = [];
  for (const item of manifest.humans) {
    // The manifest is untrusted input from a cloned repo — never join a name
    // that could climb out of the humans/ directory.
    if (!SAFE_SEGMENT_RE.test(item.name)) {
      errors.push(`${sourceRepo}: entry "${item.name}" has an unsafe name`);
      continue;
    }
    const profilePath = join(dir, "humans", item.name, "profile.json");
    try {
      const profile = WorkspaceProfileSchema.parse(JSON.parse(readFileSync(profilePath, "utf-8")));
      entries.push({
        profile,
        sourceRepo,
        ...(item.category ? { category: item.category } : {}),
        tags: item.tags ?? [],
      });
    } catch (error) {
      errors.push(`${sourceRepo}: "${item.name}" is invalid (${describe(error)})`);
    }
  }
  return { entries, errors };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
