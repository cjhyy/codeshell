import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";

/** Immutable OS boot/start identity; lack of inspection is never proof of death. */
export interface ServiceProcessIdentity {
  pid: number;
  start: string;
  host: string;
  boot?: string;
  /** Stable local OS machine identity; hostname alone is not shared-root ownership. */
  machine?: string;
}
export interface ServiceIdentityInspector {
  current(pid: number): ServiceProcessIdentity | null;
  status(identity: ServiceProcessIdentity): "alive" | "dead" | "unknown";
}
/** A live Host cannot cross OS boots. Only this constant is cached; PID/start
 * identity and process/group liveness must always be inspected afresh. */
export function createBootSessionReader(
  read: () => string,
  now: () => number = () => performance.now(),
): () => string | null {
  let boot: string | null = null;
  let retryAt = -Infinity;
  return () => {
    if (boot) return boot;
    if (now() < retryAt) return null;
    try {
      const value = read().trim();
      if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)) {
        boot = value;
        return boot;
      }
    } catch {
      // Failed inspection proves neither ownership nor death.
    }
    retryAt = now() + 1000;
    return null;
  };
}
const darwinBootSession = createBootSessionReader(() =>
  execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
    encoding: "utf8",
    timeout: 2000,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "ignore"],
  }),
);
const linuxBootSession = createBootSessionReader(() =>
  readFileSync("/proc/sys/kernel/random/boot_id", "utf8"),
);
/** Machine identity is constant for this Host lifetime. Failed OS inspection may
 * be slow, so retry once per minute rather than on each reconciliation tick. */
export function createMachineIdentityReader(
  read: () => string | undefined,
  platform = process.platform,
  now: () => number = () => performance.now(),
): () => string | undefined {
  let machineIdentity: string | undefined;
  let retryAt = -Infinity;
  return () => {
    if (machineIdentity) return machineIdentity;
    if (now() < retryAt) return undefined;
    try {
      const value = read()?.trim();
      if (value && /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(value)) {
        machineIdentity = createHash("sha256")
          .update(`${platform}:${value.toLowerCase()}`)
          .digest("hex");
        return machineIdentity;
      }
    } catch {
      /* unavailable machine evidence never proves a different boot is local */
    }
    retryAt = now() + 60_000;
    return undefined;
  };
}
const localMachineIdentity = createMachineIdentityReader(() =>
  process.platform === "linux"
    ? readFileSync("/etc/machine-id", "utf8")
    : process.platform === "darwin"
      ? execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
          encoding: "utf8",
          timeout: 2000,
          killSignal: "SIGKILL",
          maxBuffer: 65536,
          stdio: ["ignore", "pipe", "ignore"],
        }).match(/"IOPlatformUUID"\s*=\s*"([a-f0-9-]+)"/i)?.[1]
      : undefined,
);
export function serviceSystemIdentity(): Pick<ServiceProcessIdentity, "host" | "boot" | "machine"> {
  return {
    host: hostname(),
    boot: (process.platform === "linux" ? linuxBootSession() : darwinBootSession()) ?? undefined,
    machine: localMachineIdentity(),
  };
}
export function parseLinuxProcessStat(
  stat: string,
): { pid: number; group: number; state: string; start: string } | null {
  const fields = stat
    .slice(stat.lastIndexOf(")") + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(stat.slice(0, stat.indexOf(" "))),
    group = Number(fields[2]);
  if (
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    !Number.isSafeInteger(group) ||
    group < 0 ||
    !/^\d+$/.test(fields[19] ?? "") ||
    !/^[A-Zt]$/.test(fields[0] ?? "")
  )
    return null;
  return { pid, group, state: fields[0]!, start: `linux-ticks:${fields[19]}` };
}
export function processIdentity(pid: number): ServiceProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const system = serviceSystemIdentity();
      const stat = parseLinuxProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
      // Zombies have closed their descriptors and can never execute again. Their
      // retained /proc entry is not a live worker identity waiting for a sleep.
      return system.boot && stat && !["Z", "X"].includes(stat.state)
        ? { pid, ...system, start: stat.start }
        : null;
    }
    if (process.platform !== "darwin") return null;
    // bootsessionuuid is stable under wall-clock/NTP adjustment; boottime is not.
    const system = serviceSystemIdentity();
    if (!system.boot) return null;
    const start = darwinProcessStart(pid);
    return start ? { pid, start, ...system } : null;
  } catch {
    return null;
  }
}
/** Kernel unique process ID and exec version, never a wall-clock timestamp. */
export function darwinProcessStart(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    // System JXA calls libproc without requiring Python, a compiler, an addon,
    // or Apple Events to another application. Missing OS inspection fails closed.
    const info = JSON.parse(
      execFileSync(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          `
    ObjC.import("Foundation");
    ObjC.bindFunction("proc_pidinfo", ["int", ["int", "int", "uint64", "void *", "int"]]);
    var data = $.NSMutableData.dataWithLength(56);
    var count = $.proc_pidinfo(${pid}, 17, 0, data.mutableBytes, 56);
    JSON.stringify({count: count, data: ObjC.unwrap(data.base64EncodedStringWithOptions(0))});
  `,
        ],
        {
          encoding: "utf8",
          timeout: 2000,
          killSignal: "SIGKILL",
          maxBuffer: 4096,
          stdio: ["ignore", "pipe", "ignore"],
        },
      ),
    );
    const bytes = Buffer.from(info.data, "base64");
    if (info.count !== 56 || bytes.length !== 56) return null;
    const unique = bytes.readBigUInt64LE(16);
    const version = bytes.readUInt32LE(32);
    return unique ? `darwin-unique:${unique}:${version}` : null;
  } catch {
    return null;
  }
}
export function identityStatus(
  identity: ServiceProcessIdentity,
  inspect: (pid: number) => ServiceProcessIdentity | null = processIdentity,
  system = inspect === processIdentity ? serviceSystemIdentity() : inspect(process.pid),
): "alive" | "dead" | "unknown" {
  const locality = identityLocality(identity, system);
  if (locality === "old-boot") return "dead";
  if (locality !== "same-boot") return "unknown";
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  const current = inspect(identity.pid);
  if (!current && process.platform === "linux") {
    try {
      const stat = parseLinuxProcessStat(readFileSync(`/proc/${identity.pid}/stat`, "utf8"));
      if (stat && ["Z", "X"].includes(stat.state)) return "dead";
    } catch {
      /* an unreadable /proc entry does not prove death */
    }
  }
  // Legacy nonce-only records cannot prove PID reuse. Never kill or steal them.
  if (
    !current ||
    !identity.boot ||
    !/^(?:darwin-unique:\d+:\d+|linux-ticks:\d+)$/.test(identity.start)
  )
    return "unknown";
  return current.boot === identity.boot && current.start === identity.start ? "alive" : "dead";
}
function identityLocality(
  identity: ServiceProcessIdentity,
  system: Pick<ServiceProcessIdentity, "host" | "boot" | "machine"> | null,
): "same-boot" | "old-boot" | "unknown" {
  if (!identity.boot || !system?.boot) return "unknown";
  if (identity.machine && system.machine && identity.machine !== system.machine) return "unknown";
  if (identity.boot === system.boot) return "same-boot";
  return identity.machine && identity.machine === system.machine ? "old-boot" : "unknown";
}
/** Online migration is safe only inside the same verified OS boot. A legacy
 * record first encountered after reboot has no proof it came from this machine. */
export function upgradeLocalServiceIdentity(
  identity: ServiceProcessIdentity,
  system = serviceSystemIdentity(),
): ServiceProcessIdentity {
  return !identity.machine && system.machine && identityLocality(identity, system) === "same-boot"
    ? { ...identity, machine: system.machine }
    : identity;
}
export function identityGroupStatus(
  identity: ServiceProcessIdentity,
  system = serviceSystemIdentity(),
  inspectGroup: typeof groupStatus = groupStatus,
): "alive" | "dead" | "unknown" {
  const locality = identityLocality(identity, system);
  return locality === "old-boot"
    ? "dead"
    : locality === "same-boot"
      ? inspectGroup(identity.pid)
      : "unknown";
}
export const serviceIdentityInspector: ServiceIdentityInspector = {
  current: processIdentity,
  status: identityStatus,
};
export function groupStatus(pid: number): "alive" | "dead" | "unknown" {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "unknown";
  try {
    process.kill(-pid, 0);
    if (process.platform !== "linux") return "alive";
    return linuxGroupStatus(pid);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
/** kill(0) includes unreaped zombies on Linux. Prove that every visible group
 * member is terminal; incomplete /proc visibility remains unknown. */
export function linuxGroupStatus(
  pid: number,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  list: () => string[] = () => readdirSync("/proc"),
): "alive" | "dead" | "unknown" {
  try {
    try {
      const leader = parseLinuxProcessStat(read(`/proc/${pid}/stat`));
      if (leader?.group === pid && !["Z", "X"].includes(leader.state)) return "alive";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
    }
    const mounts = read("/proc/mounts")
      .split("\n")
      .map((line) => line.split(" "));
    const mount = mounts.find((fields) => fields[1] === "/proc" && fields[2] === "proc");
    if (
      !mount ||
      mount[3]!.split(",").some((option) => option.startsWith("hidepid=") && option !== "hidepid=0")
    )
      return "unknown";
    if (parseLinuxProcessStat(read("/proc/self/stat"))?.pid !== process.pid) return "unknown";
    const scan = (): Map<number, string> | "alive" | "unknown" => {
      const terminal = new Map<number, string>();
      for (const name of list()) {
        if (!/^\d+$/.test(name)) continue;
        try {
          const member = parseLinuxProcessStat(read(`/proc/${name}/stat`));
          if (!member || member.pid !== Number(name)) return "unknown";
          if (member.group !== pid) continue;
          if (!["Z", "X"].includes(member.state)) return "alive";
          terminal.set(member.pid, member.start);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unknown";
        }
      }
      return terminal;
    };
    const before = scan();
    if (typeof before === "string") return before;
    if (!before.size) return "unknown";
    // /proc enumeration is not a snapshot: a member can fork after the first
    // listing and become a zombie before stat. All first-pass members are now
    // terminal, so enumerate afresh and require exactly the same start identities.
    // A late descendant, reaped member or PID reuse keeps recovery conservative.
    const after = scan();
    if (typeof after === "string") return after;
    return before.size === after.size &&
      [...before].every(([member, start]) => after.get(member) === start)
      ? "dead"
      : "unknown";
  } catch {
    return "unknown";
  }
}
export const backgroundServiceReadFormats = new Set(["panel.background-service/1"]);
export const backgroundServiceWriteFormats = new Set(["panel.background-service/1"]);

export type CommitBoundary =
  | "write"
  | "file-fsync"
  | "rename"
  | "directory-fsync"
  | "lock-write"
  | "lock-file-fsync"
  | "lock-stage-fsync"
  | "lock-rename"
  | "lock-root-fsync";
function syncDirectory(path: string): void {
  const file = openSync(path, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
}
function readLockOwner(path: string): ServiceProcessIdentity {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size === 0 || info.size > 8192)
      throw new Error("owner is not a bounded regular file");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      !value ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.host !== "string" ||
      !value.host ||
      value.host.length > 255 ||
      typeof value.start !== "string" ||
      !value.start ||
      value.start.length > 256 ||
      (value.boot !== undefined &&
        (typeof value.boot !== "string" || !value.boot || value.boot.length > 128)) ||
      (value.machine !== undefined &&
        (typeof value.machine !== "string" || !value.machine || value.machine.length > 128))
    )
      throw new Error("invalid owner identity");
    return value;
  } catch (cause) {
    throw new Error(
      "SERVICE_COORDINATOR_LOCK_CORRUPT: owner token is empty, damaged or unreadable; retained for diagnosis",
      { cause },
    );
  }
}
export class BackgroundServiceStore<T extends { format: string }> {
  private owner?: string;
  private poisoned = false;
  private lockPending = false;
  constructor(
    readonly root: string,
    private readonly fault?: (boundary: CommitBoundary) => void,
    private readonly identities: ServiceIdentityInspector = serviceIdentityInspector,
  ) {}
  acquire(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, "coordinator.lock");
    if (this.owner) {
      if (!this.lockPending) return;
      const owners = readdirSync(lock);
      if (owners.length !== 1 || owners[0] !== this.owner)
        throw new Error("SERVICE_COORDINATOR_LOCK_CORRUPT: retained ownership changed");
      readLockOwner(join(lock, this.owner));
      // A previous rename succeeded but its directory fsync was uncertain. The
      // same retained owner may finish durability; another owner cannot steal it.
      syncDirectory(lock);
      syncDirectory(this.root);
      this.poisoned = false;
      this.lockPending = false;
      return;
    }
    const identity = this.identities.current(process.pid);
    if (!identity) throw new Error("SERVICE_IDENTITY_UNAVAILABLE");
    const token = `owner-${randomUUID()}.json`;
    const stage = join(this.root, `.lock-${randomUUID()}`);
    const install = () => {
      renameSync(stage, lock);
      this.owner = token;
      this.poisoned = true;
      this.lockPending = true;
      this.fault?.("lock-rename");
      syncDirectory(this.root);
      this.fault?.("lock-root-fsync");
      this.poisoned = false;
      this.lockPending = false;
      // Abandoned payloads were never authoritative. Only the elected writer
      // cleans exact temporary-record names; stop tombstones are never removed.
      for (const name of readdirSync(this.root))
        if (/^\.[a-f0-9]{64}-[a-f0-9-]+\.tmp$/.test(name)) unlinkSync(join(this.root, name));
    };
    try {
      mkdirSync(stage, { mode: 0o700 });
      const file = openSync(join(stage, token), "wx", 0o600);
      try {
        writeFileSync(file, JSON.stringify(identity));
        this.fault?.("lock-write");
        fsyncSync(file);
        this.fault?.("lock-file-fsync");
      } finally {
        closeSync(file);
      }
      syncDirectory(stage);
      this.fault?.("lock-stage-fsync");
      try {
        install();
        return;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      const owners = readdirSync(lock);
      if (owners.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(owners[0]!))
        throw new Error(
          "SERVICE_COORDINATOR_LOCK_CORRUPT: expected exactly one immutable owner token",
        );
      const previous = readLockOwner(join(lock, owners[0]!));
      if (this.identities.status(previous) !== "dead") {
        if (!previous.machine && previous.boot && identity.boot && previous.boot !== identity.boot)
          throw new Error(
            "SERVICE_COORDINATOR_LEGACY_LOCALITY_UNCONFIRMED: old-boot token has no machine proof; retained, do not remove until its original Host and group are verified stopped",
          );
        throw new Error("SERVICE_COORDINATOR_BUSY");
      }
      // Exact immutable token only. Never rename an existing shared lock directory.
      unlinkSync(join(lock, owners[0]!));
      syncDirectory(lock);
      rmdirSync(lock);
      syncDirectory(this.root);
      install();
    } finally {
      if (!this.owner) {
        try {
          unlinkSync(join(stage, token));
          rmdirSync(stage);
        } catch {
          /* another owner wins */
        }
      }
    }
  }
  available(): boolean {
    return !!this.owner && !this.poisoned;
  }
  /** Only the retained exclusive owner may reload after an uncertain write. */
  recover(validate?: (record: T) => void): T[] {
    if (!this.owner || this.lockPending) throw new Error("SERVICE_COORDINATOR_UNAVAILABLE");
    const records = this.all();
    for (const record of records) validate?.(record);
    this.poisoned = false;
    return records;
  }
  quarantine(): void {
    this.poisoned = true;
  }
  release(): void {
    if (!this.owner) return;
    const token = this.owner;
    this.owner = undefined;
    try {
      unlinkSync(join(this.root, "coordinator.lock", token));
      syncDirectory(join(this.root, "coordinator.lock"));
      rmdirSync(join(this.root, "coordinator.lock"));
      syncDirectory(this.root);
    } catch {
      /* only our exact token */
    }
  }
  key(scope: { appId: string; projectPath: string; name: string }): string {
    return createHash("sha256")
      .update([scope.appId, scope.projectPath, scope.name].join("\0"))
      .digest("hex");
  }
  read(key: string): T | undefined {
    try {
      const bytes = readFileSync(join(this.root, `${key}.json`));
      if (bytes.length > 5 * 1024 * 1024) throw new Error("SERVICE_RECORD_TOO_LARGE");
      const record = JSON.parse(bytes.toString());
      if (!backgroundServiceReadFormats.has(record.format))
        throw new Error("SERVICE_FORMAT_UNSUPPORTED");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  all(): T[] {
    return readdirSync(this.root)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) => this.read(name.slice(0, -5))!);
  }
  commit(key: string, record: T): void {
    if (!this.owner || this.poisoned) throw new Error("SERVICE_COORDINATOR_UNAVAILABLE");
    if (!backgroundServiceWriteFormats.has(record.format))
      throw new Error("SERVICE_FORMAT_UNSUPPORTED");
    const data = JSON.stringify(record);
    if (Buffer.byteLength(data) > 5 * 1024 * 1024) throw new Error("SERVICE_RECORD_TOO_LARGE");
    const temp = join(this.root, `.${key}-${randomUUID()}.tmp`);
    let file: number | undefined;
    try {
      file = openSync(temp, "wx", 0o600);
      writeFileSync(file, data);
      this.fault?.("write");
      fsyncSync(file);
      this.fault?.("file-fsync");
      closeSync(file);
      file = undefined;
      renameSync(temp, join(this.root, `${key}.json`));
      this.fault?.("rename");
      const directory = openSync(this.root, "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.fault?.("directory-fsync");
    } catch (error) {
      // A rename may already be durable. Never keep writing a stale in-memory generation.
      this.poisoned = true;
      throw error;
    } finally {
      if (file !== undefined) closeSync(file);
      try {
        unlinkSync(temp);
      } catch {
        /* rename consumed the temporary file */
      }
    }
  }
}
