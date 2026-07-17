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
  type WorkspaceProfile,
} from "@cjhyy/code-shell-core";
import {
  activateWorkspaceProfile,
  deactivateWorkspaceProfile,
  deleteWorkspaceProfile,
  listWorkspaceProfiles,
  readWorkspaceProfile,
  resolveActiveWorkspaceProfile,
  saveWorkspaceProfile,
} from "@cjhyy/code-shell-core/internal";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
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

export type ProfileCatalogEntry = DigitalHumanCatalogEntry & { installed: boolean };

export function listProfileCatalog(): ProfileCatalogEntry[] {
  return DIGITAL_HUMAN_CATALOG.map((entry) => ({
    ...entry,
    installed: readWorkspaceProfile(entry.name) !== undefined,
  }));
}

export function installCatalogProfile(name: string): void {
  const entry = DIGITAL_HUMAN_CATALOG.find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`Unknown digital human catalog entry "${name}"`);
  const { category: _category, tags: _tags, ...profile } = entry;
  saveWorkspaceProfile(profile);
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

  const referencingSessions = new SessionManager().findSessionIdsByWorkspaceProfile(name, 6);
  if (referencingSessions.length > 0) {
    throw new Error(
      `Digital human "${name}" is pinned by existing Session${
        referencingSessions.length > 1 ? "s" : ""
      }: ${referencingSessions.join(", ")}. Delete those Sessions before deleting the profile.`,
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
