import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
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
}
export interface ServiceIdentityInspector {
  current(pid: number): ServiceProcessIdentity | null;
  status(identity: ServiceProcessIdentity): "alive" | "dead" | "unknown";
}
export function processIdentity(pid: number): ServiceProcessIdentity | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const ticks = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/)[19];
      const start = ticks && `linux-ticks:${ticks}`;
      return boot && start ? { pid, boot, start, host: hostname() } : null;
    }
    if (process.platform !== "darwin") return null;
    // bootsessionuuid is stable under wall-clock/NTP adjustment; boottime is not.
    const boot = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const start = darwinProcessStart(pid);
    return boot && start ? { pid, start, boot, host: hostname() } : null;
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
        { encoding: "utf8", timeout: 2000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] },
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
): "alive" | "dead" | "unknown" {
  if (identity.host !== hostname()) return "unknown";
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  const current = inspect(identity.pid);
  // Legacy nonce-only records cannot prove PID reuse. Never kill or steal them.
  if (
    !current ||
    !identity.boot ||
    !/^(?:darwin-unique:\d+:\d+|linux-ticks:\d+)$/.test(identity.start)
  )
    return "unknown";
  return current.boot === identity.boot && current.start === identity.start ? "alive" : "dead";
}
export const serviceIdentityInspector: ServiceIdentityInspector = {
  current: processIdentity,
  status: identityStatus,
};
export function groupStatus(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(-pid, 0);
    return "alive";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}
export const backgroundServiceReadFormats = new Set(["panel.background-service/1"]);
export const backgroundServiceWriteFormats = new Set(["panel.background-service/1"]);

export type CommitBoundary = "write" | "file-fsync" | "rename" | "directory-fsync";
export class BackgroundServiceStore<T extends { format: string }> {
  private owner?: string;
  private poisoned = false;
  constructor(
    readonly root: string,
    private readonly fault?: (boundary: CommitBoundary) => void,
    private readonly identities: ServiceIdentityInspector = serviceIdentityInspector,
  ) {}
  acquire(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const identity = this.identities.current(process.pid);
    if (!identity) throw new Error("SERVICE_IDENTITY_UNAVAILABLE");
    const lock = join(this.root, "coordinator.lock");
    const token = `owner-${randomUUID()}.json`;
    const stage = join(this.root, `.lock-${randomUUID()}`);
    mkdirSync(stage, { mode: 0o700 });
    writeFileSync(join(stage, token), JSON.stringify(identity), { flag: "wx", mode: 0o600 });
    const install = () => {
      renameSync(stage, lock);
      this.owner = token;
      // Abandoned payloads were never authoritative. Only the elected writer
      // cleans exact temporary-record names; stop tombstones are never removed.
      for (const name of readdirSync(this.root))
        if (/^\.[a-f0-9]{64}-[a-f0-9-]+\.tmp$/.test(name)) unlinkSync(join(this.root, name));
    };
    try {
      try {
        install();
        return;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      const owners = readdirSync(lock);
      if (owners.length !== 1 || !/^owner-[a-f0-9-]+\.json$/.test(owners[0]!))
        throw new Error("SERVICE_COORDINATOR_BUSY");
      const previous = JSON.parse(readFileSync(join(lock, owners[0]!), "utf8"));
      if (this.identities.status(previous) !== "dead") throw new Error("SERVICE_COORDINATOR_BUSY");
      // Exact immutable token only. Never rename an existing shared lock directory.
      unlinkSync(join(lock, owners[0]!));
      rmdirSync(lock);
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
    if (!this.owner) throw new Error("SERVICE_COORDINATOR_UNAVAILABLE");
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
      rmdirSync(join(this.root, "coordinator.lock"));
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
