import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/file-mutex.js";

// A legal create_issue plan repeats its 20,000-character body in parameters
// and postcondition. JSON escaping may use six bytes per UTF-16 code unit.
// Reserve 512 KiB for that bounded plan plus its authority snapshot, and a
// separately bounded envelope that includes base64 expansion and metadata.
const MAX_PLAINTEXT_BYTES = 512 * 1024;
const MAX_BYTES = 704 * 1024;
const hexDigest = /^[a-f0-9]{64}$/;

/**
 * Private, authenticated recovery inputs. Only a digest enters the ordinary
 * operation receipt; account metadata and request bodies remain encrypted here.
 * The Host cipher protects the ledger root key. This derived key also encrypts
 * payloads for SDK hosts whose root-key cipher is explicitly plaintext.
 * Same-user filesystem access is not an OS security boundary.
 *
 * All callers hold the ledger's short synchronous directory lock. These files
 * are immutable and content-addressed, so no second lock or async work is needed.
 */
export class OperationRecoveryFiles {
  constructor(private readonly ledgerDirectory: string) {}

  private directory(id: string, create = false): string {
    if (!hexDigest.test(id)) throw new Error("Invalid recovery identity");
    const root = join(this.ledgerDirectory, "recovery");
    const directory = join(root, id);
    for (const path of [root, directory]) {
      if (create) {
        try {
          mkdirSync(path, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Invalid recovery directory");
    }
    return directory;
  }

  private encryptionKey(rootKey: Buffer): Buffer {
    return createHmac("sha256", rootKey).update("operation-recovery-encryption-v1").digest();
  }

  private digest(rootKey: Buffer, id: string, plaintext: string): string {
    return createHmac("sha256", rootKey)
      .update(JSON.stringify(["operation-recovery-v1", id, plaintext]))
      .digest("hex");
  }

  save(rootKey: Buffer, id: string, plaintext: string): string {
    if (Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES)
      throw new Error("Recovery input exceeds bounds");
    const digest = this.digest(rootKey, id, plaintext);
    const directory = this.directory(id, true);
    const file = join(directory, `${digest}.json`);
    try {
      if (lstatSync(file)) {
        if (this.read(rootKey, id, digest) !== plaintext)
          throw new Error("Recovery input conflicts with its immutable identity");
        return digest;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // One pre-send snapshot and one original read identity. Never accumulate
    // arbitrary revised payloads or retry histories in this private store.
    if (readdirSync(directory).length >= 2) throw new Error("Recovery input slots are full");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey(rootKey), iv);
    cipher.setAAD(Buffer.from(JSON.stringify([id, digest])));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    writeFileAtomic(
      file,
      JSON.stringify({
        schema: 1,
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      }),
      0o600,
    );
    return digest;
  }

  read(rootKey: Buffer, id: string, digest: string): string {
    if (!hexDigest.test(digest)) throw new Error("Invalid recovery digest");
    const file = join(this.directory(id), `${digest}.json`);
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Recovery input exceeds bounds");
      const envelope = JSON.parse(readFileSync(fd, "utf8"));
      if (
        !envelope ||
        Object.keys(envelope).sort().join(",") !== "ciphertext,iv,schema,tag" ||
        envelope.schema !== 1 ||
        ![envelope.iv, envelope.tag, envelope.ciphertext].every(
          (value) => typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value),
        )
      )
        throw new Error("Invalid recovery input");
      const iv = Buffer.from(envelope.iv, "base64");
      const tag = Buffer.from(envelope.tag, "base64");
      if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid recovery input");
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey(rootKey), iv);
      decipher.setAAD(Buffer.from(JSON.stringify([id, digest])));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64")),
        decipher.final(),
      ]).toString("utf8");
      if (
        Buffer.byteLength(plaintext) > MAX_PLAINTEXT_BYTES ||
        this.digest(rootKey, id, plaintext) !== digest
      )
        throw new Error("Recovery input authentication failed");
      return plaintext;
    } finally {
      closeSync(fd);
    }
  }
}
