/**
 * WorkspaceProfile（数字人）的 desktop main 门面。与 capabilities-service
 * 相同的组合方式：直接 import core host API，per-call 建 SettingsManager。
 * 激活/关闭写的是项目 settings（原子事务在 core），worker 经现有 settings
 * 热重载在下一轮生效 —— 无需额外通知通道。
 */
import {
  SessionManager,
  SettingsManager,
  WorkspaceProfileSchema,
  WORKSPACE_PROFILE_NAME_RE,
  invalidateSkillCache,
  planProfileRequirements,
  scanSkills,
  type WorkspaceProfile,
} from "@cjhyy/code-shell-core";
import {
  formatRequirementPlan,
  installSkillRequirement,
  type RequirementPlanSummary,
} from "./profile-requirements-service.js";
import { spawnSync } from "node:child_process";
import {
  activateWorkspaceProfile,
  addHumanRepo,
  deactivateWorkspaceProfile,
  deleteWorkspaceProfile,
  listHumanRepoDetails,
  listWorkspaceProfiles,
  readAllHumanRepoEntries,
  readWorkspaceProfile,
  removeHumanRepo,
  resolveActiveWorkspaceProfile,
  saveWorkspaceProfile,
  type HumanRepoListEntry,
} from "@cjhyy/code-shell-core/internal";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DIGITAL_HUMAN_CATALOG, type DigitalHumanCatalogEntry } from "./digital-human-catalog.js";
import { listDigitalHumanTeams } from "./digital-human-team-service.js";
import type {
  DigitalHumanProfileExportResult,
  DigitalHumanProfileImportCommitInput,
  DigitalHumanProfileImportCommitResult,
  DigitalHumanProfileImportPreview,
  ReviewedDigitalHumanProfile,
} from "../shared/digital-human-profile-transfer.js";

export const MAX_PROFILE_DEFINITION_IMPORT_BYTES = 256 * 1024;
const PROFILE_IMPORT_REVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_PROFILE_IMPORT_REVIEWS = 16;

const reviewedProfileImports = new Map<
  string,
  ReviewedDigitalHumanProfile & { createdAt: number }
>();

function pruneExpiredProfileImportReviews(now = Date.now()): void {
  for (const [token, review] of reviewedProfileImports) {
    if (now - review.createdAt > PROFILE_IMPORT_REVIEW_TTL_MS) {
      reviewedProfileImports.delete(token);
    }
  }
}

function makeRoomForProfileImportReview(): void {
  pruneExpiredProfileImportReviews();
  while (reviewedProfileImports.size >= MAX_PROFILE_IMPORT_REVIEWS) {
    const oldest = reviewedProfileImports.keys().next().value as string | undefined;
    if (!oldest) break;
    reviewedProfileImports.delete(oldest);
  }
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readBoundedProfileDefinitionFile(filePath: string): Buffer {
  const pathInfo = lstatSync(filePath);
  if (pathInfo.isSymbolicLink() || !pathInfo.isFile()) {
    throw new Error("Digital-human profile import must be a regular file");
  }
  if (pathInfo.size > MAX_PROFILE_DEFINITION_IMPORT_BYTES) {
    throw new Error(
      `Digital-human profile definition exceeds ${MAX_PROFILE_DEFINITION_IMPORT_BYTES} bytes`,
    );
  }

  let fd: number | undefined;
  try {
    const flags =
      process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
    fd = openSync(filePath, flags);
    const openedInfo = fstatSync(fd);
    if (!openedInfo.isFile()) {
      throw new Error("Digital-human profile import must be a regular file");
    }
    if (openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
      throw new Error("Digital-human profile import changed while being opened");
    }
    if (openedInfo.size > MAX_PROFILE_DEFINITION_IMPORT_BYTES) {
      throw new Error(
        `Digital-human profile definition exceeds ${MAX_PROFILE_DEFINITION_IMPORT_BYTES} bytes`,
      );
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const remaining = MAX_PROFILE_DEFINITION_IMPORT_BYTES + 1 - total;
      if (remaining <= 0) {
        throw new Error(
          `Digital-human profile definition exceeds ${MAX_PROFILE_DEFINITION_IMPORT_BYTES} bytes`,
        );
      }
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_PROFILE_DEFINITION_IMPORT_BYTES) {
        throw new Error(
          `Digital-human profile definition exceeds ${MAX_PROFILE_DEFINITION_IMPORT_BYTES} bytes`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function parseProfileDefinition(bytes: Buffer, filePath: string): WorkspaceProfile {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch (error) {
    throw new Error(
      `Invalid digital-human profile JSON in "${basename(filePath)}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  try {
    return WorkspaceProfileSchema.parse(value);
  } catch (error) {
    throw new Error(
      `Invalid digital-human profile definition in "${basename(filePath)}": ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function capabilityCounts(
  profile: WorkspaceProfile,
): DigitalHumanProfileImportPreview["capabilityCounts"] {
  const plugins = profile.plugins.length;
  const skills = profile.skills.length;
  const mcp = profile.mcp.length;
  const agents = profile.agents.length;
  return { plugins, skills, mcp, agents, total: plugins + skills + mcp + agents };
}

/** Parse and review a local definition without mutating the profile library. */
export function previewProfileDefinitionImport(filePath: string): DigitalHumanProfileImportPreview {
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("Digital-human profile import requires a file path");
  }
  const profile = parseProfileDefinition(readBoundedProfileDefinitionFile(filePath), filePath);
  makeRoomForProfileImportReview();
  const reviewToken = randomUUID();
  reviewedProfileImports.set(reviewToken, {
    profile,
    sourceFileName: basename(filePath),
    createdAt: Date.now(),
  });
  return {
    reviewToken,
    sourceFileName: basename(filePath),
    name: profile.name,
    label: profile.label,
    description: profile.description,
    basePreset: profile.basePreset,
    version: profile.version,
    portableMemory: profile.portableMemory,
    capabilityCounts: capabilityCounts(profile),
    alreadyExists: readWorkspaceProfile(profile.name) !== undefined,
  };
}

/** Commit exactly the Schema-normalized snapshot represented by a review token. */
export function importReviewedProfileDefinition(
  input: DigitalHumanProfileImportCommitInput,
): DigitalHumanProfileImportCommitResult {
  if (!input || typeof input.reviewToken !== "string" || !input.reviewToken) {
    throw new Error("Digital-human profile import requires a review token");
  }
  if (input.overwrite !== undefined && typeof input.overwrite !== "boolean") {
    throw new Error("Digital-human profile import overwrite must be boolean");
  }
  pruneExpiredProfileImportReviews();
  const reviewed = reviewedProfileImports.get(input.reviewToken);
  if (!reviewed) {
    throw new Error("Digital-human profile import review expired; choose the file again");
  }

  const existing = readWorkspaceProfile(reviewed.profile.name);
  if (existing && input.overwrite !== true) {
    return {
      ok: false,
      alreadyExists: true,
      name: reviewed.profile.name,
      label: reviewed.profile.label,
    };
  }
  saveWorkspaceProfile(reviewed.profile);
  reviewedProfileImports.delete(input.reviewToken);
  return { ok: true, name: reviewed.profile.name, label: reviewed.profile.label };
}

/** Write definition JSON only; portable memory content is deliberately excluded. */
export function exportProfileDefinition(
  name: string,
  filePath: string,
): Exclude<DigitalHumanProfileExportResult, { canceled: true }> {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) throw new Error("invalid digital-human profile id");
  if (typeof filePath !== "string" || !filePath) {
    throw new Error("Digital-human profile export requires a file path");
  }
  const profile = readWorkspaceProfile(name);
  if (!profile) throw new Error(`Digital human "${name}" is not installed`);

  const parentInfo = lstatSync(dirname(filePath));
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    throw new Error("Digital-human profile export destination must be a regular directory");
  }
  const existing = lstatIfPresent(filePath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Digital-human profile export destination must be a regular file");
  }

  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(profile, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(tmp, filePath);
  } finally {
    rmSync(tmp, { force: true });
  }
  return {
    canceled: false,
    fileName: basename(filePath),
    name: profile.name,
    label: profile.label,
  };
}

/** Test-only reset for the bounded in-memory review cache. */
export function clearProfileImportReviewsForTests(): void {
  reviewedProfileImports.clear();
}

export interface ProfileListEntry {
  name: string;
  label: string;
  description: string | undefined;
  basePreset: string;
  plugins: string[];
  skills: string[];
  mcp: string[];
  agents: string[];
  mainInstruction: string | undefined;
  active: boolean;
  portableMemory: boolean;
  version: string | undefined;
}

export function listProfiles(cwd?: string): ProfileListEntry[] {
  const active = cwd
    ? resolveActiveWorkspaceProfile({ cwd, settings: new SettingsManager(cwd, "full") })?.name
    : undefined;
  return listWorkspaceProfiles().map((profile) => ({
    name: profile.name,
    label: profile.label,
    description: profile.description,
    basePreset: profile.basePreset,
    plugins: profile.plugins,
    skills: profile.skills,
    mcp: profile.mcp,
    agents: profile.agents,
    mainInstruction: profile.mainInstruction,
    active: profile.name === active,
    portableMemory: profile.portableMemory,
    version: profile.version,
  }));
}

export function activateProfile(cwd: string, name: string): void {
  const settings = new SettingsManager(cwd, "full");
  activateWorkspaceProfile(settings, name, cwd);
}

export function deactivateProfile(cwd: string): void {
  const settings = new SettingsManager(cwd, "full");
  deactivateWorkspaceProfile(settings, cwd);
}

/**
 * Rebind one existing work Session to another digital human. UI-only Sessions
 * do not have a core directory until their first run, so absence is a normal
 * `persisted: false` result; the renderer's Session index remains authoritative
 * until Engine materializes it with the same workspaceProfile.
 */
export function setSessionWorkspaceProfile(
  sessionId: string,
  profileName: string,
): { persisted: boolean } {
  if (!WORKSPACE_PROFILE_NAME_RE.test(profileName) || !readWorkspaceProfile(profileName)) {
    throw new Error(`Digital human "${profileName}" does not exist`);
  }
  const sessions = new SessionManager();
  if (!sessions.exists(sessionId)) return { persisted: false };
  const state = sessions.readSessionState(sessionId);
  if (!state) return { persisted: false };
  const persisted = sessions.saveStateOrUpdateFields(state, {
    workspaceProfile: profileName,
  });
  if (!persisted) throw new Error(`Could not switch digital human for Session ${sessionId}`);
  return { persisted: true };
}

export type ProfileCatalogEntry = DigitalHumanCatalogEntry & { installed: boolean };

const CATALOG_CATEGORIES = new Set(["product", "design", "engineering", "quality"]);

function normalizeCategory(value: string | undefined): DigitalHumanCatalogEntry["category"] {
  return value && CATALOG_CATEGORIES.has(value)
    ? (value as DigitalHumanCatalogEntry["category"])
    : "product";
}

/**
 * 广场 = 内置目录（现为空）+ 已注册数字人仓库提供的定义。
 *
 * 内置常量保留只为让远程目录接上来时 IPC 契约不变；实际内容全部来自用户添加的
 * 仓库，见 core 的 catalog-store。
 */
export function listProfileCatalog(): ProfileCatalogEntry[] {
  const bundled = DIGITAL_HUMAN_CATALOG.map((entry) => ({
    ...entry,
    installed: readWorkspaceProfile(entry.name) !== undefined,
  }));
  const fromRepos = readAllHumanRepoEntries().entries.map((entry) => ({
    ...entry.profile,
    category: normalizeCategory(entry.category),
    tags: entry.tags,
    samplePrompts: [],
    sourceRepo: entry.sourceRepo,
    installed: readWorkspaceProfile(entry.profile.name) !== undefined,
  }));
  return [...bundled, ...fromRepos];
}

export function installCatalogProfile(name: string): void {
  const bundled = DIGITAL_HUMAN_CATALOG.find((candidate) => candidate.name === name);
  if (bundled) {
    const { category: _c, tags: _t, samplePrompts: _s, ...profile } = bundled;
    saveWorkspaceProfile(profile);
    return;
  }
  const fromRepo = readAllHumanRepoEntries().entries.find((entry) => entry.profile.name === name);
  if (!fromRepo) throw new Error(`Unknown digital human catalog entry "${name}"`);
  saveWorkspaceProfile(fromRepo.profile);
}

/** 添加一个数字人仓库（克隆/更新）。会写磁盘并访问网络。 */
export async function addProfileRepo(repo: string) {
  return addHumanRepo(repo);
}

export function removeProfileRepo(repo: string): void {
  removeHumanRepo(repo);
}

export function listProfileRepos(): HumanRepoListEntry[] {
  return listHumanRepoDetails();
}

/**
 * 把选中的数字人导出成**一个可发布的仓库骨架**（humans.json + humans/<name>/
 * profile.json + README），而不是一份裸 JSON。
 *
 * 单个 JSON 只能靠人肉传文件；生成成仓库布局后，`git init && git push` 出去，
 * 别人填 `owner/repo` 就能装——这是「发布给别人用」缺的那一环。
 *
 * 与 exportProfileDefinition 一致：只写定义，绝不包含可移植记忆内容。
 */
export function exportProfileRepo(
  names: string[],
  destDir: string,
): { ok: true; written: string[] } {
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("Digital-human repo export requires at least one profile");
  }
  if (typeof destDir !== "string" || !destDir) {
    throw new Error("Digital-human repo export requires a destination directory");
  }
  const destInfo = lstatSync(destDir);
  if (destInfo.isSymbolicLink() || !destInfo.isDirectory()) {
    throw new Error("Digital-human repo export destination must be a regular directory");
  }

  const profiles: WorkspaceProfile[] = [];
  for (const name of names) {
    if (!WORKSPACE_PROFILE_NAME_RE.test(name)) throw new Error("invalid digital-human profile id");
    const profile = readWorkspaceProfile(name);
    if (!profile) throw new Error(`Digital human "${name}" is not installed`);
    profiles.push(profile);
  }

  const written: string[] = [];
  for (const profile of profiles) {
    const dir = join(destDir, "humans", profile.name);
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "profile.json");
    writeFileSync(target, `${JSON.stringify(profile, null, 2)}\n`, { encoding: "utf-8" });
    written.push(target);
  }

  const manifest = {
    name: basename(destDir),
    description: "codeshell digital humans",
    humans: profiles.map((profile) => ({
      name: profile.name,
      label: profile.label,
      ...(profile.description ? { description: profile.description } : {}),
      path: `./humans/${profile.name}`,
    })),
  };
  const manifestPath = join(destDir, "humans.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf-8" });
  written.push(manifestPath);

  const readmePath = join(destDir, "README.md");
  if (!lstatIfPresent(readmePath)) {
    const rows = profiles.map((p) => `| ${p.label} | \`${p.name}\` | ${p.basePreset} |`).join("\n");
    writeFileSync(
      readmePath,
      [
        `# ${basename(destDir)}`,
        "",
        "codeshell 数字人仓库。推到 GitHub 后，别人在",
        "**设置 › 数字人 › 数字人仓库** 填 `owner/repo` 即可安装。",
        "",
        "| 数字人 | ID | Preset |",
        "| --- | --- | --- |",
        rows,
        "",
        "> 只包含数字人定义，不含任何可移植记忆内容。",
        "",
      ].join("\n"),
      { encoding: "utf-8" },
    );
    written.push(readmePath);
  }

  return { ok: true, written };
}

export interface ProfileRequirementPreview extends RequirementPlanSummary {
  profileName: string;
  /** false → 没有要装的东西，UI 可直接跳过确认。 */
  needsInstall: boolean;
}

/**
 * 算出激活某数字人前要补齐的依赖。**只读**：不装任何东西，供 UI 先展示。
 *
 * 已装 skill 由 core scanner 提供（含 `plugin:skill` 命名空间的插件来源），
 * 因此冲突判断与运行时实际可见的集合一致。
 */
export function previewProfileRequirements(name: string, cwd: string): ProfileRequirementPreview {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) throw new Error("invalid digital-human profile id");
  const profile = readWorkspaceProfile(name);
  if (!profile) throw new Error(`Digital human "${name}" not found`);

  const installedSkills = scanSkills(cwd).map((skill) => ({
    name: skill.name,
    source: skill.source,
  }));
  const plan = planProfileRequirements(profile.requires, {
    installedSkills,
    toolProbe: probeTool,
  });
  return { profileName: name, needsInstall: plan.needsInstall, ...formatRequirementPlan(plan) };
}

/**
 * 按计划安装依赖。调用方必须已经拿到用户确认——本函数会启动子进程克隆远程仓库。
 *
 * 安装后让 skill 缓存失效，否则刚装的 skill 要等缓存过期才可见。
 */
export async function installProfileRequirements(
  name: string,
  cwd: string,
): Promise<{ ok: boolean; errors: string[] }> {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) throw new Error("invalid digital-human profile id");
  const profile = readWorkspaceProfile(name);
  if (!profile) throw new Error(`Digital human "${name}" not found`);

  const installedSkills = scanSkills(cwd).map((skill) => ({
    name: skill.name,
    source: skill.source,
  }));
  const plan = planProfileRequirements(profile.requires, {
    installedSkills,
    toolProbe: probeTool,
  });

  const errors: string[] = [];
  for (const { requirement } of plan.skillInstalls) {
    const result = await installSkillRequirement(requirement, cwd);
    if (!result.ok) errors.push(`${requirement.repo}: ${result.error}`);
  }
  // 新文件落地后必须让扫描缓存过期，否则本轮仍看不到刚装的 skill。
  invalidateSkillCache();
  return { ok: errors.length === 0, errors };
}

/** 探测外部命令版本；不存在返回 null（区别于「存在但版本低」）。 */
function probeTool(bin: string): string | null {
  // bin 来自 profile，故只允许命令名，绝不含路径分隔符或 shell 元字符。
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(bin)) return null;
  const probe = spawnSync(bin, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  if (probe.error || probe.status === null) return null;
  return `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim() || null;
}

/** Create or atomically update one user-owned digital-human definition. */
export function saveProfile(profile: WorkspaceProfile): void {
  saveWorkspaceProfile(profile);
}

export interface DeleteProfileOptions {
  cwd?: string;
  clearActiveProject?: boolean;
}

/**
 * Remove one library profile without leaving the active project or a team with
 * an immediately dangling reference. Other projects are resolved defensively
 * by core if they still contain an old profile id.
 */
export interface ProfileDeletionPreview {
  name: string;
  /** false → 存在硬阻塞，删除必定失败，UI 不该再弹「确认删除」。 */
  canDelete: boolean;
  /** 仍引用该数字人的团队名。 */
  blockingTeams: string[];
  /** 仍绑定该数字人的 Session id（最多 6 条）。 */
  blockingSessions: string[];
  /** 是当前项目默认——可恢复，删除时自动解绑，属提示而非阻塞。 */
  isActiveProjectDefault: boolean;
}

/**
 * 删除前的只读预检。
 *
 * deleteProfile 会在被团队或 Session 引用时抛错，但那发生在用户已经点过
 * 「确认删除」之后，且错误是带 Session id 的英文原文——用户既看不懂也无法据此
 * 行动。这里把同样的判断提前，让 UI 在确认框里就说清为什么删不了。
 */
export function previewProfileDeletion(name: string, cwd?: string): ProfileDeletionPreview {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) throw new Error("invalid digital-human profile id");

  const blockingTeams = listDigitalHumanTeams()
    .filter((team) => team.members.includes(name))
    .map((team) => team.name);
  const blockingSessions = new SessionManager().findSessionIdsByWorkspaceProfile(name, 6, {
    includeArchived: false,
  });

  let isActiveProjectDefault = false;
  if (cwd) {
    try {
      const settings = new SettingsManager(cwd, "full");
      isActiveProjectDefault = resolveActiveWorkspaceProfile({ cwd, settings })?.name === name;
    } catch {
      // 读不到项目 settings 不该让预检失败——它只是少一条提示。
    }
  }

  return {
    name,
    canDelete: blockingTeams.length === 0 && blockingSessions.length === 0,
    blockingTeams,
    blockingSessions,
    isActiveProjectDefault,
  };
}

export function deleteProfile(name: string, options: DeleteProfileOptions = {}): void {
  if (!WORKSPACE_PROFILE_NAME_RE.test(name)) throw new Error("invalid digital-human profile id");
  if (!readWorkspaceProfile(name)) return;

  const referencingTeams = listDigitalHumanTeams().filter((team) => team.members.includes(name));
  if (referencingTeams.length > 0) {
    throw new Error(
      `Digital human "${name}" is still used by team${
        referencingTeams.length > 1 ? "s" : ""
      }: ${referencingTeams.map((team) => team.name).join(", ")}`,
    );
  }

  const referencingSessions = new SessionManager().findSessionIdsByWorkspaceProfile(name, 6, {
    includeArchived: false,
  });
  if (referencingSessions.length > 0) {
    throw new Error(
      `Digital human "${name}" is still bound to active Session${
        referencingSessions.length > 1 ? "s" : ""
      }: ${referencingSessions.join(", ")}. Archive or delete those Sessions first.`,
    );
  }

  if (options.cwd) {
    const settings = new SettingsManager(options.cwd, "full");
    const active = resolveActiveWorkspaceProfile({ cwd: options.cwd, settings })?.name;
    if (active === name) {
      if (!options.clearActiveProject) {
        throw new Error(`Digital human "${name}" is the active project default`);
      }
      deactivateWorkspaceProfile(settings, options.cwd);
    }
  }

  deleteWorkspaceProfile(name);
}
