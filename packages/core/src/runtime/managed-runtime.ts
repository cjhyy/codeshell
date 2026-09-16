import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_EXECUTABLE_BYTES = 1024 * 1024 * 1024;

export interface ManagedRuntimeDescriptor {
  id: string;
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  sha256: string;
}

/** Host-only paths; resolving a runtime does not grant permission to execute it. */
export interface ResolvedManagedRuntime extends ManagedRuntimeDescriptor {
  executablePath: string;
  binDirectory: string;
}

export interface ManagedRuntimeProvider {
  /** Validate installed runtimes. A missing root is empty; invalid packages throw. */
  list(): Promise<ManagedRuntimeDescriptor[]>;
  /** Missing runtime IDs return null; invalid or incompatible packages throw. */
  resolve(id: string): Promise<ResolvedManagedRuntime | null>;
}

export class ManagedRuntimeError extends Error {
  constructor(
    readonly code:
      | "INVALID_ARGUMENT"
      | "INVALID_MANIFEST"
      | "UNSAFE_PATH"
      | "PLATFORM_MISMATCH"
      | "INTEGRITY_MISMATCH"
      | "CHANGED_DURING_READ"
      | "INVALID_PACKAGE",
    message: string,
  ) {
    super(message);
    this.name = "ManagedRuntimeError";
  }
}

interface Manifest extends ManagedRuntimeDescriptor {
  schemaVersion: 1;
  executable: string;
  source: { url: string; archiveSha256: string };
}

interface Snapshot {
  path: string;
  info: BigIntStats;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mode === b.mode &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.nlink === b.nlink
  );
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function changed(path: string): never {
  throw new ManagedRuntimeError("CHANGED_DURING_READ", `Runtime file changed: ${path}`);
}

async function snapshot(path: string, kind: "directory" | "file"): Promise<Snapshot> {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink())
    throw new ManagedRuntimeError("UNSAFE_PATH", `Runtime symlink is not allowed: ${path}`);
  if (kind === "directory" ? !info.isDirectory() : !info.isFile())
    throw new ManagedRuntimeError("INVALID_PACKAGE", `Expected runtime ${kind}: ${path}`);
  return { path, info };
}

async function recheck(snapshots: Snapshot[]): Promise<void> {
  for (const before of snapshots) {
    let after: BigIntStats;
    try {
      after = await lstat(before.path, { bigint: true });
    } catch (error) {
      if (missing(error)) changed(before.path);
      throw error;
    }
    if (!sameFile(before.info, after)) changed(before.path);
  }
}

function safeSegment(value: string): boolean {
  return (
    !!value &&
    value !== "." &&
    value !== ".." &&
    !/[\\/:<>"|?*\u0000-\u0020\u007f]/u.test(value) &&
    !/[. ]$/u.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value)
  );
}

function parseManifest(text: string, id: string): Manifest {
  const fail = (): never => {
    throw new ManagedRuntimeError("INVALID_MANIFEST", `Invalid runtime manifest: ${id}`);
  };
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    return fail();
  }
  if (
    !value ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.id !== id ||
    typeof value.version !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/.test(value.version) ||
    typeof value.platform !== "string" ||
    !/^[a-z][a-z0-9]{0,31}$/.test(value.platform) ||
    typeof value.arch !== "string" ||
    !/^[a-z][a-z0-9_]{0,31}$/.test(value.arch) ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256) ||
    typeof value.executable !== "string" ||
    value.executable.length > 512 ||
    !value.executable.split("/").every(safeSegment) ||
    !value.source ||
    Array.isArray(value.source) ||
    typeof value.source.url !== "string" ||
    value.source.url.length > 2048 ||
    typeof value.source.archiveSha256 !== "string" ||
    !SHA256.test(value.source.archiveSha256)
  )
    return fail();
  try {
    const url = new URL(value.source.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return fail();
  } catch {
    return fail();
  }
  return value as Manifest;
}

async function readVerifiedFile(before: Snapshot, maxBytes: number, hashOnly = false) {
  if (before.info.size <= 0n || before.info.size > BigInt(maxBytes))
    throw new ManagedRuntimeError("INVALID_PACKAGE", `Invalid runtime file size: ${before.path}`);
  // O_NOFOLLOW protects the final component; directory snapshots cover package traversal.
  const handle = await open(before.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameFile(before.info, await handle.stat({ bigint: true }))) changed(before.path);
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.alloc(Math.min(maxBytes, 64 * 1024));
    let position = 0;
    const size = Number(before.info.size);
    while (position < size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, size - position),
        position,
      );
      if (!bytesRead) changed(before.path);
      hash.update(buffer.subarray(0, bytesRead));
      if (!hashOnly) chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
    if (!sameFile(before.info, await handle.stat({ bigint: true }))) changed(before.path);
    await recheck([before]);
    return {
      sha256: hash.digest("hex"),
      text: hashOnly ? "" : Buffer.concat(chunks).toString("utf8"),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Read-only runtime discovery for trusted hosts. Never searches PATH, executes a
 * version probe, downloads files, changes environment variables, or grants consent.
 * The injected root and manifest are supplied by the Host's trusted distribution.
 * Returned paths are snapshots, not execution grants; consumers retain their own
 * execution authorization and must handle package replacement after resolution.
 */
export function createManagedRuntimeProvider(options: {
  root: string;
  platform?: NodeJS.Platform;
  arch?: string;
}): ManagedRuntimeProvider {
  if (!options || typeof options.root !== "string" || !isAbsolute(options.root))
    throw new ManagedRuntimeError("INVALID_ARGUMENT", "Managed runtime root must be absolute");
  const suppliedRoot = resolve(options.root);
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  async function rootSnapshot(): Promise<Snapshot | null> {
    let before: Snapshot;
    try {
      before = await snapshot(suppliedRoot, "directory");
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const path = await realpath(suppliedRoot);
    await recheck([before]);
    return { path, info: before.info };
  }

  async function resolveRuntime(id: string): Promise<ResolvedManagedRuntime | null> {
    if (typeof id !== "string" || !ID.test(id) || !safeSegment(id))
      throw new ManagedRuntimeError("INVALID_ARGUMENT", "Invalid managed runtime ID");
    const root = await rootSnapshot();
    if (!root) return null;
    const runtimePath = join(root.path, id);
    let runtime: Snapshot;
    try {
      runtime = await snapshot(runtimePath, "directory");
    } catch (error) {
      if (missing(error)) {
        await recheck([root]);
        return null;
      }
      throw error;
    }
    const snapshots = [root, runtime];
    try {
      const manifestFile = await snapshot(join(runtimePath, "manifest.json"), "file");
      snapshots.push(manifestFile);
      const manifest = parseManifest(
        (await readVerifiedFile(manifestFile, MAX_MANIFEST_BYTES)).text,
        id,
      );
      if (manifest.platform !== platform || manifest.arch !== arch)
        throw new ManagedRuntimeError(
          "PLATFORM_MISMATCH",
          `Runtime ${id} does not support ${platform}/${arch}`,
        );
      const license = await snapshot(join(runtimePath, "LICENSE"), "file");
      if (license.info.size === 0n)
        throw new ManagedRuntimeError("INVALID_PACKAGE", `Runtime ${id} LICENSE is empty`);
      snapshots.push(license);
      const parts = manifest.executable.split("/");
      let executablePath = runtimePath;
      for (let index = 0; index < parts.length; index++) {
        executablePath = join(executablePath, parts[index]!);
        snapshots.push(
          await snapshot(executablePath, index === parts.length - 1 ? "file" : "directory"),
        );
      }
      const canonical = await realpath(executablePath);
      const inside = relative(runtimePath, canonical);
      if (
        canonical !== executablePath ||
        !inside ||
        inside === ".." ||
        inside.startsWith(`..${sep}`) ||
        isAbsolute(inside)
      )
        throw new ManagedRuntimeError(
          "UNSAFE_PATH",
          `Runtime executable escaped its package: ${id}`,
        );
      const executable = snapshots[snapshots.length - 1]!;
      if (platform !== "win32" && (executable.info.mode & 0o111n) === 0n)
        throw new ManagedRuntimeError(
          "INVALID_PACKAGE",
          `Runtime executable is not executable: ${id}`,
        );
      const content = await readVerifiedFile(executable, MAX_EXECUTABLE_BYTES, true);
      await recheck(snapshots);
      if (content.sha256 !== manifest.sha256)
        throw new ManagedRuntimeError(
          "INTEGRITY_MISMATCH",
          `Runtime executable checksum differs: ${id}`,
        );
      return {
        id,
        version: manifest.version,
        platform: manifest.platform,
        arch: manifest.arch,
        sha256: manifest.sha256,
        executablePath,
        binDirectory: dirname(executablePath),
      };
    } catch (error) {
      if (missing(error))
        throw new ManagedRuntimeError("INVALID_PACKAGE", `Runtime package is incomplete: ${id}`);
      throw error;
    }
  }

  return {
    resolve: resolveRuntime,
    async list() {
      const root = await rootSnapshot();
      if (!root) return [];
      const entries = await readdir(root.path, { withFileTypes: true });
      const runtimes: ManagedRuntimeDescriptor[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!ID.test(entry.name)) continue;
        const value = await resolveRuntime(entry.name);
        if (!value) changed(join(root.path, entry.name));
        const { executablePath: _executablePath, binDirectory: _binDirectory, ...metadata } = value;
        runtimes.push(metadata);
      }
      await recheck([root]);
      return runtimes;
    },
  };
}
