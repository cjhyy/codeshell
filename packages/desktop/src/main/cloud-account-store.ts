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
import type { CloudAccountIdentity } from "../shared/cloud-account.js";
import type { RelaySecretCipher } from "./device-relay-store.js";

/** Main-process-only grants. Never return this type from an IPC handler. */
export interface CloudAccountGrant {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt: number;
  sessionId: string;
  account: CloudAccountIdentity;
  kind?: "account" | "device";
  audience?: string;
  hostId?: string;
}
export interface SavedCloudAccount extends CloudAccountGrant {
  origin: string;
}

export function validCloudAccountGrant(value: unknown): value is CloudAccountGrant {
  if (!value || typeof value !== "object") return false;
  const grant = value as CloudAccountGrant;
  return (
    isRelayToken(grant.accessToken) &&
    isRelayToken(grant.refreshToken) &&
    isRelayHostId(grant.sessionId) &&
    Number.isSafeInteger(grant.accessTokenExpiresAt) &&
    grant.accessTokenExpiresAt > 0 &&
    Number.isSafeInteger(grant.refreshTokenExpiresAt) &&
    grant.refreshTokenExpiresAt >= grant.accessTokenExpiresAt &&
    !!grant.account &&
    isRelayHostId(grant.account.id) &&
    typeof grant.account.username === "string" &&
    grant.account.username.length > 0 &&
    grant.account.username.length <= 128 &&
    (grant.kind === undefined || grant.kind === "account" || grant.kind === "device") &&
    (grant.audience === undefined || isRelayOrigin(grant.audience)) &&
    (grant.hostId === undefined || isRelayHostId(grant.hostId))
  );
}

function validSaved(value: unknown): value is SavedCloudAccount {
  return (
    validCloudAccountGrant(value) &&
    value.kind !== "device" &&
    isRelayOrigin((value as SavedCloudAccount).origin) &&
    (value.audience === undefined || value.audience === (value as SavedCloudAccount).origin)
  );
}

/** Independent from agent credentials; no plaintext fallback or generic enumeration. */
export class CloudAccountStore {
  constructor(
    private readonly path: string,
    private readonly cipher: RelaySecretCipher,
  ) {}
  private assertAvailable() {
    if (!this.cipher.available()) throw new Error("系统安全存储不可用；本地使用不受影响。");
  }
  private temporary(bytes: Buffer): string {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      fsyncSync(fd);
      return temporary;
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    } finally {
      closeSync(fd);
    }
  }
  preflight() {
    this.assertAvailable();
    const probe = randomUUID();
    const bytes = this.cipher.encrypt(probe);
    if (this.cipher.decrypt(bytes) !== probe) throw new Error("系统安全存储校验失败。");
    unlinkSync(this.temporary(bytes));
  }
  load(): SavedCloudAccount | undefined {
    let metadata;
    try {
      metadata = lstatSync(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.assertAvailable();
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16_384)
      throw new Error("云账号登记损坏，请退出后重新登录。");
    const fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const saved = JSON.parse(this.cipher.decrypt(readFileSync(fd)));
      if (!validSaved(saved)) throw new Error("云账号登记损坏，请退出后重新登录。");
      return saved;
    } finally {
      closeSync(fd);
    }
  }
  save(saved: SavedCloudAccount) {
    this.assertAvailable();
    if (!validSaved(saved)) throw new Error("无效的云账号授权。");
    const temporary = this.temporary(this.cipher.encrypt(JSON.stringify(saved)));
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      unlinkSync(temporary);
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
