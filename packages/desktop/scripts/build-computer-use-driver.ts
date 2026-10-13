import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;

export interface CuaDriverLock {
  version: string;
  url: string;
  sha256: string;
  licenseUrl: string;
  licenseSha256: string;
}

export async function loadCuaDriverLock(): Promise<CuaDriverLock> {
  return JSON.parse(await readFile(join(desktopRoot, "resources/cua-driver.lock.json"), "utf8"));
}

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function verifiedFile(path: string, expected: string, maxBytes: number): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size < 1 || info.size > maxBytes) return false;
    return hash(await readFile(path)) === expected;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Build-time supply: no downloads or native processes when this module is imported. */
export async function buildComputerUseDriver(
  options: {
    platform?: NodeJS.Platform;
    outputDirectory?: string;
    cacheDirectory?: string;
    offline?: boolean;
    lock?: CuaDriverLock;
    licensePath?: string;
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
    run?: (command: string, args: string[]) => Promise<{ stdout: string }>;
  } = {},
): Promise<void> {
  if ((options.platform ?? process.platform) !== "darwin") return;
  const lock = options.lock ?? (await loadCuaDriverLock());
  if (
    !/^\d+\.\d+\.\d+$/.test(lock.version) ||
    lock.url !==
      `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${lock.version}/cua-driver-rs-${lock.version}-darwin-universal-binary.tar.gz` ||
    !/^[a-f0-9]{64}$/.test(lock.sha256) ||
    !/^[a-f0-9]{64}$/.test(lock.licenseSha256)
  )
    throw new Error("Invalid Cua Driver release lock");
  const license = options.licensePath ?? join(desktopRoot, "resources/cua-driver.LICENSE");
  if (!(await verifiedFile(license, lock.licenseSha256, 64 * 1024))) {
    throw new Error("Cua Driver license checksum mismatch");
  }
  const destination = options.outputDirectory ?? join(desktopRoot, "out/native/cua-driver");
  const cache = options.cacheDirectory ?? join(desktopRoot, "out/cua-driver-cache");
  await mkdir(cache, { recursive: true });
  const archive = join(cache, `${lock.sha256}.tar.gz`);
  if (!(await verifiedFile(archive, lock.sha256, MAX_ARCHIVE_BYTES))) {
    if (options.offline ?? process.env.CODESHELL_CUA_OFFLINE === "1") {
      throw new Error("Verified Cua Driver archive is unavailable in offline cache");
    }
    const download = await mkdtemp(join(cache, ".download-"));
    try {
      const response = await (options.fetch ?? fetch)(lock.url, {
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok || !response.body) {
        throw new Error(`Cua Driver download failed: HTTP ${response.status}`);
      }
      let size = 0;
      const checksum = createHash("sha256");
      const bounded = new Transform({
        transform(chunk, _encoding, callback) {
          size += chunk.length;
          if (size > MAX_ARCHIVE_BYTES)
            return callback(new Error("Cua Driver archive is too large"));
          checksum.update(chunk);
          callback(null, chunk);
        },
      });
      const file = join(download, "archive.tar.gz");
      await pipeline(
        Readable.fromWeb(
          response.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>,
        ),
        bounded,
        createWriteStream(file, { flags: "wx" }),
      );
      if (checksum.digest("hex") !== lock.sha256)
        throw new Error("Cua Driver archive checksum mismatch");
      await rename(file, archive);
    } finally {
      await rm(download, { recursive: true, force: true });
    }
  }
  await mkdir(dirname(destination), { recursive: true });
  const temporary = await mkdtemp(join(dirname(destination), ".cua-driver-"));
  const run =
    options.run ??
    ((command, args) =>
      execute(command, args, {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, CUA_DRIVER_EMBEDDED: "1" },
      }));
  try {
    // Extract only the CLI; SDK libraries and unrelated helpers are not needed.
    await run("/usr/bin/tar", ["-xzf", archive, "-C", temporary, "cua-driver"]);
    const binary = join(temporary, "cua-driver");
    const info = await lstat(binary);
    if (!info.isFile() || info.size < 1 || info.size > 256 * 1024 * 1024) {
      throw new Error("Cua Driver archive has no regular executable");
    }
    const architectures = (await run("/usr/bin/lipo", ["-archs", binary])).stdout
      .trim()
      .split(/\s+/)
      .sort();
    if (architectures.join(" ") !== "arm64 x86_64")
      throw new Error("Cua Driver must support both macOS architectures");
    await run("/usr/bin/codesign", ["--verify", "--strict", binary]);
    await chmod(binary, 0o755);
    if ((await run(binary, ["--version"])).stdout.trim() !== `cua-driver ${lock.version}`) {
      throw new Error("Cua Driver version does not match release lock");
    }
    await mkdir(destination, { recursive: true });
    await copyFile(license, join(temporary, "LICENSE"));
    await rename(binary, join(destination, "cua-driver"));
    await rename(join(temporary, "LICENSE"), join(destination, "LICENSE"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildComputerUseDriver();
