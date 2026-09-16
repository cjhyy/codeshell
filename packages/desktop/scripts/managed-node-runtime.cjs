// Build-time supply only. Importing this module neither downloads nor starts Node.
// Existing Agent workers, Panel execution and PATH resolution are unaffected.
/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports -- Pure Node CJS also imported by electron-builder hooks. */
const { createHash, randomUUID } = require("node:crypto");
const { createReadStream, createWriteStream } = require("node:fs");
const fs = require("node:fs/promises");
const { basename, dirname, join, resolve } = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createInflateRaw } = require("node:zlib");

const runFile = promisify(execFile);
const DESKTOP_ROOT = resolve(__dirname, "..");
const LOCK_PATH = join(DESKTOP_ROOT, "resources/node-runtime.lock.json");
const DEFAULT_CACHE = join(DESKTOP_ROOT, "out/managed-node-cache");
const DEFAULT_OUTPUT = join(DESKTOP_ROOT, "out/managed-runtimes/node");
const LIMITS = Object.freeze({
  archive: 128 * 1024 * 1024,
  executable: 256 * 1024 * 1024,
  license: 4 * 1024 * 1024,
  metadata: 64 * 1024,
  downloadMs: 120_000,
  extractMs: 60_000,
});
const SHA = /^[a-f0-9]{64}$/;
const PLATFORMS = new Set(["darwin", "linux", "win32"]);
const ARCHES = new Set(["arm64", "x64"]);

function archiveName(version, platform, arch) {
  return `node-v${version}-${platform === "win32" ? "win" : platform}-${arch}.${platform === "win32" ? "zip" : "tar.gz"}`;
}
function executableName(platform) {
  return platform === "win32" ? "bin/node.exe" : "bin/node";
}
function validateLock(lock) {
  if (
    lock?.schemaVersion !== 1 ||
    lock.id !== "node" ||
    typeof lock.version !== "string" ||
    !/^24\.\d+\.\d+$/.test(lock.version) ||
    !Array.isArray(lock.artifacts) ||
    !lock.artifacts.length ||
    lock.artifacts.length > 6 ||
    lock.checksumsUrl !== `https://nodejs.org/dist/v${lock.version}/SHASUMS256.txt`
  )
    throw new Error("Invalid managed Node runtime lock");
  const seen = new Set();
  for (const item of lock.artifacts) {
    const key = `${item?.platform}-${item?.arch}`;
    if (
      !PLATFORMS.has(item?.platform) ||
      !ARCHES.has(item?.arch) ||
      seen.has(key) ||
      !SHA.test(item?.archiveSha256) ||
      item.url !==
        `https://nodejs.org/dist/v${lock.version}/${archiveName(lock.version, item.platform, item.arch)}`
    )
      throw new Error("Invalid managed Node runtime artifact");
    seen.add(key);
  }
  return lock;
}
async function regularFile(file, limit) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit)
    throw new Error(`Expected a bounded regular file: ${file}`);
  return info;
}
async function loadLock(path = LOCK_PATH) {
  await regularFile(path, LIMITS.metadata);
  return validateLock(JSON.parse(await fs.readFile(path, "utf8")));
}
function selectArtifact(lock, platform, arch) {
  validateLock(lock);
  const artifact = lock.artifacts.find((item) => item.platform === platform && item.arch === arch);
  if (!artifact) throw new Error(`Managed Node runtime is not locked for ${platform}-${arch}`);
  return artifact;
}
async function sha256(file, limit) {
  await regularFile(file, limit);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error(`Managed Node file exceeds its size limit: ${file}`);
    hash.update(chunk);
  }
  return hash.digest("hex");
}
async function realDirectory(path) {
  await fs.mkdir(path, { recursive: true });
  const stat = await fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error(`Expected a real directory: ${path}`);
}
function byteLimit(limit, hash) {
  let bytes = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > limit)
        return callback(new Error("Managed Node download/extraction exceeds its size limit"));
      hash?.update(chunk);
      callback(null, chunk);
    },
  });
}

/** Revalidate every cached archive; offline mode never makes a network request. */
async function prepareArchive(options = {}) {
  const lock = options.lock ?? (await loadLock(options.lockPath));
  const platform = options.platform ?? process.platform,
    arch = options.arch ?? process.arch;
  const artifact = selectArtifact(lock, platform, arch);
  const cacheDir = resolve(options.cacheDir ?? DEFAULT_CACHE);
  await realDirectory(cacheDir);
  const archive = join(
    cacheDir,
    `${artifact.archiveSha256}-${basename(new URL(artifact.url).pathname)}`,
  );
  try {
    if ((await sha256(archive, LIMITS.archive)) === artifact.archiveSha256)
      return { archive, artifact, version: lock.version };
    throw new Error("Cached Node archive checksum mismatch");
  } catch (error) {
    if (options.offline)
      throw new Error("Verified managed Node archive is unavailable in offline cache", {
        cause: error,
      });
    if (error.code !== "ENOENT") {
      // A symlink must never redirect cache writes or extraction to another path.
      const existing = await fs.lstat(archive);
      if (!existing.isFile() || existing.isSymbolicLink()) throw error;
    }
  }
  const temporary = `${archive}.${randomUUID()}.download`;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Managed Node download timed out")),
    options.timeoutMs ?? LIMITS.downloadMs,
  );
  try {
    const response = await (options.fetch ?? fetch)(artifact.url, {
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok || !response.body)
      throw new Error(`Managed Node download failed: HTTP ${response.status}`);
    if (Number(response.headers.get("content-length")) > LIMITS.archive)
      throw new Error("Managed Node download exceeds its size limit");
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(response.body),
      byteLimit(options.maxArchiveBytes ?? LIMITS.archive, hash),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      { signal: controller.signal },
    );
    if (hash.digest("hex") !== artifact.archiveSha256)
      throw new Error("Managed Node archive checksum mismatch");
    await fs.rename(temporary, archive);
    return { archive, artifact, version: lock.version };
  } finally {
    clearTimeout(timer);
    controller.abort();
    await fs.rm(temporary, { force: true });
  }
}

/** Read one ZIP member using bounded central/local headers, including on Linux. */
async function extractZipMember(archive, member, destination, limit) {
  const info = await regularFile(archive, LIMITS.archive);
  const handle = await fs.open(archive, "r");
  try {
    async function read(size, position) {
      if (position < 0 || size < 0 || position + size > info.size)
        throw new Error("Invalid managed Node ZIP bounds");
      const bytes = Buffer.alloc(size);
      if ((await handle.read(bytes, 0, size, position)).bytesRead !== size)
        throw new Error("Truncated managed Node ZIP");
      return bytes;
    }
    const tail = await read(Math.min(info.size, 65_557), Math.max(0, info.size - 65_557));
    let end = tail.length - 22;
    while (
      end >= 0 &&
      (tail.readUInt32LE(end) !== 0x06054b50 ||
        end + 22 + tail.readUInt16LE(end + 20) !== tail.length)
    )
      end--;
    if (
      end < 0 ||
      tail.readUInt16LE(end + 4) ||
      tail.readUInt16LE(end + 6) ||
      tail.readUInt16LE(end + 8) !== tail.readUInt16LE(end + 10)
    )
      throw new Error("Unsupported managed Node ZIP directory");
    const size = tail.readUInt32LE(end + 12),
      offset = tail.readUInt32LE(end + 16);
    if (size > 4 * 1024 * 1024)
      throw new Error("Managed Node ZIP directory exceeds its size limit");
    const entries = await read(size, offset);
    let selected;
    for (let cursor = 0; cursor < entries.length; ) {
      if (cursor + 46 > entries.length || entries.readUInt32LE(cursor) !== 0x02014b50)
        throw new Error("Invalid managed Node ZIP entry");
      const nameSize = entries.readUInt16LE(cursor + 28);
      const next =
        cursor +
        46 +
        nameSize +
        entries.readUInt16LE(cursor + 30) +
        entries.readUInt16LE(cursor + 32);
      if (next > entries.length) throw new Error("Invalid managed Node ZIP entry size");
      if (entries.subarray(cursor + 46, cursor + 46 + nameSize).toString("utf8") === member) {
        if (selected) throw new Error("Duplicate managed Node ZIP member");
        selected = {
          flags: entries.readUInt16LE(cursor + 8),
          method: entries.readUInt16LE(cursor + 10),
          compressed: entries.readUInt32LE(cursor + 20),
          size: entries.readUInt32LE(cursor + 24),
          mode: entries.readUInt32LE(cursor + 38) >>> 16,
          offset: entries.readUInt32LE(cursor + 42),
        };
      }
      cursor = next;
    }
    if (
      !selected ||
      selected.flags & 1 ||
      ![0, 8].includes(selected.method) ||
      selected.size < 1 ||
      selected.size > limit ||
      (selected.mode & 0xf000) === 0xa000
    )
      throw new Error("Unsupported managed Node ZIP member");
    const local = await read(30, selected.offset);
    if (
      local.readUInt32LE(0) !== 0x04034b50 ||
      local.readUInt16LE(8) !== selected.method ||
      local.readUInt16LE(6) & 1
    )
      throw new Error("Invalid managed Node ZIP local header");
    const nameSize = local.readUInt16LE(26);
    if ((await read(nameSize, selected.offset + 30)).toString("utf8") !== member)
      throw new Error("Managed Node ZIP member name mismatch");
    const start = selected.offset + 30 + nameSize + local.readUInt16LE(28);
    if (!selected.compressed || start + selected.compressed > offset)
      throw new Error("Invalid managed Node ZIP data bounds");
    const stages = [createReadStream(archive, { start, end: start + selected.compressed - 1 })];
    if (selected.method === 8) stages.push(createInflateRaw());
    stages.push(byteLimit(limit), createWriteStream(destination, { flags: "wx", mode: 0o600 }));
    await pipeline(stages, { signal: AbortSignal.timeout(LIMITS.extractMs) });
    if ((await regularFile(destination, limit)).size !== selected.size)
      throw new Error("Managed Node ZIP member size mismatch");
  } finally {
    await handle.close();
  }
}

/** Extract exact reviewed members to stdout; archive paths never write to disk. */
async function extractMember(archive, member, destination, limit) {
  if (archive.endsWith(".zip")) return extractZipMember(archive, member, destination, limit);
  const child = spawn("tar", ["-xOf", archive, "--", member], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: LIMITS.extractMs,
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-4096);
  });
  const completed = new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? accept()
        : reject(new Error(`Managed Node extraction failed (${code ?? signal}): ${stderr}`)),
    );
  });
  try {
    await Promise.all([
      pipeline(
        child.stdout,
        byteLimit(limit),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      ),
      completed,
    ]);
    await regularFile(destination, limit);
  } catch (error) {
    child.kill();
    await completed.catch(() => {});
    throw error;
  }
}
async function executableArchitecture(file) {
  const handle = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead >= 8 && header.readUInt32LE(0) === 0xfeedfacf) {
      const cpu = header.readUInt32LE(4);
      if (cpu === 0x0100000c) return { platform: "darwin", arch: "arm64" };
      if (cpu === 0x01000007) return { platform: "darwin", arch: "x64" };
    }
    if (
      bytesRead >= 20 &&
      header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      header[4] === 2 &&
      header[5] === 1
    ) {
      const cpu = header.readUInt16LE(18);
      if (cpu === 62) return { platform: "linux", arch: "x64" };
      if (cpu === 183) return { platform: "linux", arch: "arm64" };
    }
    if (bytesRead >= 64 && header.readUInt16LE(0) === 0x5a4d) {
      const offset = header.readUInt32LE(0x3c);
      if (offset + 6 <= bytesRead && header.readUInt32LE(offset) === 0x00004550) {
        const cpu = header.readUInt16LE(offset + 4);
        if (cpu === 0x8664) return { platform: "win32", arch: "x64" };
        if (cpu === 0xaa64) return { platform: "win32", arch: "arm64" };
      }
    }
    throw new Error("Unsupported managed Node executable header");
  } finally {
    await handle.close();
  }
}
async function writeManifest(runtimeDir, descriptor) {
  const executable = executableName(descriptor.platform);
  const manifest = {
    schemaVersion: 1,
    id: "node",
    version: descriptor.version,
    platform: descriptor.platform,
    arch: descriptor.arch,
    executable,
    sha256: await sha256(join(runtimeDir, executable), LIMITS.executable),
    source: { url: descriptor.source.url, archiveSha256: descriptor.source.archiveSha256 },
  };
  const temporary = join(runtimeDir, `manifest.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o644,
    });
    await fs.rename(temporary, join(runtimeDir, "manifest.json"));
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return manifest;
}
async function readManifest(runtimeDir) {
  const file = join(runtimeDir, "manifest.json");
  await regularFile(file, LIMITS.metadata);
  return JSON.parse(await fs.readFile(file, "utf8"));
}
async function verifyRuntime(runtimeDir, options = {}) {
  for (const directory of [runtimeDir, join(runtimeDir, "bin")]) {
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Managed Node directory is not a real directory");
  }
  const manifest = await readManifest(runtimeDir);
  const lock = options.lock ?? (await loadLock(options.lockPath));
  const artifact = selectArtifact(lock, manifest.platform, manifest.arch);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.id !== "node" ||
    manifest.version !== lock.version ||
    manifest.executable !== executableName(manifest.platform) ||
    !SHA.test(manifest.sha256) ||
    manifest.source?.url !== artifact.url ||
    manifest.source?.archiveSha256 !== artifact.archiveSha256 ||
    (options.platform && manifest.platform !== options.platform) ||
    (options.arch && manifest.arch !== options.arch)
  )
    throw new Error("Managed Node manifest does not match the locked target");
  const executable = join(runtimeDir, manifest.executable);
  if ((await sha256(executable, LIMITS.executable)) !== manifest.sha256)
    throw new Error("Managed Node executable checksum mismatch");
  const target = await executableArchitecture(executable);
  if (target.platform !== manifest.platform || target.arch !== manifest.arch)
    throw new Error("Managed Node executable architecture mismatch");
  const executableInfo = await regularFile(executable, LIMITS.executable);
  if (manifest.platform !== "win32" && !(executableInfo.mode & 0o111))
    throw new Error("Managed Node executable permission is missing");
  await regularFile(join(runtimeDir, "LICENSE"), LIMITS.license);
  return manifest;
}

/** Produces a standalone runtime; no consumer is selected or automatically started. */
async function stageRuntime(options = {}) {
  const lock = options.lock ?? (await loadLock(options.lockPath));
  const prepared = await prepareArchive({ ...options, lock });
  const { platform, arch } = prepared.artifact;
  const runtimeDir = resolve(options.runtimeDir ?? DEFAULT_OUTPUT);
  await realDirectory(dirname(runtimeDir));
  const staging = await fs.mkdtemp(join(dirname(runtimeDir), ".node-runtime-"));
  const backup = `${runtimeDir}.${randomUUID()}.previous`;
  let movedPrevious = false;
  try {
    await fs.mkdir(join(staging, "bin"));
    const root = `node-v${prepared.version}-${platform === "win32" ? "win" : platform}-${arch}`;
    const executable = executableName(platform);
    const extract = options.extract ?? extractMember;
    await extract(
      prepared.archive,
      `${root}/${platform === "win32" ? "node.exe" : "bin/node"}`,
      join(staging, executable),
      LIMITS.executable,
    );
    await extract(prepared.archive, `${root}/LICENSE`, join(staging, "LICENSE"), LIMITS.license);
    if (platform !== "win32") await fs.chmod(join(staging, executable), 0o755);
    const manifest = await writeManifest(staging, {
      version: prepared.version,
      platform,
      arch,
      source: prepared.artifact,
    });
    await verifyRuntime(staging, { lock, platform, arch });
    try {
      const old = await fs.lstat(runtimeDir);
      if (!old.isDirectory() || old.isSymbolicLink())
        throw new Error("Managed Node output must be a real directory");
      await fs.rename(runtimeDir, backup);
      movedPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await fs.rename(staging, runtimeDir);
    } catch (error) {
      if (movedPrevious) await fs.rename(backup, runtimeDir);
      throw error;
    }
    if (movedPrevious) await fs.rm(backup, { recursive: true });
    return { runtimeDir, manifest };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}
async function refreshManifest(runtimeDir, options = {}) {
  const before = await readManifest(runtimeDir);
  const manifest = await writeManifest(runtimeDir, before);
  await verifyRuntime(runtimeDir, options);
  return manifest;
}
async function smokeRuntime(runtimeDir, options = {}) {
  const manifest = await verifyRuntime(runtimeDir, options);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch)
    throw new Error("Managed Node smoke test requires the native target platform and architecture");
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.ELECTRON_RUN_AS_NODE;
  const script =
    'import {createHash} from "node:crypto"; console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,esm:createHash("sha256").update("codeshell").digest("hex")}));';
  const { stdout } = await runFile(
    join(runtimeDir, manifest.executable),
    ["--input-type=module", "-e", script],
    {
      env,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    },
  );
  const result = JSON.parse(stdout);
  if (
    result.version !== manifest.version ||
    result.platform !== manifest.platform ||
    result.arch !== manifest.arch ||
    result.esm !== createHash("sha256").update("codeshell").digest("hex")
  )
    throw new Error("Managed Node smoke result does not match the locked runtime");
  return result;
}
function packagingTarget(context) {
  const arch =
    typeof context.arch === "number" ? { 1: "x64", 3: "arm64" }[context.arch] : context.arch;
  if (!ARCHES.has(arch) || !PLATFORMS.has(context.electronPlatformName))
    throw new Error("Unsupported managed Node packaging target");
  return { platform: context.electronPlatformName, arch };
}
function packagedRuntimeDirectory(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          "Contents/Resources",
        )
      : join(context.appOutDir, "resources");
  return join(resources, "runtimes/node");
}
async function cli(args = process.argv.slice(2)) {
  const options = {};
  let verify = false,
    smoke = false,
    downloadOnly = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--offline") options.offline = true;
    else if (flag === "--verify") verify = true;
    else if (flag === "--smoke") smoke = true;
    else if (flag === "--download-only") downloadOnly = true;
    else if (
      ["--platform", "--arch", "--cache", "--output"].includes(flag) &&
      args[i + 1] &&
      !args[i + 1].startsWith("--")
    ) {
      options[{ "--cache": "cacheDir", "--output": "runtimeDir" }[flag] ?? flag.slice(2)] =
        args[++i];
    } else throw new Error(`Unknown or incomplete managed Node argument: ${flag}`);
  }
  if (downloadOnly && (verify || smoke))
    throw new Error("Download-only cannot verify or smoke a staged runtime");
  const runtimeDir = resolve(options.runtimeDir ?? DEFAULT_OUTPUT);
  const result = downloadOnly
    ? await prepareArchive(options)
    : verify
      ? await verifyRuntime(runtimeDir, options)
      : await stageRuntime(options);
  if (smoke) await smokeRuntime(runtimeDir, options);
  console.log(JSON.stringify(result, null, 2));
}

module.exports = {
  LOCK_PATH,
  DEFAULT_CACHE,
  DEFAULT_OUTPUT,
  LIMITS,
  validateLock,
  loadLock,
  selectArtifact,
  prepareArchive,
  extractMember,
  extractZipMember,
  executableArchitecture,
  stageRuntime,
  readManifest,
  refreshManifest,
  verifyRuntime,
  smokeRuntime,
  packagingTarget,
  packagedRuntimeDirectory,
  cli,
};
if (require.main === module)
  cli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
