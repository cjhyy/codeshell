import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { lstatSync, opendirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../utils/file-mutex.js";
import { operationDirectory, operationFile, readOperationFile } from "./files.js";

// A legal create_issue plan repeats its 20,000-character body in parameters
// and postcondition. JSON escaping may use six bytes per UTF-16 code unit.
// Reserve 512 KiB for that bounded plan plus its authority snapshot, and a
// separately bounded envelope that includes base64 expansion and metadata.
const MAX_PLAINTEXT_BYTES = 512 * 1024;
export const OPERATION_RECOVERY_MAX_BYTES = 704 * 1024;
const hexDigest = /^[a-f0-9]{64}$/;

export interface OperationRecoverySummary {
  bytes: number;
  slots: { digest: string; bytes: number }[];
}

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
      operationDirectory(path, create);
    }
    return directory;
  }

  /** Real writes under the ledger lock may discard only unpublished atomic staging files. */
  collect(id: string): void {
    let directory: string;
    try {
      directory = this.directory(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return;
    }
    const identity = operationDirectory(directory);
    const garbage: { path: string; info: ReturnType<typeof operationFile> }[] = [];
    let slots = 0;
    const entries = opendirSync(directory);
    try {
      for (;;) {
        const entry = entries.readSync();
        if (!entry) break;
        const path = join(directory, entry.name);
        const info = operationFile(path, OPERATION_RECOVERY_MAX_BYTES);
        if (/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          if (++slots > 2) throw new Error("Invalid operation recovery slots");
        } else if (
          /^[a-f0-9]{64}\.json\.[1-9]\d{0,19}\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(
            entry.name,
          )
        ) {
          if (garbage.length >= 2) throw new Error("Operation recovery staging exceeds bounds");
          garbage.push({ path, info });
        } else throw new Error("Invalid operation recovery staging entry");
      }
    } finally {
      entries.closeSync();
    }
    const after = operationDirectory(directory);
    if (
      identity.dev !== after.dev ||
      identity.ino !== after.ino ||
      identity.mtimeMs !== after.mtimeMs ||
      identity.ctimeMs !== after.ctimeMs
    )
      throw new Error("Operation recovery directory changed while collecting");
    // Validate every entry before removing anything. Canonical encrypted inputs,
    // including unreferenced completed slots, are never removed or promoted.
    for (const { path, info } of garbage) {
      const current = operationFile(path, OPERATION_RECOVERY_MAX_BYTES);
      if (
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.size !== info.size ||
        current.mtimeMs !== info.mtimeMs ||
        current.ctimeMs !== info.ctimeMs
      )
        throw new Error("Operation recovery staging changed while collecting");
    }
    for (const { path } of garbage) rmSync(path);
  }

  /** Includes both legal physical slots, even an unreferenced failed-checkpoint orphan. */
  inspect(rootKey: Buffer, id: string, references: string[] = []): OperationRecoverySummary {
    let directory: string;
    try {
      directory = this.directory(id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || references.length) throw error;
      return { bytes: 0, slots: [] };
    }
    const identity = operationDirectory(directory);
    const slots: OperationRecoverySummary["slots"] = [];
    const entries = opendirSync(directory);
    try {
      for (;;) {
        const entry = entries.readSync();
        if (!entry) break;
        if (slots.length >= 2 || !/^[a-f0-9]{64}\.json$/.test(entry.name))
          throw new Error("Invalid operation recovery slots");
        const digest = entry.name.slice(0, 64);
        const file = join(directory, entry.name);
        const info = operationFile(file, OPERATION_RECOVERY_MAX_BYTES);
        // Authenticate orphans too; their physical size must not escape the quota.
        this.read(rootKey, id, digest);
        const after = operationFile(file, OPERATION_RECOVERY_MAX_BYTES);
        if (
          info.dev !== after.dev ||
          info.ino !== after.ino ||
          info.size !== after.size ||
          info.mtimeMs !== after.mtimeMs ||
          info.ctimeMs !== after.ctimeMs
        )
          throw new Error("Operation recovery changed while accounting");
        slots.push({ digest, bytes: info.size });
      }
    } finally {
      entries.closeSync();
    }
    slots.sort((a, b) => a.digest.localeCompare(b.digest));
    const after = operationDirectory(directory);
    if (
      identity.dev !== after.dev ||
      identity.ino !== after.ino ||
      identity.mtimeMs !== after.mtimeMs ||
      identity.ctimeMs !== after.ctimeMs
    )
      throw new Error("Operation recovery directory changed while accounting");
    if (references.some((digest) => !slots.some((slot) => slot.digest === digest)))
      throw new Error("Original operation recovery input is missing");
    return { bytes: slots.reduce((sum, slot) => sum + slot.bytes, 0), slots };
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
    this.collect(id);
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
    const envelope = JSON.parse(readOperationFile(file, OPERATION_RECOVERY_MAX_BYTES));
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
  }
}
