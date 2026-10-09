import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ConstrainedReadableResource } from "./types.js";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

function identity(info: BigIntStats): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.nlink]
    .map(String)
    .join(":");
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface ResourceSnapshot {
  name: string;
  bytes: Buffer;
  sha256: string;
  assertCurrent(): void;
}

/** Capture only actual positive Host grants. No directory scan or inferred grants. */
export function captureResources(grants: readonly ConstrainedReadableResource[]) {
  if (grants.length > MAX_FILES) throw new Error("Too many constrained process resources");
  let total = 0;
  const names = new Set<string>();
  const resources: ResourceSnapshot[] = [];
  for (const grant of grants) {
    if (
      !isAbsolute(grant.path) ||
      grant.path.includes("\0") ||
      grant.name.length > 1024 ||
      !grant.name
        .split("/")
        .every((part) => /^[a-zA-Z0-9_.-]+$/.test(part) && part !== "." && part !== "..") ||
      names.has(grant.name)
    )
      throw new Error("Invalid constrained resource mapping");
    names.add(grant.name);
    grant.assertReadable();
    const path = resolve(grant.path);
    const directories: Array<{ path: string; identity: string }> = [];
    let parent = dirname(path);
    while (true) {
      const info = lstatSync(parent, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe resource path");
      directories.push({ path: parent, identity: identity(info) });
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    if (realpathSync(path) !== path) throw new Error("Unsafe resource path");
    const before = lstatSync(path, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_FILE_BYTES) ||
      total + Number(before.size) > MAX_TOTAL_BYTES
    )
      throw new Error("Invalid constrained process resource");
    const fingerprint = identity(before);
    const read = () => {
      grant.assertReadable();
      for (const directory of directories) {
        const current = lstatSync(directory.path, { bigint: true });
        // Parent contents may change independently; pin traversal identity and mode.
        const original = directory.identity.split(":");
        if (
          !current.isDirectory() ||
          current.isSymbolicLink() ||
          String(current.dev) !== original[0] ||
          String(current.ino) !== original[1] ||
          String(current.mode) !== original[2]
        )
          throw new Error("Constrained resource directory changed");
      }
      if (identity(lstatSync(path, { bigint: true })) !== fingerprint)
        throw new Error("Constrained resource changed");
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        if (identity(fstatSync(descriptor, { bigint: true })) !== fingerprint)
          throw new Error("Constrained resource changed");
        const bytes = Buffer.alloc(Number(before.size) + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(descriptor, bytes, length, bytes.length - length, null);
          if (count === 0) break;
          length += count;
        }
        if (length !== Number(before.size)) throw new Error("Constrained resource size changed");
        if (identity(fstatSync(descriptor, { bigint: true })) !== fingerprint)
          throw new Error("Constrained resource changed");
        if (identity(lstatSync(path, { bigint: true })) !== fingerprint)
          throw new Error("Constrained resource changed");
        grant.assertReadable();
        return bytes.subarray(0, length);
      } finally {
        closeSync(descriptor);
      }
    };
    const bytes = read();
    const digest = sha256(bytes);
    total += bytes.length;
    resources.push({
      name: grant.name,
      bytes,
      sha256: digest,
      assertCurrent() {
        if (sha256(read()) !== digest) throw new Error("Constrained resource changed");
      },
    });
  }
  resources.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    resources,
    sha256: sha256(JSON.stringify(resources.map(({ name, sha256 }) => [name, sha256]))),
    assertCurrent() {
      for (const resource of resources) resource.assertCurrent();
    },
  };
}
