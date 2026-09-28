import {
  readLegacyPanelAppPackagePin,
  legacyPanelAppPackageSelection,
  rememberLegacyPanelAppPackagePin,
} from "./legacy-packages.js";
import type { PanelAppPackagePin } from "./bindings.js";
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, posix, relative, resolve, sep } from "node:path";
import { extractZip, extractZipSubdirectory } from "../plugins/installer/unzip.js";
import { downloadGitHubPanelAppArchive } from "./github-archive.js";
import { normalizeGitPanelAppSource } from "./source.js";
import { discoverPanelAppRoots, findPanelAppRoot } from "./discovery.js";
import { lock } from "../utils/lockfile.js";
import {
  PANEL_APP_META_FILE,
  PANEL_PACKAGE_LIMITS,
  createPanelPackageHash,
  hashPanelPackageFile,
} from "./package-content.js";
import {
  PANEL_APP_MANIFEST_FILE,
  PanelAppManifest,
  type PanelAppAgentContribution,
} from "./manifest.js";
import {
  PanelAppAlreadyInstalledError,
  PanelAppInstallError,
  PanelAppReviewChangedError,
  assertSafePanelAppId,
  panelAppInstallDir,
  panelAppPackageDir,
  panelAppsRoot,
} from "./paths.js";
import {
  readInstalledPanelAppsRegistry,
  InstalledPanelAppRecordSchema,
  removeInstalledPanelAppRecord,
  upsertInstalledPanelAppRecord,
  type InstalledPanelAppRecord,
} from "./registry.js";

const MAX_SOURCE_PATH = 4_096;
const {
  entries: MAX_ENTRIES,
  bytes: MAX_TOTAL_BYTES,
  fileBytes: MAX_FILE_BYTES,
  depth: MAX_DEPTH,
} = PANEL_PACKAGE_LIMITS;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_AGENT_SKILL_BYTES = 256 * 1024;
const REVIEWED_GIT_SNAPSHOT_TTL_MS = 10 * 60 * 1000;
const MAX_REVIEWED_GIT_SNAPSHOTS = 8;
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".mjs",
  ".md",
  ".css",
  ".json",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mp3",
  ".wav",
  ".woff",
  ".woff2",
  ".ttf",
]);
const ALLOWED_AGENT_ASSET_EXTENSIONS = new Set([".md", ".json", ".png", ".jpg", ".jpeg", ".webp"]);
const FORBIDDEN_AGENT_CONTENT = [
  ".claude-plugin",
  ".codex-plugin",
  ".codeshell-plugin",
  ".mcp.json",
  "agents",
  "commands",
  "hooks",
  "skills",
] as const;

export interface LocalPanelAppSourceInput {
  kind: "dir" | "zip";
  path: string;
}

export interface GitPanelAppSourceInput {
  kind: "git";
  url: string;
  ref?: string;
  subdir?: string;
}

export type PanelAppSourceInput = LocalPanelAppSourceInput | GitPanelAppSourceInput;
export type InstalledPanelAppSource = string | GitPanelAppSourceInput;

export interface PanelAppPreview {
  id: string;
  version: string;
  title: { default: string; en?: string; "zh-CN"?: string };
  description?: string;
  entry: string;
  icon: PanelAppManifest["icon"];
  singleton: boolean;
  permissions: PanelAppManifest["permissions"];
  agent?: PanelAppAgentContribution;
  nativeEntries?: PanelAppManifest["nativeEntries"];
  alreadyInstalled: boolean;
  reviewToken: string;
  source: { kind: PanelAppSourceInput["kind"]; label: string };
  warnings: string[];
}

export interface GitPanelAppDiscoveryCandidate {
  /** Repository-relative path, or "." when the repository root is the app. */
  subdir: string;
  source: GitPanelAppSourceInput;
  id: string;
  version: string;
  title: { default: string; en?: string; "zh-CN"?: string };
  description?: string;
  icon: PanelAppManifest["icon"];
}

export interface GitPanelAppDiscoveryIssue {
  subdir: string;
  error: string;
}

export interface GitPanelAppDiscovery {
  source: GitPanelAppSourceInput;
  panels: GitPanelAppDiscoveryCandidate[];
  issues: GitPanelAppDiscoveryIssue[];
}

export interface InstalledPanelApp {
  id: string;
  version: string;
  title: { default: string; en?: string; "zh-CN"?: string };
  description?: string;
  entry: string;
  icon: PanelAppManifest["icon"];
  singleton: boolean;
  permissions: PanelAppManifest["permissions"];
  agent?: PanelAppAgentContribution;
  nativeEntries?: PanelAppManifest["nativeEntries"];
  installPath: string;
  /** Payload identity, excluding Host installation timestamps and source metadata. */
  packageDigest?: string;
  source: InstalledPanelAppSource;
  installedAt: string;
  lastUpdated: string;
}

interface TreeBudget {
  entries: number;
  bytes: number;
}

interface OpenedGitPanelAppSource {
  source: GitPanelAppSourceInput;
  sourceKey: string;
  sourceRoot: string;
  temporaryRoot: string;
}

interface OpenedGitPanelAppArchive {
  source: GitPanelAppSourceInput;
  extractedRoot: string;
  temporaryRoot: string;
}

interface ReviewedGitPanelAppSnapshot extends OpenedGitPanelAppSource {
  id: string;
  reviewToken: string;
  createdAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
}

const reviewedGitPanelAppSnapshots = new Map<string, ReviewedGitPanelAppSnapshot>();

function validLocalSourceInput(input: LocalPanelAppSourceInput): boolean {
  return (
    Boolean(input) &&
    (input.kind === "dir" || input.kind === "zip") &&
    typeof input.path === "string" &&
    input.path.length > 0 &&
    input.path.length <= MAX_SOURCE_PATH &&
    !input.path.includes("\0")
  );
}

function normalizedGitSourceKey(input: GitPanelAppSourceInput): string {
  return JSON.stringify(normalizeGitPanelAppSource(input));
}

function joinedPanelAppSubdirectory(base: string | undefined, nested: string): string | undefined {
  const parts = [base, nested].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join("/") : undefined;
}

async function openGitPanelAppArchive(
  input: GitPanelAppSourceInput,
): Promise<OpenedGitPanelAppArchive> {
  const source = normalizeGitPanelAppSource(input);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cs-panel-app-git-"));
  try {
    const archivePath = join(temporaryRoot, "source.zip");
    const extractedRoot = join(temporaryRoot, "source");
    await mkdir(extractedRoot, { recursive: true, mode: 0o700 });
    await downloadGitHubPanelAppArchive(source, archivePath);
    await extractZipSubdirectory(archivePath, extractedRoot, source.subdir);
    await rm(archivePath, { force: true });
    return { source, extractedRoot, temporaryRoot };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

async function openGitPanelAppSource(
  input: GitPanelAppSourceInput,
): Promise<OpenedGitPanelAppSource> {
  const opened = await openGitPanelAppArchive(input);
  try {
    return {
      source: opened.source,
      sourceKey: JSON.stringify(opened.source),
      sourceRoot: await findPanelAppRoot(opened.extractedRoot),
      temporaryRoot: opened.temporaryRoot,
    };
  } catch (error) {
    await rm(opened.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Download a public GitHub repository once and enumerate every independently
 * installable Panel App beneath it. Discovery is read-only: selecting a result
 * still runs the normal full review and digest-bound install flow.
 */
export async function discoverGitPanelApps(
  input: GitPanelAppSourceInput,
): Promise<GitPanelAppDiscovery> {
  const opened = await openGitPanelAppArchive(input);
  try {
    const roots = await discoverPanelAppRoots(opened.extractedRoot);
    if (roots.length === 0) {
      throw new PanelAppInstallError(
        `no Panel App found (expected ${PANEL_APP_MANIFEST_FILE}); ` +
          "check the repository, branch, or optional search subdirectory",
      );
    }
    const panels: GitPanelAppDiscoveryCandidate[] = [];
    const issues: GitPanelAppDiscoveryIssue[] = [];
    for (const root of roots) {
      const nested = relative(opened.extractedRoot, root).split(sep).join(posix.sep);
      const subdir = joinedPanelAppSubdirectory(opened.source.subdir, nested);
      const label = subdir ?? ".";
      try {
        const inspected = await inspectPanelAppSource(root);
        panels.push({
          subdir: label,
          source: {
            kind: "git",
            url: opened.source.url,
            ...(opened.source.ref ? { ref: opened.source.ref } : {}),
            ...(subdir ? { subdir } : {}),
          },
          id: inspected.manifest.id,
          version: inspected.manifest.version,
          title: inspected.manifest.title,
          ...(inspected.manifest.description
            ? { description: inspected.manifest.description }
            : {}),
          icon: inspected.manifest.icon,
        });
      } catch (error) {
        issues.push({
          subdir: label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    panels.sort((left, right) => left.subdir.localeCompare(right.subdir));
    issues.sort((left, right) => left.subdir.localeCompare(right.subdir));
    if (panels.length === 0) {
      throw new PanelAppInstallError(
        `found ${issues.length} Panel App manifest(s), but none passed validation: ${issues
          .map((issue) => `${issue.subdir}: ${issue.error}`)
          .join("; ")}`,
      );
    }
    return { source: opened.source, panels, issues };
  } finally {
    await rm(opened.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function disposeReviewedGitSnapshot(snapshot: ReviewedGitPanelAppSnapshot): Promise<void> {
  clearTimeout(snapshot.expiryTimer);
  await rm(snapshot.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function removeReviewedGitSnapshot(
  key: string,
  expected?: ReviewedGitPanelAppSnapshot,
): Promise<void> {
  const snapshot = reviewedGitPanelAppSnapshots.get(key);
  if (!snapshot || (expected && snapshot !== expected)) return;
  reviewedGitPanelAppSnapshots.delete(key);
  await disposeReviewedGitSnapshot(snapshot);
}

async function cacheReviewedGitSnapshot(
  opened: OpenedGitPanelAppSource,
  id: string,
  reviewToken: string,
): Promise<void> {
  for (const [key, snapshot] of reviewedGitPanelAppSnapshots) {
    if (snapshot.sourceKey === opened.sourceKey) {
      await removeReviewedGitSnapshot(key, snapshot);
    }
  }
  while (reviewedGitPanelAppSnapshots.size >= MAX_REVIEWED_GIT_SNAPSHOTS) {
    const oldest = [...reviewedGitPanelAppSnapshots.entries()].sort(
      ([, left], [, right]) => left.createdAt - right.createdAt,
    )[0];
    if (!oldest) break;
    await removeReviewedGitSnapshot(oldest[0], oldest[1]);
  }
  const key = `${opened.sourceKey}\0${reviewToken}`;
  const snapshot: ReviewedGitPanelAppSnapshot = {
    ...opened,
    id,
    reviewToken,
    createdAt: Date.now(),
    expiryTimer: setTimeout(() => {
      void removeReviewedGitSnapshot(key, snapshot);
    }, REVIEWED_GIT_SNAPSHOT_TTL_MS),
  };
  snapshot.expiryTimer.unref?.();
  reviewedGitPanelAppSnapshots.set(key, snapshot);
}

function takeReviewedGitSnapshot(
  input: GitPanelAppSourceInput,
  reviewToken: string,
): ReviewedGitPanelAppSnapshot | undefined {
  const key = `${normalizedGitSourceKey(input)}\0${reviewToken}`;
  const snapshot = reviewedGitPanelAppSnapshots.get(key);
  if (!snapshot) return undefined;
  reviewedGitPanelAppSnapshots.delete(key);
  clearTimeout(snapshot.expiryTimer);
  return snapshot;
}

async function withPanelAppSourceRoot<T>(
  input: PanelAppSourceInput,
  operation: (root: string) => Promise<T>,
): Promise<T> {
  if (input.kind === "git") {
    const opened = await openGitPanelAppSource(input);
    try {
      return await operation(opened.sourceRoot);
    } finally {
      await rm(opened.temporaryRoot, { recursive: true, force: true });
    }
  }
  if (!validLocalSourceInput(input)) throw new PanelAppInstallError("Panel App source is invalid");
  if (input.kind === "dir") {
    if (!existsSync(input.path) || !(await stat(input.path)).isDirectory()) {
      throw new PanelAppInstallError(`source is not a directory: ${input.path}`);
    }
    return operation(await findPanelAppRoot(await realpath(input.path)));
  }
  if (!existsSync(input.path) || !(await stat(input.path)).isFile()) {
    throw new PanelAppInstallError(`archive is not a file: ${input.path}`);
  }
  const temporary = await mkdtemp(join(tmpdir(), "cs-panel-app-zip-"));
  try {
    await extractZip(input.path, temporary);
    return await operation(await findPanelAppRoot(temporary));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function walkBoundedTree(
  root: string,
  directory: string,
  depth: number,
  budget: TreeBudget,
  files: string[],
  directories: string[],
): Promise<void> {
  if (depth > MAX_DEPTH) {
    throw new PanelAppInstallError(`Panel App exceeds maximum directory depth ${MAX_DEPTH}`);
  }
  const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_ENTRIES) {
      throw new PanelAppInstallError(`Panel App contains more than ${MAX_ENTRIES} entries`);
    }
    const absolute = join(directory, entry.name);
    const relativePath = relative(root, absolute).split(sep).join("/");
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new PanelAppInstallError(`Panel App must not contain symlinks: ${relativePath}`);
    }
    if (info.isDirectory()) {
      directories.push(relativePath);
      await walkBoundedTree(root, absolute, depth + 1, budget, files, directories);
      continue;
    }
    if (!info.isFile()) {
      throw new PanelAppInstallError(`unsupported Panel App file type: ${relativePath}`);
    }
    if (info.size > MAX_FILE_BYTES) {
      throw new PanelAppInstallError(`Panel App file is too large: ${relativePath}`);
    }
    budget.bytes += info.size;
    if (budget.bytes > MAX_TOTAL_BYTES) {
      throw new PanelAppInstallError("Panel App exceeds the 64 MiB package limit");
    }
    files.push(relativePath);
  }
}

async function readManifest(sourceRoot: string): Promise<PanelAppManifest> {
  try {
    const raw = await readBoundedPackageFile(
      sourceRoot,
      PANEL_APP_MANIFEST_FILE,
      MAX_MANIFEST_BYTES,
    );
    return PanelAppManifest.parse(JSON.parse(raw.toString("utf8")));
  } catch (error) {
    throw new PanelAppInstallError(
      `invalid Panel App manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function readBoundedPackageFile(
  root: string,
  relativePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const candidate = join(root, ...relativePath.split("/"));
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > maxBytes) {
    throw new PanelAppInstallError(`Panel App file is not a bounded regular file: ${relativePath}`);
  }
  const physical = await realpath(candidate);
  if (physical !== root && !physical.startsWith(`${root}${sep}`)) {
    throw new PanelAppInstallError(`Panel App file escapes its package: ${relativePath}`);
  }
  const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) {
      throw new PanelAppInstallError(
        `Panel App file is not a bounded regular file: ${relativePath}`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function inspectPanelAppSource(sourceRoot: string): Promise<{
  manifest: PanelAppManifest;
  files: string[];
  digest: string;
  packageDigest: string;
}> {
  const root = await realpath(sourceRoot);
  const files: string[] = [];
  const directories: string[] = [];
  await walkBoundedTree(root, root, 0, { entries: 0, bytes: 0 }, files, directories);
  for (const forbidden of FORBIDDEN_AGENT_CONTENT) {
    if (
      [...directories, ...files].some(
        (entry) => entry === forbidden || entry.startsWith(`${forbidden}/`),
      )
    ) {
      throw new PanelAppInstallError(
        `Panel App packages cannot contain agent-plugin content '${forbidden}'`,
      );
    }
  }
  const manifest = await readManifest(root);
  assertSafePanelAppId(manifest.id);
  const entry = await realpath(resolve(root, ...manifest.entry.split("/"))).catch(() => "");
  if (!entry || (entry !== root && !entry.startsWith(`${root}${sep}`))) {
    throw new PanelAppInstallError(`Panel App entry escapes its package: ${manifest.entry}`);
  }
  if (!(await stat(entry)).isFile()) {
    throw new PanelAppInstallError(`Panel App entry is not a file: ${manifest.entry}`);
  }
  for (const [name, tool] of Object.entries(manifest.nativeEntries ?? {})) {
    if (!files.includes(tool.entry))
      throw new PanelAppInstallError(`native entry is missing: ${name}`);
    const bytes = await readBoundedPackageFile(root, tool.entry, MAX_FILE_BYTES);
    if (createHash("sha256").update(bytes).digest("hex") !== tool.sha256)
      throw new PanelAppInstallError(`native entry hash does not match: ${name}`);
  }
  const assetRoot = posix.dirname(manifest.entry);
  const agent = manifest.schemaVersion === 2 ? manifest.agent : undefined;
  const declaredAgentRoots = new Set((agent?.skills ?? []).map((entry) => posix.dirname(entry)));
  for (const skillEntry of agent?.skills ?? []) {
    if (!files.includes(skillEntry)) {
      throw new PanelAppInstallError(`declared Panel App skill is missing: ${skillEntry}`);
    }
    const skillInfo = await lstat(join(root, ...skillEntry.split("/")));
    if (!skillInfo.isFile() || skillInfo.size > MAX_AGENT_SKILL_BYTES) {
      throw new PanelAppInstallError(
        `declared Panel App skill must be a file no larger than 256 KiB: ${skillEntry}`,
      );
    }
    await readBoundedPackageFile(root, skillEntry, MAX_AGENT_SKILL_BYTES);
  }
  for (const file of files) {
    if (file === PANEL_APP_MANIFEST_FILE || file === PANEL_APP_META_FILE) continue;
    const relation = posix.relative(assetRoot, file);
    if (relation === ".." || relation.startsWith("../") || posix.isAbsolute(relation)) {
      if (file === "README.md" || file === "LICENSE" || file === "LICENSE.md") continue;
      if (
        [...declaredAgentRoots].some(
          (rootEntry) => file === rootEntry || file.startsWith(`${rootEntry}/`),
        )
      ) {
        if (!ALLOWED_AGENT_ASSET_EXTENSIONS.has(extname(file).toLowerCase())) {
          throw new PanelAppInstallError(`unsupported Panel App agent asset extension: ${file}`);
        }
        continue;
      }
      throw new PanelAppInstallError(`Panel App content must live beside its entry point: ${file}`);
    }
    if (!ALLOWED_ASSET_EXTENSIONS.has(extname(file).toLowerCase())) {
      throw new PanelAppInstallError(`unsupported Panel App asset extension: ${file}`);
    }
  }
  const hash = createHash("sha256");
  const payloadHash = createPanelPackageHash();
  for (const file of files.sort()) {
    const bytes = await readBoundedPackageFile(
      root,
      file,
      file === PANEL_APP_MANIFEST_FILE ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES,
    );
    hash.update(file).update("\0").update(bytes);
    hashPanelPackageFile(payloadHash, file, bytes);
  }
  return { manifest, files, digest: hash.digest("hex"), packageDigest: payloadHash.digest("hex") };
}

function previewFrom(
  manifest: PanelAppManifest,
  reviewToken: string,
  input: PanelAppSourceInput,
): PanelAppPreview {
  const source = input.kind === "git" ? normalizeGitPanelAppSource(input) : input;
  return {
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    ...(manifest.description ? { description: manifest.description } : {}),
    entry: manifest.entry,
    ...(manifest.nativeEntries ? { nativeEntries: structuredClone(manifest.nativeEntries) } : {}),
    icon: manifest.icon,
    singleton: manifest.singleton,
    permissions: [...manifest.permissions],
    ...(manifest.schemaVersion === 2 && manifest.agent
      ? {
          agent: {
            tools: manifest.agent.tools.map((tool) => ({
              ...tool,
              inputSchema: { ...tool.inputSchema },
            })),
            skills: [...manifest.agent.skills],
          },
        }
      : {}),
    alreadyInstalled: existsSync(panelAppInstallDir(manifest.id)),
    reviewToken,
    source: {
      kind: input.kind,
      label:
        source.kind === "git"
          ? `${new URL(source.url).pathname.replace(/^\/|\.git$/g, "")}${
              source.subdir ? `/${source.subdir}` : ""
            }`
          : basename(source.path),
    },
    warnings: [
      ...(manifest.permissions.length > 0
        ? [`Panel App requests ${manifest.permissions.length} host permission(s)`]
        : []),
      ...(manifest.schemaVersion === 2 && manifest.agent
        ? [
            `Panel App contributes ${manifest.agent.tools.length} Agent tool(s) and ${manifest.agent.skills.length} Skill(s)`,
          ]
        : []),
    ],
  };
}

export async function previewLocalPanelApp(input: PanelAppSourceInput): Promise<PanelAppPreview> {
  if (input.kind === "git") {
    const opened = await openGitPanelAppSource(input);
    let retained = false;
    try {
      const inspected = await inspectPanelAppSource(opened.sourceRoot);
      const preview = previewFrom(inspected.manifest, inspected.digest, opened.source);
      await cacheReviewedGitSnapshot(opened, preview.id, preview.reviewToken);
      retained = true;
      return preview;
    } finally {
      if (!retained) {
        await rm(opened.temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
  return withPanelAppSourceRoot(input, async (sourceRoot) => {
    const inspected = await inspectPanelAppSource(sourceRoot);
    return previewFrom(inspected.manifest, inspected.digest, input);
  });
}

async function installedPanelAppSource(id: string): Promise<PanelAppSourceInput> {
  assertSafePanelAppId(id);
  const record = (await readInstalledPanelAppsRegistry()).find((candidate) => candidate.id === id);
  if (!record) throw new PanelAppInstallError(`Panel App '${id}' has no installed source record`);
  if (typeof record.source !== "string") {
    return normalizeGitPanelAppSource(record.source);
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(record.source);
  } catch {
    throw new PanelAppInstallError(
      `original source for Panel App '${id}' is unavailable: ${record.source}`,
    );
  }
  if (info.isDirectory()) return { kind: "dir", path: record.source };
  if (info.isFile() && extname(record.source).toLowerCase() === ".zip") {
    return { kind: "zip", path: record.source };
  }
  throw new PanelAppInstallError(
    `original source for Panel App '${id}' is not a folder or zip archive`,
  );
}

/**
 * Re-open the original folder, archive, or GitHub source through the same
 * bounded installer review. This is the repo-development path: edit or push
 * source files, review the new digest, then explicitly apply the update.
 */
export async function previewInstalledPanelAppUpdate(id: string): Promise<PanelAppPreview> {
  const input = await installedPanelAppSource(id);
  const preview = await previewLocalPanelApp(input);
  if (preview.id !== id) {
    if (input.kind === "git") {
      const snapshot = takeReviewedGitSnapshot(input, preview.reviewToken);
      if (snapshot) await disposeReviewedGitSnapshot(snapshot);
    }
    throw new PanelAppInstallError(
      `original source now declares Panel App '${preview.id}', expected '${id}'`,
    );
  }
  return preview;
}

async function replaceInstalledDirectory(
  id: string,
  staging: string,
  overwrite: boolean,
): Promise<{ backup?: string }> {
  const finalDir = panelAppInstallDir(id);
  if (!existsSync(finalDir)) {
    await rename(staging, finalDir);
    return {};
  }
  if (!overwrite) {
    throw new PanelAppAlreadyInstalledError(id);
  }
  const backup = join(panelAppsRoot(), `.backup-${id}-${randomUUID()}`);
  await rename(finalDir, backup);
  try {
    await rename(staging, finalDir);
    return { backup };
  } catch (error) {
    await rename(backup, finalDir).catch(() => undefined);
    throw error;
  }
}

/** Keep reviewed CAS checks and a same-app directory swap indivisible across hosts. */
async function lockPanelAppMutation(id: string): Promise<() => Promise<void>> {
  const root = panelAppsRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const locks = join(root, ".operations");
  const target = join(locks, id);
  for (const directory of [root, locks, target]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new PanelAppInstallError("Panel App operation locks require ordinary directories");
    }
  }
  return lock(target, {
    realpath: true,
    stale: 30_000,
    retries: { retries: 30, minTimeout: 10, maxTimeout: 250, factor: 1.4 },
  });
}

async function checkedPackageParents(id: string, create = false): Promise<void> {
  assertSafePanelAppId(id);
  const root = panelAppsRoot();
  for (const directory of [root, join(root, ".versions"), join(root, ".versions", id)]) {
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new PanelAppInstallError("Panel App package store requires ordinary directories");
  }
}

/** Resolve exactly one retained payload. A missing/corrupt pin never follows the latest catalog. */
export async function resolvePanelAppPackage(
  id: string,
  packageDigest: string,
): Promise<InstalledPanelApp> {
  const target = panelAppPackageDir(id, packageDigest);
  await checkedPackageParents(id);
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new PanelAppInstallError("Panel App package must be an ordinary directory");
  const inspected = await inspectPanelAppSource(target);
  if (inspected.manifest.id !== id || inspected.packageDigest !== packageDigest)
    throw new PanelAppInstallError("Retained Panel App package content has changed");
  const metadata = JSON.parse(
    (
      await readBoundedPackageFile(await realpath(target), PANEL_APP_META_FILE, MAX_MANIFEST_BYTES)
    ).toString("utf8"),
  );
  const { schemaVersion, ...rawRecord } = metadata;
  const record = InstalledPanelAppRecordSchema.parse(rawRecord);
  if (schemaVersion !== 1 || record.id !== id || record.version !== inspected.manifest.version)
    throw new PanelAppInstallError("Retained Panel App package metadata does not match");
  return { ...installedPanelApp(inspected.manifest, record), installPath: target, packageDigest };
}

/** Inventory verified retained bytes; registry membership remains installation authority. */
export async function listRetainedPanelAppPackages(id: string): Promise<{
  packages: InstalledPanelApp[];
  unavailableDigests: string[];
}> {
  assertSafePanelAppId(id);
  const authorized = async () => {
    if (!(await readInstalledPanelAppsRegistry()).some((app) => app.id === id))
      throw new PanelAppInstallError("Panel App is not installed");
  };
  await authorized();
  try {
    await checkedPackageParents(id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { packages: [], unavailableDigests: [] };
    throw error;
  }
  const digests: string[] = [];
  let examined = 0;
  for await (const entry of await opendir(join(panelAppsRoot(), ".versions", id))) {
    if (++examined > 512) throw new PanelAppInstallError("Too many retained package entries");
    if (/^[a-f0-9]{64}$/.test(entry.name)) digests.push(entry.name);
  }
  if (digests.length > 128) throw new PanelAppInstallError("Too many retained Panel packages");
  const packages: InstalledPanelApp[] = [];
  const unavailableDigests: string[] = [];
  for (const digest of digests.sort()) {
    try {
      packages.push(await resolvePanelAppPackage(id, digest));
    } catch {
      unavailableDigests.push(digest);
    }
  }
  await authorized();
  return { packages, unavailableDigests };
}

interface PreparedPackage {
  publish(): Promise<InstalledPanelApp>;
  dispose(): Promise<void>;
}

/** Stage under the operation lock; no retained address appears before the Host commit guard. */
async function prepareRetainedPackage(
  sourceRoot: string,
  packageDigest: string,
  record: InstalledPanelAppRecord,
): Promise<PreparedPackage> {
  const target = panelAppPackageDir(record.id, packageDigest);
  const parentsPresent = await checkedPackageParents(record.id)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return false;
    });
  const existing = parentsPresent
    ? await lstat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      })
    : null;
  // A corrupt retained address is never repaired by overwriting bytes behind a pin.
  if (existing) {
    const retained = await resolvePanelAppPackage(record.id, packageDigest);
    return { publish: async () => retained, dispose: async () => {} };
  }
  const staging = await mkdtemp(join(panelAppsRoot(), `.tmp-retained-${record.id}-`));
  const dispose = () => rm(staging, { recursive: true, force: true });
  try {
    await cp(sourceRoot, staging, { recursive: true, preserveTimestamps: true });
    const copied = await inspectPanelAppSource(staging);
    if (
      copied.manifest.id !== record.id ||
      copied.manifest.version !== record.version ||
      copied.packageDigest !== packageDigest
    )
      throw new PanelAppReviewChangedError();
    await writeFile(
      join(staging, PANEL_APP_META_FILE),
      JSON.stringify({ schemaVersion: 1, ...record }) + "\n",
      { mode: 0o600 },
    );
    return {
      async publish() {
        await checkedPackageParents(record.id, true);
        // A prior prepared package in this operation can have the same payload.
        const exists = await lstat(target).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return null;
        });
        if (exists) return resolvePanelAppPackage(record.id, packageDigest);
        await rename(staging, target);
        return {
          ...installedPanelApp(copied.manifest, record),
          installPath: target,
          packageDigest,
        };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

/** Materialize a legacy installed package before a project records its reviewed pin. */
export async function retainInstalledPanelApp(
  id: string,
  expectedPackageDigest: string,
): Promise<InstalledPanelApp> {
  panelAppPackageDir(id, expectedPackageDigest);
  const release = await lockPanelAppMutation(id);
  try {
    const record = (await readInstalledPanelAppsRegistry()).find((app) => app.id === id);
    if (!record) throw new PanelAppInstallError("Panel App is not installed");
    const source = panelAppInstallDir(id);
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new PanelAppInstallError("Panel App installation must be an ordinary directory");
    const inspected = await inspectPanelAppSource(source);
    if (inspected.packageDigest !== expectedPackageDigest) throw new PanelAppReviewChangedError();
    const prepared = await prepareRetainedPackage(source, expectedPackageDigest, record);
    try {
      const retained = await prepared.publish();
      const legacy = legacyPanelAppPackageSelection(id);
      await rememberLegacyPanelAppPackagePin(
        id,
        legacy === undefined
          ? { version: retained.version, packageDigest: expectedPackageDigest }
          : legacy,
      );
      return retained;
    } finally {
      await prepared.dispose();
    }
  } finally {
    await release();
  }
}

async function installReviewedPanelAppFromRoot(
  sourceRoot: string,
  input: PanelAppSourceInput,
  expectedReviewToken: string,
  installedAt: string,
  options: {
    overwrite?: boolean;
    expectedId?: string;
    beforeCommit?: () => void | Promise<void>;
    recordedRef?: string;
  },
): Promise<InstalledPanelApp> {
  const inspected = await inspectPanelAppSource(sourceRoot);
  if (options.expectedId && inspected.manifest.id !== options.expectedId) {
    throw new PanelAppInstallError(
      `original source now declares Panel App '${inspected.manifest.id}', expected '${options.expectedId}'`,
    );
  }
  if (inspected.digest !== expectedReviewToken) throw new PanelAppReviewChangedError();
  await mkdir(panelAppsRoot(), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(panelAppsRoot(), `.tmp-${inspected.manifest.id}-`));
  let backup: string | undefined;
  let directoryReplaced = false;
  const retainedPackages: PreparedPackage[] = [];
  let legacyPin: PanelAppPackagePin | null | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    await cp(sourceRoot, staging, { recursive: true });
    const copied = await inspectPanelAppSource(staging);
    if (copied.digest !== expectedReviewToken) throw new PanelAppReviewChangedError();
    const storedSource: InstalledPanelAppSource =
      input.kind === "git"
        ? normalizeGitPanelAppSource({
            ...input,
            ...(options.recordedRef ? { ref: options.recordedRef } : {}),
          })
        : input.path;
    await writeFile(
      join(staging, PANEL_APP_META_FILE),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: copied.manifest.id,
          version: copied.manifest.version,
          source: storedSource,
          installedAt,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    release = await lockPanelAppMutation(copied.manifest.id);
    if (!options.overwrite && existsSync(panelAppInstallDir(copied.manifest.id)))
      throw new PanelAppAlreadyInstalledError(copied.manifest.id);
    const previous = (await readInstalledPanelAppsRegistry()).find(
      (candidate) => candidate.id === copied.manifest.id,
    );
    // Keep the old payload before replacing its legacy catalog path. Existing
    // project pins and task recovery can retain the exact bytes after an update.
    if (previous && options.overwrite) {
      legacyPin = null; // A broken legacy installation cannot silently adopt the replacement.
      const oldRoot = panelAppInstallDir(previous.id);
      const oldInfo = await lstat(oldRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (oldInfo && (oldInfo.isSymbolicLink() || !oldInfo.isDirectory()))
        throw new PanelAppInstallError("Panel App installation must be an ordinary directory");
      const old = oldInfo
        ? await inspectPanelAppSource(oldRoot).catch((error) => {
            // Reinstalling remains a repair path for an incomplete legacy catalog.
            // Never copy corrupt bytes into a retained address; existing pins keep
            // their own immutable snapshot and are checked separately below.
            if (
              error instanceof PanelAppInstallError ||
              (error as NodeJS.ErrnoException).code === "ENOENT"
            )
              return null;
            throw error;
          })
        : null;
      if (old) {
        legacyPin = { version: old.manifest.version, packageDigest: old.packageDigest };
        if (old.manifest.id !== previous.id)
          throw new PanelAppInstallError("Installed Panel App ID does not match its record");
        retainedPackages.push(
          await prepareRetainedPackage(oldRoot, old.packageDigest, {
            ...previous,
            version: old.manifest.version,
          }),
        );
      }
    }
    const savedLegacy = previous
      ? legacyPanelAppPackageSelection(copied.manifest.id)
      : readLegacyPanelAppPackagePin(copied.manifest.id);
    if (savedLegacy !== undefined) legacyPin = savedLegacy;
    const nextRecord: InstalledPanelAppRecord = {
      id: copied.manifest.id,
      version: copied.manifest.version,
      source: storedSource,
      installedAt: previous?.installedAt ?? installedAt,
      lastUpdated: installedAt,
    };
    // A partial restore of only the current catalog must not upgrade dormant projects.
    // Payload hashes already exclude this Host metadata.
    await writeFile(
      join(staging, PANEL_APP_META_FILE),
      JSON.stringify({
        schemaVersion: 1,
        ...nextRecord,
        ...(legacyPin === undefined ? {} : { legacyProjectPin: legacyPin }),
      }) + "\n",
      { mode: 0o600 },
    );
    retainedPackages.push(await prepareRetainedPackage(staging, copied.packageDigest, nextRecord));
    // Hosts may need to recheck a reviewed revision and the authenticated owner
    // after staging work, immediately before making the installed snapshot visible.
    await options.beforeCommit?.();
    for (const retained of retainedPackages) await retained.publish();
    if (legacyPin !== undefined)
      await rememberLegacyPanelAppPackagePin(copied.manifest.id, legacyPin);
    ({ backup } = await replaceInstalledDirectory(
      copied.manifest.id,
      staging,
      options.overwrite === true,
    ));
    directoryReplaced = true;
    await upsertInstalledPanelAppRecord(nextRecord);
    if (backup) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
    return {
      ...installedPanelApp(copied.manifest, nextRecord),
      packageDigest: copied.packageDigest,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (directoryReplaced) {
      const finalDir = panelAppInstallDir(inspected.manifest.id);
      await rm(finalDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (backup) {
      const finalDir = panelAppInstallDir(inspected.manifest.id);
      await rename(backup, finalDir).catch(() => undefined);
    }
    throw error;
  } finally {
    try {
      for (const retained of retainedPackages) await retained.dispose();
    } finally {
      await release?.();
    }
  }
}

export async function installReviewedLocalPanelApp(
  input: PanelAppSourceInput,
  expectedReviewToken: string,
  installedAt: string,
  options: {
    overwrite?: boolean;
    expectedId?: string;
    /** Recheck host authorization/CAS after staging, before directory replacement. */
    beforeCommit?: () => void | Promise<void>;
    /** Keep the original update branch while installing a separately pinned SHA. */
    recordedRef?: string;
  } = {},
): Promise<InstalledPanelApp> {
  if (!/^[a-f0-9]{64}$/.test(expectedReviewToken)) {
    throw new PanelAppInstallError("Panel App review token is invalid");
  }
  if (input.kind === "git") {
    const snapshot = takeReviewedGitSnapshot(input, expectedReviewToken);
    if (snapshot) {
      try {
        return await installReviewedPanelAppFromRoot(
          snapshot.sourceRoot,
          snapshot.source,
          expectedReviewToken,
          installedAt,
          options,
        );
      } finally {
        await disposeReviewedGitSnapshot(snapshot);
      }
    }
  }
  return withPanelAppSourceRoot(input, (sourceRoot) =>
    installReviewedPanelAppFromRoot(sourceRoot, input, expectedReviewToken, installedAt, options),
  );
}

export async function installReviewedPanelAppUpdate(
  id: string,
  expectedReviewToken: string,
  installedAt: string,
): Promise<InstalledPanelApp> {
  const input = await installedPanelAppSource(id);
  return installReviewedLocalPanelApp(input, expectedReviewToken, installedAt, {
    overwrite: true,
    expectedId: id,
  });
}

function installedPanelApp(
  manifest: PanelAppManifest,
  record: InstalledPanelAppRecord,
): InstalledPanelApp {
  return {
    id: manifest.id,
    version: manifest.version,
    title: manifest.title,
    ...(manifest.description ? { description: manifest.description } : {}),
    entry: manifest.entry,
    ...(manifest.nativeEntries ? { nativeEntries: structuredClone(manifest.nativeEntries) } : {}),
    icon: manifest.icon,
    singleton: manifest.singleton,
    permissions: [...manifest.permissions],
    ...(manifest.schemaVersion === 2 && manifest.agent
      ? {
          agent: {
            tools: manifest.agent.tools.map((tool) => ({
              ...tool,
              inputSchema: { ...tool.inputSchema },
            })),
            skills: [...manifest.agent.skills],
          },
        }
      : {}),
    installPath: panelAppInstallDir(manifest.id),
    source: record.source,
    installedAt: record.installedAt,
    lastUpdated: record.lastUpdated,
  };
}

export async function listInstalledPanelApps(appId?: string): Promise<InstalledPanelApp[]> {
  if (appId !== undefined) assertSafePanelAppId(appId);
  const output: InstalledPanelApp[] = [];
  for (const record of await readInstalledPanelAppsRegistry()) {
    if (appId !== undefined && record.id !== appId) continue;
    try {
      const root = await realpath(panelAppInstallDir(record.id));
      const inspected = await inspectPanelAppSource(root);
      if (inspected.manifest.id !== record.id) continue;
      output.push({
        ...installedPanelApp(inspected.manifest, record),
        packageDigest: inspected.packageDigest,
      });
    } catch {
      // One corrupt/missing app must not hide the rest of the catalog.
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

export async function uninstallPanelApp(
  id: string,
  options: { beforeCommit?: () => void | Promise<void> } = {},
): Promise<void> {
  assertSafePanelAppId(id);
  const release = await lockPanelAppMutation(id);
  try {
    const directory = panelAppInstallDir(id);
    if (!existsSync(directory))
      throw new PanelAppInstallError(`Panel App '${id}' is not installed`);
    const quarantine = join(panelAppsRoot(), `.remove-${id}-${randomUUID()}`);
    let retained: PreparedPackage | undefined;
    let legacyPin: PanelAppPackagePin | null = null;
    if (readLegacyPanelAppPackagePin(id) === undefined) {
      const record = (await readInstalledPanelAppsRegistry()).find((app) => app.id === id);
      const savedLegacy = legacyPanelAppPackageSelection(id);
      if (savedLegacy !== undefined) legacyPin = savedLegacy;
      const info = await lstat(directory);
      const inspected =
        info.isDirectory() && !info.isSymbolicLink()
          ? await inspectPanelAppSource(directory).catch(() => null)
          : null;
      if (record && inspected?.manifest.id === id) {
        if (savedLegacy === undefined)
          legacyPin = {
            version: inspected.manifest.version,
            packageDigest: inspected.packageDigest,
          };
        retained = await prepareRetainedPackage(directory, inspected.packageDigest, {
          ...record,
          version: inspected.manifest.version,
        });
      }
    }
    try {
      await options.beforeCommit?.();
      await retained?.publish();
      await rememberLegacyPanelAppPackagePin(id, legacyPin);
    } finally {
      await retained?.dispose();
    }
    await rename(directory, quarantine);
    try {
      await removeInstalledPanelAppRecord(id);
    } catch (error) {
      await rename(quarantine, directory).catch(() => undefined);
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
  } finally {
    await release();
  }
}
