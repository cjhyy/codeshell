import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, posix, relative, resolve, sep } from "node:path";
import { extractZip } from "../plugins/installer/unzip.js";
import { gitClone } from "../plugins/gitOps.js";
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
  panelAppsRoot,
} from "./paths.js";
import {
  readInstalledPanelAppsRegistry,
  removeInstalledPanelAppRecord,
  upsertInstalledPanelAppRecord,
  type InstalledPanelAppRecord,
} from "./registry.js";

const PANEL_APP_META_FILE = ".cs-panel-app-meta.json";
const MAX_SOURCE_PATH = 4_096;
const MAX_ENTRIES = 2_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 16;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_AGENT_SKILL_BYTES = 256 * 1024;
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
  alreadyInstalled: boolean;
  reviewToken: string;
  source: { kind: PanelAppSourceInput["kind"]; label: string };
  warnings: string[];
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
  installPath: string;
  source: InstalledPanelAppSource;
  installedAt: string;
  lastUpdated: string;
}

interface TreeBudget {
  entries: number;
  bytes: number;
}

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

function normalizeGitPanelAppSource(input: GitPanelAppSourceInput): GitPanelAppSourceInput {
  if (!input || input.kind !== "git" || typeof input.url !== "string") {
    throw new PanelAppInstallError("GitHub Panel App source is invalid");
  }
  const raw = input.url.trim();
  if (!raw || raw.length > MAX_SOURCE_PATH || raw.includes("\0")) {
    throw new PanelAppInstallError("GitHub repository URL is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PanelAppInstallError("GitHub repository URL is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.toLowerCase() !== "github.com" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.search ||
    parsed.hash
  ) {
    throw new PanelAppInstallError(
      "Panel Apps support public https://github.com repositories only",
    );
  }
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    throw new PanelAppInstallError("GitHub URL must include owner/repository");
  }
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new PanelAppInstallError("GitHub owner or repository name is invalid");
  }

  let urlRef: string | undefined;
  let urlSubdir: string | undefined;
  if (parts.length > 2) {
    if (parts[2] !== "tree" || !parts[3]) {
      throw new PanelAppInstallError("GitHub URL must point to a repository or /tree/<ref>/<path>");
    }
    urlRef = decodeURIComponent(parts[3]);
    urlSubdir =
      parts.length > 4
        ? parts
            .slice(4)
            .map((part) => decodeURIComponent(part))
            .join("/")
        : undefined;
  }
  if ((input.ref && urlRef) || (input.subdir && urlSubdir)) {
    throw new PanelAppInstallError(
      "GitHub tree URLs cannot be combined with separate ref or subdirectory fields",
    );
  }
  const ref = input.ref?.trim() || urlRef;
  const subdir = input.subdir?.trim().replaceAll("\\", "/") || urlSubdir;
  if (
    ref &&
    (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(ref) ||
      ref.includes("..") ||
      ref.includes("//") ||
      ref.endsWith("/") ||
      ref.endsWith(".lock"))
  ) {
    throw new PanelAppInstallError("GitHub branch, tag, or commit is invalid");
  }
  if (subdir) {
    const segments = subdir.split("/");
    if (
      subdir.length > 1_024 ||
      subdir.startsWith("/") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new PanelAppInstallError("GitHub Panel App subdirectory is invalid");
    }
  }
  return {
    kind: "git",
    url: `https://github.com/${owner}/${repo}.git`,
    ...(ref ? { ref } : {}),
    ...(subdir ? { subdir } : {}),
  };
}

function looksLikePanelAppRoot(directory: string): boolean {
  return existsSync(join(directory, PANEL_APP_MANIFEST_FILE));
}

async function findPanelAppRoot(directory: string): Promise<string> {
  if (looksLikePanelAppRoot(directory)) return directory;
  const entries = await readdir(directory, { withFileTypes: true });
  const children = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  if (children.length === 1) {
    const nested = join(directory, children[0].name);
    if (looksLikePanelAppRoot(nested)) return nested;
  }
  throw new PanelAppInstallError(`no Panel App found (expected ${PANEL_APP_MANIFEST_FILE})`);
}

async function withPanelAppSourceRoot<T>(
  input: PanelAppSourceInput,
  operation: (root: string) => Promise<T>,
): Promise<T> {
  if (input.kind === "git") {
    const source = normalizeGitPanelAppSource(input);
    const temporary = await mkdtemp(join(tmpdir(), "cs-panel-app-git-"));
    try {
      const clone = await gitClone(source.url, temporary, {
        ...(source.ref ? { ref: source.ref } : {}),
        full: true,
      });
      if (!clone.ok) throw new PanelAppInstallError(`GitHub clone failed: ${clone.error}`);
      let root = temporary;
      if (source.subdir) {
        const candidate = resolve(temporary, ...source.subdir.split("/"));
        const resolved = await realpath(candidate).catch(() => "");
        const cloneRoot = await realpath(temporary);
        if (!resolved || !resolved.startsWith(`${cloneRoot}${sep}`)) {
          throw new PanelAppInstallError(
            `Panel App subdirectory was not found in the repository: ${source.subdir}`,
          );
        }
        root = resolved;
      }
      return await operation(await findPanelAppRoot(root));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  if (!validLocalSourceInput(input)) throw new PanelAppInstallError("Panel App source is invalid");
  if (input.kind === "dir") {
    if (!existsSync(input.path) || !(await stat(input.path)).isDirectory()) {
      throw new PanelAppInstallError(`source is not a directory: ${input.path}`);
    }
    return operation(await findPanelAppRoot(input.path));
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
  const file = join(sourceRoot, PANEL_APP_MANIFEST_FILE);
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(file);
  } catch {
    throw new PanelAppInstallError(`missing ${PANEL_APP_MANIFEST_FILE}`);
  }
  if (!info.isFile() || info.size > MAX_MANIFEST_BYTES) {
    throw new PanelAppInstallError(
      `${PANEL_APP_MANIFEST_FILE} must be a regular file no larger than 1 MiB`,
    );
  }
  try {
    return PanelAppManifest.parse(JSON.parse(await readFile(file, "utf-8")));
  } catch (error) {
    throw new PanelAppInstallError(
      `invalid Panel App manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function inspectPanelAppSource(sourceRoot: string): Promise<{
  manifest: PanelAppManifest;
  files: string[];
  digest: string;
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
  const assetRoot = posix.dirname(manifest.entry);
  const agent = manifest.schemaVersion === 2 ? manifest.agent : undefined;
  const declaredAgentRoots = new Set((agent?.skills ?? []).map((entry) => posix.dirname(entry)));
  for (const skillEntry of agent?.skills ?? []) {
    if (!files.includes(skillEntry)) {
      throw new PanelAppInstallError(`declared Panel App skill is missing: ${skillEntry}`);
    }
    const skillInfo = await stat(join(root, ...skillEntry.split("/")));
    if (!skillInfo.isFile() || skillInfo.size > MAX_AGENT_SKILL_BYTES) {
      throw new PanelAppInstallError(
        `declared Panel App skill must be a file no larger than 256 KiB: ${skillEntry}`,
      );
    }
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
  for (const file of files.sort()) {
    hash
      .update(file)
      .update("\0")
      .update(await readFile(join(root, ...file.split("/"))));
  }
  return { manifest, files, digest: hash.digest("hex") };
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

export async function installReviewedLocalPanelApp(
  input: PanelAppSourceInput,
  expectedReviewToken: string,
  installedAt: string,
  options: { overwrite?: boolean } = {},
): Promise<InstalledPanelApp> {
  if (!/^[a-f0-9]{64}$/.test(expectedReviewToken)) {
    throw new PanelAppInstallError("Panel App review token is invalid");
  }
  return withPanelAppSourceRoot(input, async (sourceRoot) => {
    const inspected = await inspectPanelAppSource(sourceRoot);
    if (inspected.digest !== expectedReviewToken) throw new PanelAppReviewChangedError();
    await mkdir(panelAppsRoot(), { recursive: true, mode: 0o700 });
    const staging = await mkdtemp(join(panelAppsRoot(), `.tmp-${inspected.manifest.id}-`));
    let backup: string | undefined;
    let directoryReplaced = false;
    try {
      await cp(sourceRoot, staging, { recursive: true });
      const copied = await inspectPanelAppSource(staging);
      if (copied.digest !== expectedReviewToken) throw new PanelAppReviewChangedError();
      const storedSource: InstalledPanelAppSource =
        input.kind === "git" ? normalizeGitPanelAppSource(input) : input.path;
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
      ({ backup } = await replaceInstalledDirectory(
        copied.manifest.id,
        staging,
        options.overwrite === true,
      ));
      directoryReplaced = true;
      const previous = (await readInstalledPanelAppsRegistry()).find(
        (candidate) => candidate.id === copied.manifest.id,
      );
      await upsertInstalledPanelAppRecord({
        id: copied.manifest.id,
        version: copied.manifest.version,
        source: storedSource,
        installedAt: previous?.installedAt ?? installedAt,
        lastUpdated: installedAt,
      });
      if (backup) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      return installedPanelApp(copied.manifest, {
        id: copied.manifest.id,
        version: copied.manifest.version,
        source: storedSource,
        installedAt: previous?.installedAt ?? installedAt,
        lastUpdated: installedAt,
      });
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
    }
  });
}

export async function installReviewedPanelAppUpdate(
  id: string,
  expectedReviewToken: string,
  installedAt: string,
): Promise<InstalledPanelApp> {
  const input = await installedPanelAppSource(id);
  const preview = await previewLocalPanelApp(input);
  if (preview.id !== id) {
    throw new PanelAppInstallError(
      `original source now declares Panel App '${preview.id}', expected '${id}'`,
    );
  }
  if (preview.reviewToken !== expectedReviewToken) throw new PanelAppReviewChangedError();
  return installReviewedLocalPanelApp(input, expectedReviewToken, installedAt, {
    overwrite: true,
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

export async function listInstalledPanelApps(): Promise<InstalledPanelApp[]> {
  const output: InstalledPanelApp[] = [];
  for (const record of await readInstalledPanelAppsRegistry()) {
    try {
      const root = await realpath(panelAppInstallDir(record.id));
      const inspected = await inspectPanelAppSource(root);
      if (inspected.manifest.id !== record.id) continue;
      output.push(installedPanelApp(inspected.manifest, record));
    } catch {
      // One corrupt/missing app must not hide the rest of the catalog.
    }
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

export async function uninstallPanelApp(id: string): Promise<void> {
  assertSafePanelAppId(id);
  const directory = panelAppInstallDir(id);
  if (!existsSync(directory)) throw new PanelAppInstallError(`Panel App '${id}' is not installed`);
  const quarantine = join(panelAppsRoot(), `.remove-${id}-${randomUUID()}`);
  await rename(directory, quarantine);
  try {
    await removeInstalledPanelAppRecord(id);
  } catch (error) {
    await rename(quarantine, directory).catch(() => undefined);
    throw error;
  }
  await rm(quarantine, { recursive: true, force: true });
}
