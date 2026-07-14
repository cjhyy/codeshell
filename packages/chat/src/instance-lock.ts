import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

interface GatewayLockRecord {
  version: 1;
  pid: number;
  owner: string;
  token: string;
  startedAt: number;
}

export interface GatewayInstanceLease {
  readonly path: string;
  readonly owner: string;
  release(): void;
}

export class GatewayAlreadyRunningError extends Error {
  constructor(
    readonly path: string,
    readonly current?: Readonly<Pick<GatewayLockRecord, "pid" | "owner" | "startedAt">>,
  ) {
    super(
      current
        ? `Chat Gateway 已由 ${current.owner} 运行（PID ${current.pid}）`
        : `Chat Gateway 已在运行（锁文件：${path}）`,
    );
    this.name = "GatewayAlreadyRunningError";
  }
}

/**
 * Cross-process single-owner lease shared by the CLI and Desktop lifecycle.
 * A dead owner's lock is reclaimed, while a live or unreadable lock fails
 * closed so two processes can never consume the same platform updates.
 */
export function acquireGatewayInstanceLock(path: string, owner: string): GatewayInstanceLease {
  if (!path || !owner) throw new Error("gateway lock path and owner are required");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

  const record: GatewayLockRecord = {
    version: 1,
    pid: process.pid,
    owner,
    token: randomUUID(),
    startedAt: Date.now(),
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf-8");
      closeSync(fd);
      fd = undefined;
      if (process.platform !== "win32") chmodSync(path, 0o600);
      let released = false;
      return {
        path,
        owner,
        release: () => {
          if (released) return;
          released = true;
          removeOwnedLock(path, record.token);
        },
      };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLock(path);
      if (!existing || isProcessAlive(existing.pid)) {
        throw new GatewayAlreadyRunningError(
          path,
          existing
            ? { pid: existing.pid, owner: existing.owner, startedAt: existing.startedAt }
            : undefined,
        );
      }
      // Only reclaim a well-formed lock whose process is demonstrably gone.
      removeOwnedLock(path, existing.token);
    }
  }
  throw new GatewayAlreadyRunningError(path);
}

function readLock(path: string): GatewayLockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<GatewayLockRecord>;
    if (
      value.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.owner !== "string" ||
      typeof value.token !== "string" ||
      typeof value.startedAt !== "number"
    ) {
      return undefined;
    }
    return value as GatewayLockRecord;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeOwnedLock(path: string, token: string): void {
  const current = readLock(path);
  if (current?.token === token) rmSync(path, { force: true });
}
