import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Pinned cloudflared release. We do NOT track `latest`: the downloaded asset is
 * chmod +x'd and executed with the desktop user's privileges, so the bytes must
 * be verifiable against a known SHA-256. `latest` would move under us and make
 * any embedded digest wrong on the next release (breaking installs) or, worse,
 * silently accept whatever `latest` now points at. Bump this tag AND the digests
 * below together (see scripts note in the PR / CLAUDE memory).
 */
export const CLOUDFLARED_VERSION = "2026.6.1";

/**
 * SHA-256 of each release asset we download, for {@link CLOUDFLARED_VERSION}.
 * Keyed by the asset FILENAME. For macOS this is the `.tgz` archive (verified
 * before extraction); for Linux/Windows it's the raw binary. Regenerate on every
 * version bump:
 *   for a in cloudflared-darwin-amd64.tgz cloudflared-darwin-arm64.tgz \
 *            cloudflared-linux-amd64 cloudflared-linux-arm64 \
 *            cloudflared-windows-amd64.exe; do
 *     curl -sSL "https://github.com/cloudflare/cloudflared/releases/download/$V/$a" | shasum -a 256
 *   done
 */
export const CLOUDFLARED_SHA256: Record<string, string> = {
  "cloudflared-darwin-amd64.tgz":
    "d7a66b525fe76820da6e5406611b61e48b40de682368ac00454d9158f085be4b",
  "cloudflared-darwin-arm64.tgz":
    "f6d4c439c6c782b83264951d327989ce5e23373acc5942b872411601fedb020d",
  "cloudflared-linux-amd64":
    "5861a10a438fe8ddcfebb3b830f83966cbf193edafce0fe2eeb198fbae1f7a22",
  "cloudflared-linux-arm64":
    "59816ce9b16db71f5bc2a86d59b3632a96c8c3ee934bde2bc8641ee83a6070eb",
  "cloudflared-windows-amd64.exe":
    "5253e66f1f493c4e13539749f1aa86fd0c61e3072900fec29a44ba046a6d97e2",
};

/** The filename portion of an asset URL — the key into {@link CLOUDFLARED_SHA256}. */
export function cloudflaredAssetName(
  arch: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const a = arch === "arm64" ? "arm64" : "amd64";
  if (platform === "win32") return "cloudflared-windows-amd64.exe";
  if (platform === "linux") return `cloudflared-linux-${a}`;
  return `cloudflared-darwin-${a}.tgz`;
}

/** SHA-256 of a file on disk, lowercase hex. */
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Verify `path`'s SHA-256 against the pinned digest for `assetName`. Throws (with
 * the file left for the caller to clean up) on an unknown asset or a mismatch —
 * never chmod/execute unverified bytes.
 */
export function verifyAssetDigest(path: string, assetName: string): void {
  const expected = CLOUDFLARED_SHA256[assetName];
  if (!expected) {
    throw new Error(`cloudflared 资产无内置校验值: ${assetName}`);
  }
  const actual = sha256File(path);
  if (actual !== expected) {
    throw new Error(
      `cloudflared 校验失败(${assetName}): 期望 ${expected}, 实际 ${actual}`,
    );
  }
}

/**
 * Map a Node `process.platform` + `process.arch` to the official cloudflared
 * release asset URL.
 *
 *  - macOS: `cloudflared-darwin-<arch>.tgz` (a tarball with one binary).
 *  - Windows: `cloudflared-windows-<arch>.exe` (a RAW .exe, no extraction).
 *  - Linux: `cloudflared-linux-<arch>` (a raw binary).
 *
 * Pure + injectable so tests pin the URL without touching the network. Unknown
 * arch falls back to amd64.
 */
export function cloudflaredDownloadUrl(
  arch: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // Pinned version (NOT /latest/) so the asset matches an embedded SHA-256.
  const base = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`;
  return `${base}/${cloudflaredAssetName(arch, platform)}`;
}

/** True when the release asset is a tarball needing extraction (macOS only). */
function assetIsTarball(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/** Injectable download function. Writes the fetched bytes to `dest`. */
export type DownloadFn = (
  url: string,
  dest: string,
  onProgress?: (pct: number) => void,
) => Promise<void>;

export interface CloudflaredBinaryOptions {
  /** Base dir, typically `<userData>/mobile-remote`. */
  baseDir: string;
  /** Override `process.arch` for tests. */
  arch?: string;
  /** Override the network download for tests. */
  download?: DownloadFn;
}

/**
 * Manages the cloudflared binary on disk: existence/executable check and a
 * download-once-then-atomic-rename install. No process spawning, no network
 * service — that lives in tunnel-manager. Network + arch are injected so the
 * unit is fully deterministic in tests.
 */
export class CloudflaredBinary {
  private readonly baseDir: string;
  private readonly arch: string;
  private readonly download: DownloadFn;

  constructor(opts: CloudflaredBinaryOptions) {
    this.baseDir = opts.baseDir;
    this.arch = opts.arch ?? process.arch;
    this.download = opts.download ?? defaultDownload;
  }

  /** `<baseDir>/bin/cloudflared` (`.exe` on Windows). */
  binaryPath(): string {
    const name = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
    return join(this.baseDir, "bin", name);
  }

  /** True when the binary exists (and, on POSIX, has the owner-exec bit set).
   *  Windows has no exec bit, so existence is the only meaningful check. */
  isInstalled(): boolean {
    const p = this.binaryPath();
    if (!existsSync(p)) return false;
    if (process.platform === "win32") return true;
    try {
      return (statSync(p).mode & 0o100) === 0o100;
    } catch {
      return false;
    }
  }

  /**
   * Ensure the binary is present and executable, returning its path. If already
   * installed, skips the download. Otherwise downloads to a `.download` temp
   * name, chmods it executable, and atomically renames to the final path — so a
   * failed/partial download never leaves a half-written binary in place. On any
   * failure the temp file is removed and the error rethrown.
   */
  async ensureBinary(onProgress?: (pct: number) => void): Promise<string> {
    const finalPath = this.binaryPath();
    if (this.isInstalled()) return finalPath;

    const tmpPath = `${finalPath}.download`;
    mkdirSync(join(this.baseDir, "bin"), { recursive: true });
    try {
      const url = cloudflaredDownloadUrl(this.arch);
      await this.download(url, tmpPath, onProgress);
      if (!existsSync(tmpPath) || statSync(tmpPath).size === 0) {
        throw new Error("下载的 cloudflared 为空");
      }
      chmodSync(tmpPath, 0o755);
      renameSync(tmpPath, finalPath);
      return finalPath;
    } catch (err) {
      rmSync(tmpPath, { force: true });
      throw err;
    }
  }
}

/**
 * Default download: the official macOS asset is a `.tgz` tarball containing a
 * single `cloudflared` binary, so we fetch the tarball to a scratch dir, extract
 * it with the system `tar`, then place the extracted binary at `dest`. The
 * caller (ensureBinary) chmods + atomically renames `dest` into place, so a
 * failed extract never yields a runnable-but-broken binary. Network + extract
 * scratch is fully cleaned up.
 */
const defaultDownload: DownloadFn = async (url, dest, onProgress) => {
  // The asset filename is the key into the embedded SHA-256 table.
  const assetName = cloudflaredAssetName(process.arch);
  // Windows/Linux assets are RAW binaries — stream straight to dest, no tar.
  if (!assetIsTarball()) {
    await httpsDownloadTo(url, dest, onProgress);
    if (!existsSync(dest) || statSync(dest).size === 0) {
      throw new Error("下载的 cloudflared 为空");
    }
    // Verify BEFORE the caller chmods +x and renames into place. A mismatch
    // throws; ensureBinary removes the temp file so nothing runnable survives.
    verifyAssetDigest(dest, assetName);
    return;
  }
  // macOS asset is a .tgz with a single `cloudflared` binary → extract.
  const scratch = mkdtempSync(join(tmpdir(), "cloudflared-dl-"));
  const tgzPath = join(scratch, "cloudflared.tgz");
  try {
    await httpsDownloadTo(url, tgzPath, onProgress);
    if (!existsSync(tgzPath) || statSync(tgzPath).size === 0) {
      throw new Error("下载的 cloudflared 归档为空");
    }
    // Verify the ARCHIVE against its embedded digest before extracting — never
    // hand attacker-controlled bytes to `tar`.
    verifyAssetDigest(tgzPath, assetName);
    await runTarExtract(tgzPath, scratch);
    const extracted = join(scratch, "cloudflared");
    if (!existsSync(extracted)) {
      throw new Error("归档中未找到 cloudflared 二进制");
    }
    copyFileSync(extracted, dest);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** Stream an https GET (following GitHub→CDN redirects) to a file with coarse
 *  progress. */
function httpsDownloadTo(
  url: string,
  dest: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = (target: string, redirects: number) => {
      if (redirects > 5) {
        reject(new Error("下载重定向过多"));
        return;
      }
      const req = httpsGet(target, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          request(res.headers.location, redirects + 1);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(new Error(`下载失败,HTTP ${status}`));
          return;
        }
        const total = Number(res.headers["content-length"] ?? 0);
        let received = 0;
        const out = createWriteStream(dest);
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (total > 0 && onProgress) {
            onProgress(Math.min(100, Math.round((received / total) * 100)));
          }
        });
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve()));
        out.on("error", reject);
        res.on("error", reject);
      });
      req.on("error", reject);
    };
    request(url, 0);
  });
}

/** Extract a `.tgz` into `cwd` using the system tar (always present on macOS). */
function runTarExtract(tgzPath: string, cwd: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-xzf", tgzPath, "-C", cwd]);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar 解压失败(code=${code ?? "?"})`));
    });
  });
}
