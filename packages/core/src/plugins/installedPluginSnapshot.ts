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
import { dirname, resolve } from "node:path";

export function pluginSourceIdentity(path: string): string {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
    throw new Error("Plugin Hook source is unsafe");
  return identity(info);
}

function identity(info: BigIntStats): string {
  const fields = info.isDirectory()
    ? [info.dev, info.ino, info.mode]
    : [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.nlink];
  return fields.map(String).join(":");
}

/** A provenance-capable registry read, separate from the legacy tolerant loader. */
export function readInstalledPluginSnapshot(path: string) {
  const canonical = resolve(path);
  if (canonical !== path || realpathSync(path) !== path)
    throw new Error("Plugin registry is not canonical");
  const parents: Array<{ path: string; identity: string }> = [];
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = lstatSync(parent, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Unsafe plugin registry traversal");
    parents.push({ path: parent, identity: identity(info) });
    if (dirname(parent) === parent) break;
  }
  const before = lstatSync(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size < 0n ||
    before.size > 16n * 1024n * 1024n
  )
    throw new Error("Plugin registry is not a bounded regular file");
  const pin = identity(before);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (identity(fstatSync(descriptor, { bigint: true })) !== pin)
      throw new Error("Plugin registry changed at open");
    const bytes = Buffer.allocUnsafe(Number(before.size) + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (
      BigInt(length) !== before.size ||
      identity(fstatSync(descriptor, { bigint: true })) !== pin ||
      pluginSourceIdentity(path) !== pin ||
      realpathSync(path) !== path ||
      parents.some((parent) => pluginSourceIdentity(parent.path) !== parent.identity)
    )
      throw new Error("Plugin registry changed during capture");
    const buffer = bytes.subarray(0, length);
    return {
      content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer),
      identity: `${pin}:${createHash("sha256").update(buffer).digest("hex")}`,
    };
  } finally {
    closeSync(descriptor);
  }
}
