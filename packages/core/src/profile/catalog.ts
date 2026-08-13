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
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { WorkspaceProfileSchema, type WorkspaceProfile } from "./types.js";

/** `owner/repo`，与 SKILL_REPO_RE 同源，供仓库地址复用。 */
export const CATALOG_REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** 单个目录段的安全名，挡住 `..`、分隔符与 NUL。 */
const SAFE_SEGMENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_PROFILE_BYTES = 256 * 1024;
const MAX_MANIFEST_HUMANS = 1_000;
const MAX_MANIFEST_TEAMS = 500;
const MAX_ENTRY_TAGS = 64;

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
  teams: HumansManifestTeam[];
}

/**
 * A team shipped by a repo. Same shape as a locally-authored team minus `mode`
 * (the dead enum): `lead` picks the coordinator, `playbook` is the collaboration
 * rules injected into its opening briefing.
 */
export interface HumansManifestTeam {
  id: string;
  name: string;
  description?: string;
  members: string[];
  lead?: string;
  playbook?: string;
}

export interface CatalogTeam extends HumansManifestTeam {
  sourceRepo: string;
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
  teams: CatalogTeam[];
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
  if (rawHumans.length > MAX_MANIFEST_HUMANS) throw new Error("too many humans in manifest");
  const humans: HumansManifestEntry[] = [];
  for (const item of rawHumans) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.name !== "string" || !entry.name || entry.name.length > 64) continue;
    humans.push({
      name: entry.name,
      ...(typeof entry.label === "string" && entry.label.length <= 120
        ? { label: entry.label }
        : {}),
      ...(typeof entry.description === "string" && entry.description.length <= 4_096
        ? { description: entry.description }
        : {}),
      ...(typeof entry.category === "string" && entry.category.length <= 120
        ? { category: entry.category }
        : {}),
      tags: Array.isArray(entry.tags)
        ? entry.tags
            .slice(0, MAX_ENTRY_TAGS)
            .filter((t): t is string => typeof t === "string" && t.length <= 120)
        : [],
    });
  }
  const rawTeams = Array.isArray(value.teams) ? value.teams : [];
  if (rawTeams.length > MAX_MANIFEST_TEAMS) throw new Error("too many teams in manifest");
  const teams: HumansManifestTeam[] = [];
  for (const item of rawTeams) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 64) continue;
    if (typeof entry.name !== "string" || !entry.name || entry.name.length > 120) continue;
    const rawMembers = Array.isArray(entry.members) ? entry.members : [];
    const members = rawMembers.filter(
      (m): m is string => typeof m === "string" && SAFE_SEGMENT_RE.test(m),
    );
    if (members.length < 2 || members.length > 8 || new Set(members).size !== members.length) {
      continue;
    }
    teams.push({
      id: entry.id,
      name: entry.name,
      ...(typeof entry.description === "string" && entry.description.length <= 1_000
        ? { description: entry.description }
        : {}),
      members,
      ...(typeof entry.lead === "string" && SAFE_SEGMENT_RE.test(entry.lead)
        ? { lead: entry.lead }
        : {}),
      ...(typeof entry.playbook === "string" && entry.playbook.length <= 4_000
        ? { playbook: entry.playbook }
        : {}),
    });
  }
  return {
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    humans,
    teams,
  };
}

function readBoundedRegularFile(path: string, maxBytes: number): string {
  const pathInfo = lstatSync(path);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.size > maxBytes) {
    throw new Error("not a bounded regular file");
  }
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > maxBytes) throw new Error("not a bounded regular file");
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** 读取一个已克隆的数字人仓库目录。 */
export function readCatalogFromDir(dir: string, sourceRepo: string): CatalogReadResult {
  const manifestPath = join(dir, "humans.json");
  if (!existsSync(manifestPath)) {
    return { entries: [], teams: [], errors: [`${sourceRepo}: humans.json not found`] };
  }

  let manifest: HumansManifest;
  try {
    manifest = parseHumansManifest(readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES));
  } catch (error) {
    return {
      entries: [],
      teams: [],
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
      const profile = WorkspaceProfileSchema.parse(
        JSON.parse(readBoundedRegularFile(profilePath, MAX_PROFILE_BYTES)),
      );
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
  // A team is only usable if every member ships in this same repo — otherwise
  // summoning it would create Sessions bound to digital humans that do not exist.
  const shipped = new Set(entries.map((entry) => entry.profile.name));
  const teams: CatalogTeam[] = [];
  for (const team of manifest.teams) {
    if (!SAFE_SEGMENT_RE.test(team.id)) {
      errors.push(`${sourceRepo}: team "${team.id}" has an unsafe id`);
      continue;
    }
    const missing = team.members.filter((member) => !shipped.has(member));
    if (missing.length > 0) {
      errors.push(`${sourceRepo}: team "${team.id}" references missing ${missing.join(", ")}`);
      continue;
    }
    if (team.lead && !team.members.includes(team.lead)) {
      errors.push(`${sourceRepo}: team "${team.id}" lead is not one of its members`);
      continue;
    }
    teams.push({ ...team, sourceRepo });
  }
  return { entries, teams, errors };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
