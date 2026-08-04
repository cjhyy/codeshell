import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  isCliLinkProvider,
  managedLinkCliPath,
  type CliLinkProviderId,
} from "@cjhyy/code-shell-core";

export type ManagedCliInstallProviderId = "github" | "gitlab";

export interface ManagedCliInstallStatus {
  providerId: CliLinkProviderId;
  supported: boolean;
  managedPath?: string;
  managedInstalled: boolean;
}

export interface ManagedCliInstallResult {
  providerId: ManagedCliInstallProviderId;
  command: "gh" | "glab";
  version: string;
  executablePath: string;
  source: "official-release";
  checksumVerified: true;
}

interface ReleaseAsset {
  name: string;
  url: string;
}

interface ReleaseDescriptor {
  version: string;
  archive: ReleaseAsset;
  checksums: ReleaseAsset;
  command: "gh" | "glab";
}

interface InstallerOptions {
  fetch?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  runFile?: (command: string, args: string[]) => Promise<string>;
  managedPath?: (providerId: CliLinkProviderId) => string;
}

const MAX_DOWNLOAD_BYTES = 160 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const ALLOWED_ASSET_HOSTS = new Set(["github.com", "gitlab.com"]);

function isManagedInstallProvider(value: string): value is ManagedCliInstallProviderId {
  return value === "github" || value === "gitlab";
}

function safeAssetUrl(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("CLI release asset URL is missing");
  const url = new URL(raw);
  if (url.protocol !== "https:" || !ALLOWED_ASSET_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("CLI release asset URL is not trusted");
  }
  return url.toString();
}

async function jsonObject(response: Response, action: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${action} failed (${response.status})`);
  const raw = await response.text();
  if (raw.length > 2 * 1024 * 1024) throw new Error(`${action} response is too large`);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${action} returned invalid JSON`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${action} returned an invalid response`);
  }
  return value as Record<string, unknown>;
}

function normalizedPlatform(platform: NodeJS.Platform): "macOS" | "darwin" | "linux" | "windows" {
  if (platform === "darwin") return "macOS";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  throw new Error(`Managed CLI installation is not supported on ${platform}`);
}

function normalizedArch(arch: string): "amd64" | "arm64" {
  if (arch === "x64") return "amd64";
  if (arch === "arm64") return "arm64";
  throw new Error(`Managed CLI installation is not supported on ${arch}`);
}

function findAsset(assets: ReleaseAsset[], name: string, label: string): ReleaseAsset {
  const asset = assets.find((candidate) => candidate.name === name);
  if (!asset) throw new Error(`${label} is missing from the official release`);
  return asset;
}

async function githubRelease(
  fetchFn: typeof fetch,
  platform: NodeJS.Platform,
  arch: string,
): Promise<ReleaseDescriptor> {
  const payload = await jsonObject(
    await fetchFn("https://api.github.com/repos/cli/cli/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "CodeShell-Link" },
      signal: AbortSignal.timeout(20_000),
    }),
    "GitHub CLI release lookup",
  );
  const tag = typeof payload.tag_name === "string" ? payload.tag_name : "";
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("GitHub CLI release version is invalid");
  const rawAssets = Array.isArray(payload.assets) ? payload.assets : [];
  const assets = rawAssets.flatMap((raw): ReleaseAsset[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const asset = raw as Record<string, unknown>;
    if (typeof asset.name !== "string") return [];
    return [{ name: asset.name, url: safeAssetUrl(asset.browser_download_url) }];
  });
  const os = normalizedPlatform(platform);
  const cpu = normalizedArch(arch);
  const extension = platform === "linux" ? "tar.gz" : "zip";
  const archiveName = `gh_${version}_${os}_${cpu}.${extension}`;
  return {
    version,
    archive: findAsset(assets, archiveName, "GitHub CLI archive"),
    checksums: findAsset(assets, `gh_${version}_checksums.txt`, "GitHub CLI checksums"),
    command: "gh",
  };
}

async function gitlabRelease(
  fetchFn: typeof fetch,
  platform: NodeJS.Platform,
  arch: string,
): Promise<ReleaseDescriptor> {
  const payload = await jsonObject(
    await fetchFn("https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/releases/permalink/latest", {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    }),
    "GitLab CLI release lookup",
  );
  const tag = typeof payload.tag_name === "string" ? payload.tag_name : "";
  const version = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("GitLab CLI release version is invalid");
  const rawLinks =
    payload.assets && typeof payload.assets === "object" && !Array.isArray(payload.assets)
      ? (payload.assets as Record<string, unknown>).links
      : undefined;
  const assets = (Array.isArray(rawLinks) ? rawLinks : []).flatMap((raw): ReleaseAsset[] => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const asset = raw as Record<string, unknown>;
    if (typeof asset.name !== "string") return [];
    return [
      {
        name: asset.name,
        url: safeAssetUrl(asset.direct_asset_url ?? asset.url),
      },
    ];
  });
  const genericOs = normalizedPlatform(platform);
  const os = genericOs === "macOS" ? "darwin" : genericOs;
  const cpu = normalizedArch(arch);
  const extension = platform === "win32" ? "zip" : "tar.gz";
  const archiveName = `glab_${version}_${os}_${cpu}.${extension}`;
  return {
    version,
    archive: findAsset(assets, archiveName, "GitLab CLI archive"),
    checksums: findAsset(assets, "checksums.txt", "GitLab CLI checksums"),
    command: "glab",
  };
}

async function download(
  fetchFn: typeof fetch,
  asset: ReleaseAsset,
  destination: string,
): Promise<void> {
  const response = await fetchFn(asset.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`CLI download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
    throw new Error("CLI download is larger than the allowed limit");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw new Error("CLI download is too large");
  await writeFile(destination, bytes, { mode: 0o600 });
}

function expectedChecksum(checksums: string, archiveName: string): string {
  for (const line of checksums.split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && match[2] === archiveName) return match[1]!.toLowerCase();
  }
  throw new Error("Official CLI checksums do not contain the selected archive");
}

async function verifyChecksum(archivePath: string, checksumsPath: string, archiveName: string) {
  const [archive, checksums] = await Promise.all([
    readFile(archivePath),
    readFile(checksumsPath, "utf8"),
  ]);
  const actual = createHash("sha256").update(archive).digest("hex");
  const expected = expectedChecksum(checksums, archiveName);
  if (actual !== expected) throw new Error("CLI archive checksum verification failed");
}

function defaultRunFile(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(`CLI archive extraction failed: ${String(stderr).trim()}`, { cause: error }),
          );
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function assertSafeArchiveEntries(listing: string): void {
  const entries = listing.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error("CLI archive has an invalid number of entries");
  }
  for (const entry of entries) {
    const normalized = entry.replaceAll("\\", "/");
    if (isAbsolute(entry) || normalized.split("/").includes("..")) {
      throw new Error("CLI archive contains an unsafe path");
    }
  }
}

async function findExecutable(
  root: string,
  command: string,
  platform: NodeJS.Platform,
): Promise<string> {
  const expected = `${command}${platform === "win32" ? ".exe" : ""}`;
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    const directory = queue.shift()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      visited += 1;
      if (visited > MAX_ARCHIVE_ENTRIES) throw new Error("CLI archive contains too many files");
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.name === expected) {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        return path;
      }
    }
  }
  throw new Error(`CLI archive does not contain ${expected}`);
}

export function managedCliInstallStatus(
  rawProviderId: string,
  managedPath: (providerId: CliLinkProviderId) => string = managedLinkCliPath,
): ManagedCliInstallStatus {
  if (!isCliLinkProvider(rawProviderId)) throw new Error("Unsupported CLI Link provider");
  const supported = isManagedInstallProvider(rawProviderId);
  const path = supported ? managedPath(rawProviderId) : undefined;
  return {
    providerId: rawProviderId,
    supported,
    managedPath: path,
    managedInstalled: Boolean(path && existsSync(path)),
  };
}

/** Download, checksum, extract, and atomically install an official CLI release. */
export async function installManagedLinkCli(
  rawProviderId: string,
  options: InstallerOptions = {},
): Promise<ManagedCliInstallResult> {
  if (!isManagedInstallProvider(rawProviderId)) {
    throw new Error("Automatic CLI installation is not supported for this provider");
  }
  const providerId = rawProviderId;
  const fetchFn = options.fetch ?? fetch;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runFile = options.runFile ?? defaultRunFile;
  const release =
    providerId === "github"
      ? await githubRelease(fetchFn, platform, arch)
      : await gitlabRelease(fetchFn, platform, arch);
  const temporary = await mkdtemp(join(tmpdir(), "codeshell-link-cli-"));
  try {
    const archivePath = join(temporary, basename(release.archive.name));
    const checksumsPath = join(temporary, basename(release.checksums.name));
    await Promise.all([
      download(fetchFn, release.archive, archivePath),
      download(fetchFn, release.checksums, checksumsPath),
    ]);
    await verifyChecksum(archivePath, checksumsPath, release.archive.name);
    const listing = await runFile("tar", ["-tf", archivePath]);
    assertSafeArchiveEntries(listing);
    const extracted = join(temporary, "extracted");
    await mkdir(extracted, { recursive: true, mode: 0o700 });
    await runFile("tar", ["-xf", archivePath, "-C", extracted]);
    const source = await findExecutable(extracted, release.command, platform);
    const destination = (options.managedPath ?? managedLinkCliPath)(providerId);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    const staging = `${destination}.new`;
    await copyFile(source, staging);
    if (platform !== "win32") await chmod(staging, 0o755);
    await rm(destination, { force: true });
    await rename(staging, destination);
    return {
      providerId,
      command: release.command,
      version: release.version,
      executablePath: destination,
      source: "official-release",
      checksumVerified: true,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
