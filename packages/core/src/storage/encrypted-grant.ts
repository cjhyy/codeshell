import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface RelaySecretCipher {
  available(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(bytes: Buffer): string;
}

export interface AsyncGrantCipher {
  available(): Promise<boolean>;
  encrypt(plaintext: string): Promise<Buffer>;
  decrypt(bytes: Buffer): Promise<string>;
}

/** Sync native CLI stores and Desktop's nonblocking OS keyring share this contract. */
export interface GrantStorage<T> {
  load(): T | undefined | Promise<T | undefined>;
  preflight(): void | Promise<void>;
  save(grant: T, assertCurrent?: () => void): void | Promise<void>;
  forget(): void;
}

const limit = 16_384;
function requireAvailable(available: boolean) {
  if (!available) throw new Error("系统安全存储不可用，请解锁或配置系统密钥环后重试。");
}

class GrantFile<T> {
  constructor(
    readonly path: string,
    private readonly valid: (value: unknown) => value is T,
  ) {}
  read(): Buffer | undefined {
    try {
      const stat = lstatSync(this.path);
      if (!stat.isFile() || stat.size > limit) throw new Error("授权登记文件无效。");
      const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = fstatSync(fd);
        if (
          !opened.isFile() ||
          opened.size > limit ||
          opened.ino !== stat.ino ||
          opened.dev !== stat.dev ||
          (process.platform !== "win32" &&
            (opened.mode & 0o077 || (process.getuid && opened.uid !== process.getuid())))
        )
          throw new Error("授权登记文件无效。");
        const bytes = Buffer.alloc(limit + 1);
        let length = 0;
        while (length < bytes.length) {
          const count = readSync(fd, bytes, length, bytes.length - length, null);
          if (!count) break;
          length += count;
        }
        if (length > limit) throw new Error("授权登记文件过大。");
        return bytes.subarray(0, length);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
  decode(json: string): T {
    const grant: unknown = JSON.parse(json);
    if (!this.valid(grant)) throw new Error("授权登记损坏，请重新登录。");
    return grant;
  }
  encode(grant: T) {
    if (!this.valid(grant)) throw new Error("授权登记无效。");
    return JSON.stringify(grant);
  }
  private remove(path: string) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  write(bytes: Buffer, probe = false) {
    if (bytes.length > limit) throw new Error("授权登记文件过大。");
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = this.path + "." + randomUUID() + ".tmp";
    const fd = openSync(tmp, "wx", 0o600);
    try {
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      if (!probe) renameSync(tmp, this.path);
    } finally {
      this.remove(tmp);
    }
  }
  forget() {
    this.remove(this.path);
  }
}

export class EncryptedGrantStore<T> implements GrantStorage<T> {
  private readonly file: GrantFile<T>;
  constructor(
    path: string,
    private readonly cipher: RelaySecretCipher,
    valid: (value: unknown) => value is T,
  ) {
    this.file = new GrantFile(path, valid);
  }
  load(): T | undefined {
    const bytes = this.file.read();
    if (!bytes) return;
    requireAvailable(this.cipher.available());
    return this.file.decode(this.cipher.decrypt(bytes));
  }
  save(grant: T, assertCurrent?: () => void) {
    requireAvailable(this.cipher.available());
    const bytes = this.cipher.encrypt(this.file.encode(grant));
    assertCurrent?.();
    this.file.write(bytes);
  }
  preflight() {
    requireAvailable(this.cipher.available());
    const probe = randomUUID();
    const bytes = this.cipher.encrypt(probe);
    if (this.cipher.decrypt(bytes) !== probe) throw new Error("系统安全存储校验失败。");
    this.file.write(bytes, true);
  }
  forget() {
    this.file.forget();
  }
}

export class AsyncEncryptedGrantStore<T> implements GrantStorage<T> {
  private readonly file: GrantFile<T>;
  private generation = 0;
  constructor(
    path: string,
    private readonly cipher: AsyncGrantCipher,
    valid: (value: unknown) => value is T,
  ) {
    this.file = new GrantFile(path, valid);
  }
  async load(): Promise<T | undefined> {
    const generation = this.generation;
    const bytes = this.file.read();
    if (!bytes) return;
    requireAvailable(await this.cipher.available());
    const json = await this.cipher.decrypt(bytes);
    if (generation !== this.generation) throw new Error("授权登记已变更。");
    return this.file.decode(json);
  }
  async save(grant: T, assertCurrent?: () => void) {
    const generation = this.generation;
    const json = this.file.encode(grant);
    requireAvailable(await this.cipher.available());
    const bytes = await this.cipher.encrypt(json);
    if (generation !== this.generation) throw new Error("授权登记已变更。");
    assertCurrent?.();
    this.file.write(bytes);
    this.generation++;
  }
  async preflight() {
    requireAvailable(await this.cipher.available());
    const probe = randomUUID();
    const bytes = await this.cipher.encrypt(probe);
    if ((await this.cipher.decrypt(bytes)) !== probe) throw new Error("系统安全存储校验失败。");
    this.file.write(bytes, true);
  }
  forget() {
    this.generation++;
    this.file.forget();
  }
}
