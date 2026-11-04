import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, readdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export function toolJobJson<T>(value: T, limit: number): T {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    /* reject below */
  }
  if (text === undefined || Buffer.byteLength(text) > limit)
    throw new Error("tool job JSON exceeds its limit or is not serializable");
  return JSON.parse(text) as T;
}

/** A private Host directory, with each descendant checked before file operations. */
export class ToolJobStorage {
  private root = "";
  private identity = "";
  private nonce = "";
  private ownerClaimFile = "";
  private readonly directories = new Map<string, string>();

  constructor(private readonly configuredRoot: string) {}

  async initialize(): Promise<void> {
    if (!isAbsolute(this.configuredRoot)) throw new Error("tool job root must be absolute");
    await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
    const initial = await lstat(this.configuredRoot);
    if (!initial.isDirectory() || initial.isSymbolicLink())
      throw new Error("invalid tool job root");
    this.root = await realpath(this.configuredRoot);
    this.identity = `${initial.dev}:${initial.ino}`;
    this.nonce = randomUUID();
    try {
      await this.acquireOwnerClaim();
      // Keep the previous file format as an interoperability barrier for older
      // Hosts. All current Hosts hold the atomic directory claim before touching it.
      const lockPath = join(this.root, "owner.lock");
      try {
        const current = (await this.read(lockPath, 1024)) as { pid?: unknown };
        this.assertDeadOwner(current.pid);
        await rm(lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const lock = await open(lockPath, "wx", 0o600);
      try {
        await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: this.nonce }));
        await lock.sync();
      } finally {
        await lock.close();
      }
    } catch (error) {
      await this.releaseOwnerClaim();
      this.nonce = "";
      throw error;
    }
  }

  private assertDeadOwner(pid: unknown): void {
    if (!Number.isSafeInteger(pid) || Number(pid) <= 1) {
      throw new Error("invalid tool job ownership lock");
    }
    try {
      process.kill(Number(pid), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    throw new Error("tool job storage is already owned by a running Host");
  }

  private async acquireOwnerClaim(): Promise<void> {
    const destination = join(this.root, "owner.claim");
    const temporary = join(this.root, `.owner-${this.nonce}`);
    const marker = `${this.nonce}.json`;
    await mkdir(temporary, { mode: 0o700 });
    try {
      const file = await open(join(temporary, marker), "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ pid: process.pid, nonce: this.nonce }));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await rename(temporary, destination);
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
        const directory = await lstat(destination);
        if (!directory.isDirectory() || directory.isSymbolicLink())
          throw new Error("invalid tool job ownership claim", { cause: error });
        const entries = await readdir(destination);
        if (entries.length > 1 || entries.some((entry) => !/^[a-f0-9-]{36}\.json$/.test(entry))) {
          throw new Error("invalid tool job ownership claim", { cause: error });
        }
        if (entries[0]) {
          const stalePath = join(destination, entries[0]);
          try {
            const current = (await this.read(stalePath, 1024)) as { pid?: unknown };
            this.assertDeadOwner(current.pid);
            // Delete only the observed owner's unique marker. A delayed
            // reclaimer cannot unlink a new owner's different marker.
            await unlink(stalePath);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
        }
        // Never move the existing claim: a replacement may already own it.
        // Some platforms cannot replace even an empty destination directory.
        // rmdir is safe here: it cannot remove a newly published nonempty claim.
        await rmdir(destination).catch((cause: NodeJS.ErrnoException) => {
          if (cause.code !== "ENOENT") throw cause;
        });
        await rename(temporary, destination);
      }
      this.ownerClaimFile = join(destination, marker);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async releaseOwnerClaim(): Promise<void> {
    if (!this.ownerClaimFile) return;
    await unlink(this.ownerClaimFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    this.ownerClaimFile = "";
  }

  async directory(id?: string, work = false, create = false): Promise<string> {
    const info = await lstat(this.root);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      `${info.dev}:${info.ino}` !== this.identity ||
      (await realpath(this.root)) !== this.root
    )
      throw new Error("tool job root was replaced");
    let path = this.root;
    for (const part of id === undefined ? [] : [id, ...(work ? ["work"] : [])]) {
      if (part !== "work" && !/^[a-f0-9-]{36}$/.test(part))
        throw new Error("invalid tool job directory");
      path = join(path, part);
      if (create)
        await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      const child = await lstat(path);
      if (!child.isDirectory() || child.isSymbolicLink())
        throw new Error("invalid tool job directory");
      const identity = `${child.dev}:${child.ino}`;
      const expected = this.directories.get(path);
      if (expected && expected !== identity) throw new Error("tool job directory was replaced");
      this.directories.set(path, identity);
    }
    return path;
  }

  async read(path: string, limit: number): Promise<unknown> {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > limit)
        throw new Error("invalid tool job record");
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      const after = await file.stat();
      if (
        count !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs ||
        after.nlink !== 1
      )
        throw new Error("tool job record changed while reading");
      return JSON.parse(bytes.subarray(0, count).toString("utf8"));
    } finally {
      await file.close();
    }
  }

  async write(id: string, value: unknown, limit: number): Promise<void> {
    const directory = await this.directory(id, false, true);
    const path = join(directory, "job.json");
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(toolJobJson(value, limit)));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await this.directory(id);
      await rename(temporary, path);
      const parent = await open(dirname(path), "r").catch(() => null);
      if (parent) {
        await parent.sync().catch(() => {});
        await parent.close();
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async readQueueCatalog(limit: number): Promise<unknown> {
    try {
      return await this.read(join(await this.directory(), "queues.json"), limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async writeQueueCatalog(value: unknown, limit: number): Promise<void> {
    const directory = await this.directory();
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(toolJobJson(value, limit)));
        await file.sync();
      } finally {
        await file.close();
      }
      await this.directory();
      await rename(temporary, join(directory, "queues.json"));
      const parent = await open(directory, "r").catch(() => null);
      if (parent) {
        await parent.sync().catch(() => {});
        await parent.close();
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (!this.nonce) return;
    try {
      const path = join(await this.directory(), "owner.lock");
      const lock = (await this.read(path, 1024)) as { nonce?: unknown };
      if (lock.nonce === this.nonce) await rm(path);
    } finally {
      await this.releaseOwnerClaim();
      this.nonce = "";
      this.directories.clear();
    }
  }

  async remove(id: string): Promise<void> {
    const path = await this.directory(id);
    await rm(path, { recursive: true, force: true });
    for (const key of this.directories.keys())
      if (key === path || key.startsWith(`${path}/`)) this.directories.delete(key);
  }
}
