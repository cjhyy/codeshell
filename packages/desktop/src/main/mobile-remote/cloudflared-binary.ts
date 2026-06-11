import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { get as httpsGet } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  const a = arch === "arm64" ? "arm64" : "amd64";
  if (platform === "win32") {
    // Windows only ships amd64/386; use amd64 (arm64 Windows runs amd64 via emu).
    return `${base}/cloudflared-windows-amd64.exe`;
  }
  if (platform === "linux") {
    return `${base}/cloudflared-linux-${a}`;
  }
  return `${base}/cloudflared-darwin-${a}.tgz`;
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
  // Windows/Linux assets are RAW binaries — stream straight to dest, no tar.
  if (!assetIsTarball()) {
    await httpsDownloadTo(url, dest, onProgress);
    if (!existsSync(dest) || statSync(dest).size === 0) {
      throw new Error("下载的 cloudflared 为空");
    }
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
