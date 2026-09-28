import {
  constants,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { isRelayHostId, isRelayOrigin, isRelayToken } from "@cjhyy/code-shell-server/remote-relay";

export interface RelayRegistration {
  relayOrigin: string;
  publicOrigin: string;
  hostId: string;
  environmentId: string;
  credential: string;
  credentialEpoch: number;
  protocolVersion: 1;
  name: string;
}
export interface RelaySecretCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
export function validRegistration(value: unknown): value is RelayRegistration {
  const data = value as RelayRegistration | undefined;
  return (
    !!data &&
    isRelayOrigin(data.relayOrigin) &&
    isRelayOrigin(data.publicOrigin) &&
    isRelayHostId(data.hostId) &&
    isRelayHostId(data.environmentId) &&
    isRelayToken(data.credential) &&
    Number.isSafeInteger(data.credentialEpoch) &&
    data.credentialEpoch > 0 &&
    data.protocolVersion === 1 &&
    typeof data.name === "string" &&
    data.name.length > 0 &&
    data.name.length <= 100
  );
}

/** Separate from generic credentials: no renderer enumeration/export path. */
export class DeviceRelayStore {
  constructor(
    private readonly path: string,
    private readonly cipher: RelaySecretCipher,
  ) {}
  private assertAvailable() {
    if (!this.cipher.available())
      throw new Error("系统安全存储不可用，请解锁或配置系统密钥环后重新登记。");
  }
  private temporary(bytes: Buffer): string {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const path = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(path, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      return path;
    } catch (error) {
      unlinkSync(path);
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  /** Verify encryption and writable storage before consuming a one-time ticket. */
  preflight() {
    this.assertAvailable();
    const probe = randomUUID();
    const encrypted = this.cipher.encrypt(probe);
    if (this.cipher.decrypt(encrypted) !== probe) throw new Error("系统安全存储校验失败。");
    unlinkSync(this.temporary(encrypted));
  }
  load(): RelayRegistration | undefined {
    let metadata;
    try {
      metadata = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.assertAvailable();
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384)
      throw new Error("电脑登记文件无效，请移除后重新登记。");
    const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const registration = JSON.parse(this.cipher.decrypt(readFileSync(fd)));
      if (!validRegistration(registration)) throw new Error("电脑登记文件无效，请重新登记。");
      return registration;
    } finally {
      closeSync(fd);
    }
  }
  save(registration: RelayRegistration) {
    this.assertAvailable();
    if (!validRegistration(registration)) throw new Error("电脑登记响应无效。");
    const temp = this.temporary(this.cipher.encrypt(JSON.stringify(registration)));
    try {
      renameSync(temp, this.path);
    } catch (error) {
      unlinkSync(temp);
      throw error;
    }
  }

  forget() {
    try {
      unlinkSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
