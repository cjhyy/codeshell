import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { mutateJsonFile } from "../utils/file-mutex.js";
import type { CredentialStoreFile } from "../credentials/types.js";

export const credentialCommands = ["credentials/read", "credentials/commit"] as const;
export type CredentialFileCommand = (typeof credentialCommands)[number];
export interface CredentialFileAddress {
  scope: "user" | "project";
  cwd?: string;
}
export interface CredentialFileSnapshot {
  revision: string;
  file: CredentialStoreFile;
}

const maxBytes = 32 * 1024 * 1024;
function checkedFile(value: unknown): CredentialStoreFile {
  const file = value as CredentialStoreFile;
  if (
    !file ||
    typeof file !== "object" ||
    file.version !== 1 ||
    !Array.isArray(file.credentials) ||
    file.credentials.length > 4096
  )
    throw new Error("Invalid credential store");
  return file;
}
function image(raw: string | undefined): CredentialFileSnapshot {
  let file: CredentialStoreFile;
  try {
    file = raw === undefined ? { version: 1, credentials: [] } : checkedFile(JSON.parse(raw));
  } catch {
    throw new Error("Invalid credential store");
  }
  const revision = createHash("sha256")
    .update(raw === undefined ? "missing" : "file:" + raw)
    .digest("hex");
  return { file, revision };
}
function assertPermit(value: unknown): void {
  if (
    value !== undefined &&
    (!(value instanceof Int32Array) ||
      !(value.buffer instanceof SharedArrayBuffer) ||
      value.length !== 1 ||
      Atomics.compareExchange(value, 0, 0, 1) !== 0)
  )
    throw new Error("Credential caller was revoked");
}

/** Trusted storage-worker domain. A scope selects one fixed file, never a
 * renderer-controlled filename. The write lock covers only CAS and rename. */
export function credentialFileCommand(
  userDir: string | undefined,
  command: CredentialFileCommand,
  input: unknown,
  permit?: unknown,
): CredentialFileSnapshot | boolean {
  if (!input || typeof input !== "object") throw new Error("Invalid credential request");
  const p = input as Partial<CredentialFileAddress> & {
    expectedRevision?: unknown;
    file?: unknown;
  };
  const allowed =
    command === "credentials/read"
      ? ["scope", "cwd"]
      : ["scope", "cwd", "expectedRevision", "file"];
  if (Object.keys(p).some((k) => !allowed.includes(k)))
    throw new Error("Invalid credential request");
  let base: string;
  if (p.scope === "user" && p.cwd === undefined)
    base = userDir ?? join(process.env.HOME ?? homedir(), ".code-shell");
  else if (
    p.scope === "project" &&
    typeof p.cwd === "string" &&
    isAbsolute(p.cwd) &&
    !p.cwd.includes("\0")
  )
    base = join(p.cwd, ".code-shell");
  else throw new Error("Invalid credential scope");
  const path = join(base, "credentials.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const parent = lstatSync(dirname(path));
  if (parent.isSymbolicLink() || !parent.isDirectory())
    throw new Error("Credential parent must be a real directory");
  if (command === "credentials/read")
    return mutateJsonFile<string | undefined, CredentialFileSnapshot>(path, {
      maxBytes,
      parse: (raw) => raw,
      serialize: (raw) => raw!,
      mutation: (raw) => {
        assertPermit(permit);
        return { result: image(raw) };
      },
    })!;
  if (
    command !== "credentials/commit" ||
    typeof p.expectedRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.expectedRevision)
  )
    throw new Error("Invalid credential commit");
  const file = checkedFile(p.file);
  const serialized = JSON.stringify(file, null, 2) + "\n";
  return mutateJsonFile<string | undefined, boolean>(path, {
    maxBytes,
    mode: 0o600,
    parse: (raw) => raw,
    serialize: (raw) => raw!,
    mutation: (raw) => {
      if (image(raw).revision !== p.expectedRevision) return { result: false };
      assertPermit(permit);
      return { value: serialized, result: true };
    },
  })!;
}
