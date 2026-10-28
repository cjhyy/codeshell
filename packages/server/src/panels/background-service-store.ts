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

/** Deliberately no heartbeat or age-based takeover: a live coordinator never loses its lock. */
export interface ServiceProcessIdentity {
  pid: number;
  start: string;
  host: string;
}
const hostIncarnation = `host:${randomUUID()}`;
export function processIdentity(pid: number): ServiceProcessIdentity | null {
  if (pid === process.pid) return { pid, start: hostIncarnation, host: hostname() };
  try {
    const start = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return start ? { pid, start, host: hostname() } : null;
  } catch {
    return null;
  }
}
export function identityStatus(identity: ServiceProcessIdentity): "alive" | "dead" | "unknown" {
  if (identity.host !== hostname()) return "unknown";
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
  // A reused live PID is deliberately retained. Only ESRCH permits takeover.
  if (identity.start.startsWith("host:") || identity.start.startsWith("custody:")) return "alive";
  const current = processIdentity(identity.pid);
  if (!current) return "unknown";
  return current.start === identity.start ? "alive" : "dead";
}
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
  ) {}
  acquire(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const identity = processIdentity(process.pid);
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
      if (identityStatus(previous) !== "dead") throw new Error("SERVICE_COORDINATOR_BUSY");
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
