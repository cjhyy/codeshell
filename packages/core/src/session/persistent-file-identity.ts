/** Persistent file bindings, separate from same-open dev/ino race checks. */
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, type BigIntStats, type Stats } from "node:fs";
import { SaxesParser } from "saxes";

export interface PersistentFileIdentity {
  version: 1;
  volume: string;
  fileId: string;
  birthtimeNs: string;
}

/** Explicit dependencies keep device-number rollover tests independent of the host OS. */
export interface PersistentFileIdentityReaderOptions {
  platform?: NodeJS.Platform;
  lstat?: (path: string) => BigIntStats;
  deviceNames?: () => string[];
  diskInfo?: (device: string) => string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]{0,39})$/;
const SIGNED_DECIMAL = /^(0|-?[1-9][0-9]{0,39})$/;
const MAX_INFO_BYTES = 256 * 1024;
const MAX_CACHED_VOLUMES = 32;
const failed = (message: string) =>
  Object.assign(new Error(`Persistent file identity: ${message}`), {
    code: "CODESHELL_FILE_IDENTITY_UNAVAILABLE",
  });

export function isValidPersistentFileIdentity(value: unknown): value is PersistentFileIdentity {
  const identity = value as PersistentFileIdentity | undefined;
  return Boolean(
    identity &&
    identity.version === 1 &&
    typeof identity.volume === "string" &&
    (/^darwin-volume:[0-9a-f-]{36}$/.test(identity.volume)
      ? UUID.test(identity.volume.slice("darwin-volume:".length))
      : /^device:[a-z0-9-]{1,32}:(0|[1-9][0-9]{0,39})$/.test(identity.volume)) &&
    typeof identity.fileId === "string" &&
    DECIMAL.test(identity.fileId) &&
    typeof identity.birthtimeNs === "string" &&
    SIGNED_DECIMAL.test(identity.birthtimeNs),
  );
}

export function persistentFileIdentityKey(identity: PersistentFileIdentity): string {
  if (!isValidPersistentFileIdentity(identity)) throw failed("invalid stored binding");
  return `${identity.version}\n${identity.volume}\n${identity.fileId}\n${identity.birthtimeNs}`;
}

function sameOpenedFile(named: BigIntStats, opened: Stats | BigIntStats): boolean {
  // Number Stats can round very large APFS root inode values. The durable value
  // always comes from the BigInt path read; callers retain their fd/path checks.
  return (
    (typeof opened.dev === "bigint"
      ? named.dev === opened.dev
      : Number(named.dev) === opened.dev) &&
    (typeof opened.ino === "bigint" ? named.ino === opened.ino : Number(named.ino) === opened.ino)
  );
}

function fingerprint(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}:${stat.rdev}:${stat.birthtimeNs}:${stat.ctimeNs}`;
}

function parseDiskInfo(xml: string): { uuid: string; node: string; mount: string } {
  if (!xml || Buffer.byteLength(xml) > MAX_INFO_BYTES)
    throw failed("invalid disk information size");
  const values = new Map<string, string>();
  const wanted = new Set(["VolumeUUID", "DeviceNode", "MountPoint"]);
  const stack: string[] = [];
  let text = "";
  let key = "";
  let error = false;
  const parser = new SaxesParser({ xmlns: false });
  parser.on("error", (cause) => {
    throw cause;
  });
  parser.on("opentag", (tag) => {
    stack.push(tag.name);
    if (stack.length > 32) throw failed("disk information exceeds its nesting bound");
    text = "";
    if (stack.length === 3 && key === "Error" && tag.name === "true") error = true;
  });
  parser.on("text", (part) => {
    if (stack.length === 3) text += part;
  });
  parser.on("closetag", () => {
    if (stack.length === 3 && stack[0] === "plist" && stack[1] === "dict") {
      if (stack[2] === "key") key = text;
      else if (stack[2] === "string" && wanted.has(key)) {
        if (values.has(key)) throw failed("disk information repeats an identity field");
        values.set(key, text);
      }
    }
    stack.pop();
    text = "";
  });
  parser.write(xml).close();
  const uuid = values.get("VolumeUUID");
  const node = values.get("DeviceNode");
  const mount = values.get("MountPoint");
  if (
    error ||
    !uuid ||
    !UUID.test(uuid) ||
    !node ||
    !/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/.test(node) ||
    !mount ||
    !mount.startsWith("/") ||
    mount.includes("\0")
  )
    throw failed("the mounted volume has no verifiable persistent UUID");
  return { uuid: uuid.toLowerCase(), node, mount };
}

export function createPersistentFileIdentityReader(
  options: PersistentFileIdentityReaderOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const stat = options.lstat ?? ((path: string) => lstatSync(path, { bigint: true }));
  const deviceNames = options.deviceNames ?? (() => readdirSync("/dev"));
  const diskInfo =
    options.diskInfo ??
    ((device: string) =>
      execFileSync("/usr/sbin/diskutil", ["info", "-plist", device], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: MAX_INFO_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C" },
      }));
  const volumes = new Map<
    string,
    { uuid: string; node: string; nodeStamp: string; mount: string; mountStamp: string }
  >();

  const volume = (dev: bigint): string => {
    // Other platforms preserve the previous device binding. This fallback is
    // deliberately not advertised as a cross-remount identity on those OSes.
    if (platform !== "darwin") return `device:${platform}:${dev}`;
    const cached = volumes.get(String(dev));
    if (cached) {
      try {
        const node = stat(cached.node),
          mount = stat(cached.mount);
        if (
          node.isBlockDevice() &&
          node.rdev === dev &&
          mount.isDirectory() &&
          !mount.isSymbolicLink() &&
          mount.dev === dev &&
          fingerprint(node) === cached.nodeStamp &&
          fingerprint(mount) === cached.mountStamp
        )
          return `darwin-volume:${cached.uuid}`;
      } catch {
        // An unplugged/remounted device must be resolved again, never accepted
        // solely because the OS reused a device number from the cache.
      }
      volumes.delete(String(dev));
    }
    const names = deviceNames().filter((name) => /^disk[0-9]+(?:s[0-9]+)*$/.test(name));
    if (names.length > 512) throw failed("device inventory exceeds its bound");
    for (const name of names.sort()) {
      const nodePath = `/dev/${name}`;
      let before: BigIntStats;
      try {
        before = stat(nodePath);
      } catch {
        continue;
      }
      if (!before.isBlockDevice() || before.rdev !== dev) continue;
      const info = parseDiskInfo(diskInfo(nodePath));
      const node = stat(nodePath),
        mount = stat(info.mount);
      if (
        info.node !== nodePath ||
        !node.isBlockDevice() ||
        node.rdev !== dev ||
        fingerprint(node) !== fingerprint(before) ||
        !mount.isDirectory() ||
        mount.isSymbolicLink() ||
        mount.dev !== dev
      )
        throw failed("mounted volume changed during UUID lookup");
      if (volumes.size >= MAX_CACHED_VOLUMES) volumes.delete(volumes.keys().next().value!);
      volumes.set(String(dev), {
        uuid: info.uuid,
        node: nodePath,
        nodeStamp: fingerprint(node),
        mount: info.mount,
        mountStamp: fingerprint(mount),
      });
      return `darwin-volume:${info.uuid}`;
    }
    throw failed("no local block device proves the volume UUID");
  };

  const capture = (path: string, opened?: Stats | BigIntStats): PersistentFileIdentity => {
    const before = stat(path);
    if (
      before.isSymbolicLink() ||
      (!before.isFile() && !before.isDirectory()) ||
      (opened && !sameOpenedFile(before, opened))
    )
      throw failed("named file does not match the opened file");
    const id = volume(before.dev);
    const after = stat(path);
    if (!sameOpenedFile(after, before) || after.birthtimeNs !== before.birthtimeNs)
      throw failed("file changed during volume lookup");
    const identity: PersistentFileIdentity = {
      version: 1,
      volume: id,
      fileId: before.ino.toString(),
      birthtimeNs: before.birthtimeNs.toString(),
    };
    if (!isValidPersistentFileIdentity(identity)) throw failed("unsupported file identity");
    return identity;
  };

  return {
    capturePersistentFileIdentity: capture,
    matchesPersistentFileIdentity: (
      path: string,
      identity: PersistentFileIdentity,
      opened?: Stats | BigIntStats,
    ): boolean =>
      isValidPersistentFileIdentity(identity) &&
      persistentFileIdentityKey(capture(path, opened)) === persistentFileIdentityKey(identity),
  };
}

const reader = createPersistentFileIdentityReader();
export const capturePersistentFileIdentity = reader.capturePersistentFileIdentity;
export const matchesPersistentFileIdentity = reader.matchesPersistentFileIdentity;
