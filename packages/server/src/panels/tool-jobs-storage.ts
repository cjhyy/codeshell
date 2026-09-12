import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
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
    const lockPath = join(this.root, "owner.lock");
    const create = () => open(lockPath, "wx", 0o600);
    let lock;
    try {
      lock = await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const current = (await this.read(lockPath, 1024)) as { pid?: unknown };
      let alive = false;
      if (Number.isSafeInteger(current.pid) && Number(current.pid) > 1) {
        try {
          process.kill(Number(current.pid), 0);
          alive = true;
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") alive = true;
        }
      } else throw new Error("invalid tool job ownership lock", { cause: error });
      if (alive)
        throw new Error("tool job storage is already owned by a running Host", { cause: error });
      await rm(lockPath);
      lock = await create();
    }
    this.nonce = randomUUID();
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, nonce: this.nonce }));
      await lock.sync();
    } finally {
      await lock.close();
    }
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

  async close(): Promise<void> {
    if (!this.nonce) return;
    const path = join(await this.directory(), "owner.lock");
    const lock = (await this.read(path, 1024)) as { nonce?: unknown };
    if (lock.nonce === this.nonce) await rm(path);
    this.nonce = "";
    this.directories.clear();
  }

  async remove(id: string): Promise<void> {
    const path = await this.directory(id);
    await rm(path, { recursive: true, force: true });
    for (const key of this.directories.keys())
      if (key === path || key.startsWith(`${path}/`)) this.directories.delete(key);
  }
}
