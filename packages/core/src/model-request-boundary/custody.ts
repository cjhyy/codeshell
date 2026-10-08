import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EncryptionCipher } from "../credentials/cipher.js";
import { acquireFileLock, writeFileAtomic } from "../utils/file-mutex.js";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import { syncDirectoryAncestors } from "./durability.js";
import type {
  ModelRequestCustody,
  ModelRequestSignInput,
  ModelRequestSignatures,
  ModelRequestSigner,
  ModelRequestSubject,
  PrivateRequestDomain,
} from "./types.js";

const domains = new Set(["system", "messages", "wire", "source-context"]);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
function validSubject(value: ModelRequestSubject): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 256 &&
    !/[\x00-\x1f]/.test(value.sessionId) &&
    typeof value.storageScopeId === "string" &&
    digest.test(value.storageScopeId) &&
    typeof value.sessionInstanceId === "string" &&
    uuid.test(value.sessionInstanceId) &&
    (value.ephemeral === undefined || typeof value.ephemeral === "boolean"),
  );
}
interface KeyRecord {
  version: 1;
  ownerDigest: string;
  keyId: string;
  custodyMode: ModelRequestCustody;
  protectedKey: string;
}

/** Session-incarnation keys live outside Transcript storage, under an explicit Host policy. */
export class ModelRequestKeyStore implements ModelRequestSigner {
  private readonly ephemeralKeys = new Map<string, { keyId: string; key: Buffer }>();
  constructor(
    private readonly options:
      | {
          directory: string;
          cipher: EncryptionCipher;
          custodyMode: Exclude<ModelRequestCustody, "ephemeral-memory">;
        }
      | { custodyMode: "ephemeral-memory" },
  ) {
    if (options.custodyMode === "ephemeral-memory") return;
    if (
      !options.directory ||
      !["host-encrypted", "owner-only-plaintext"].includes(options.custodyMode)
    )
      throw new Error("Invalid request key custody configuration");
  }

  async sign(input: ModelRequestSignInput): Promise<ModelRequestSignatures> {
    if (
      !input ||
      !validSubject(input.subject) ||
      !input.prehashes ||
      typeof input.prehashes !== "object" ||
      Array.isArray(input.prehashes)
    )
      throw new Error("Invalid request signing input");
    const entries = Object.entries(input.prehashes);
    if (
      !entries.length ||
      entries.length > domains.size ||
      entries.some(
        ([domain, value]) =>
          !domains.has(domain) || typeof value !== "string" || !digest.test(value),
      )
    )
      throw new Error("Invalid request signing domains");
    const ownerDigest = canonicalDigest({
      sessionId: input.subject.sessionId,
      storageScopeId: input.subject.storageScopeId,
      sessionInstanceId: input.subject.sessionInstanceId,
      ...(input.subject.ephemeral === true ? { ephemeral: true } : {}),
    });
    let record: Pick<KeyRecord, "keyId" | "custodyMode">;
    let key: Buffer;
    if (input.subject.ephemeral === true) {
      let owned = this.ephemeralKeys.get(ownerDigest);
      if (!owned) {
        owned = { keyId: randomUUID(), key: randomBytes(32) };
        this.ephemeralKeys.set(ownerDigest, owned);
      }
      record = { keyId: owned.keyId, custodyMode: "ephemeral-memory" };
      key = Buffer.from(owned.key);
    } else {
      ({ record, key } = this.keyFor(ownerDigest));
    }
    const signatures: ModelRequestSignatures["digests"] = {};
    try {
      for (const [domain, prehash] of entries)
        signatures[domain as PrivateRequestDomain] = createHmac("sha256", key)
          .update(`codeshell:model-request:v1:${domain}:`)
          .update(prehash)
          .digest("hex");
    } finally {
      key.fill(0);
    }
    return {
      version: 1,
      keyId: record.keyId,
      custodyMode: record.custodyMode,
      digests: signatures,
    };
  }

  dispose(): void {
    for (const owned of this.ephemeralKeys.values()) owned.key.fill(0);
    this.ephemeralKeys.clear();
  }

  private keyFor(ownerDigest: string): { record: KeyRecord; key: Buffer } {
    if (this.options.custodyMode === "ephemeral-memory")
      throw new Error("Ephemeral request signer cannot sign a durable Session");
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.options.directory);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (process.platform !== "win32" &&
        ((directory.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && directory.uid !== process.getuid())))
    )
      throw new Error("Request key custody directory is not private");
    const file = join(this.options.directory, `${ownerDigest}.json`);
    // The critical section has no await; concurrent hosts cannot rotate a Session key.
    const release = acquireFileLock(file);
    try {
      let record: KeyRecord;
      let raw: string | undefined;
      try {
        const info = lstatSync(file);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.size > 8192 ||
          (process.platform !== "win32" &&
            ((info.mode & 0o077) !== 0 ||
              (typeof process.getuid === "function" && info.uid !== process.getuid())))
        )
          throw new Error("Request key is not a private bounded regular file");
        const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const opened = fstatSync(fd);
          if (
            !opened.isFile() ||
            opened.size > 8192 ||
            opened.ino !== info.ino ||
            opened.dev !== info.dev ||
            (process.platform !== "win32" && (opened.mode & 0o077) !== 0)
          )
            throw new Error("Request key changed during read");
          raw = readFileSync(fd, "utf8");
          // Retry an earlier interrupted sync too; existence alone is not
          // evidence that the first key publication reached stable storage.
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (raw !== undefined) {
        syncDirectoryAncestors(this.options.directory);
        record = JSON.parse(raw) as KeyRecord;
        if (
          !record ||
          record.version !== 1 ||
          record.ownerDigest !== ownerDigest ||
          typeof record.keyId !== "string" ||
          !uuid.test(record.keyId) ||
          record.custodyMode !== this.options.custodyMode ||
          typeof record.protectedKey !== "string"
        )
          throw new Error("Request key ownership or custody mismatch");
      } else {
        const key = randomBytes(32);
        let protectedKey: string;
        try {
          protectedKey = this.options.cipher.encrypt(key.toString("base64"));
        } finally {
          key.fill(0);
        }
        if (this.options.custodyMode === "host-encrypted" && !protectedKey.startsWith("enc:"))
          throw new Error("Request key custody requires encryption");
        if (
          this.options.custodyMode === "owner-only-plaintext" &&
          !protectedKey.startsWith("plain:")
        )
          throw new Error("Request key custody mode does not match its cipher");
        record = {
          version: 1,
          ownerDigest,
          keyId: randomUUID(),
          custodyMode: this.options.custodyMode,
          protectedKey,
        };
        writeFileAtomic(file, canonicalJson(record), 0o600);
        const committed = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          fsyncSync(committed);
        } finally {
          closeSync(committed);
        }
        syncDirectoryAncestors(this.options.directory);
      }
      if (record.custodyMode === "host-encrypted" && !record.protectedKey.startsWith("enc:"))
        throw new Error("Request key encryption is unavailable");
      const secret = this.options.cipher.decrypt(record.protectedKey);
      if (!/^[A-Za-z0-9+/]{43}=$/.test(secret)) throw new Error("Invalid request key material");
      return { record, key: Buffer.from(secret, "base64") };
    } finally {
      release();
    }
  }
}
