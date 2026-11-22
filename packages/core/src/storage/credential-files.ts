import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { acquireFileLock, mutateJsonFile, readBoundedJsonFile } from "../utils/file-mutex.js";
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
function revisionOf(raw: string | undefined): string {
  return createHash("sha256")
    .update(raw === undefined ? "missing" : "file:" + raw)
    .digest("hex");
}
function image(raw: string | undefined): CredentialFileSnapshot {
  let file: CredentialStoreFile;
  try {
    file = raw === undefined ? { version: 1, credentials: [] } : checkedFile(JSON.parse(raw));
  } catch {
    throw new Error("Invalid credential store");
  }
  return { file, revision: revisionOf(raw) };
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
  const base = credentialDirectory(userDir, p);
  const path = join(base, "credentials.json");
  if (command === "credentials/read" && !checkCredentialDirectory(base)) {
    assertPermit(permit);
    return image(undefined);
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  checkCredentialDirectory(base);
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

function credentialDirectory(
  userDir: string | undefined,
  p: Partial<CredentialFileAddress>,
): string {
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
  return base;
}
function checkCredentialDirectory(base: string) {
  const parent = lstatSync(base, { bigint: true, throwIfNoEntry: false });
  if (parent && (parent.isSymbolicLink() || !parent.isDirectory()))
    throw Error("Credential parent must be a real directory");
  return parent;
}

export type ProfileCredentialRevisions = Record<"user" | "project", string>;
/** Profile adoption already owns the project settings directory lock in its mutation.
 * Taking the user directory first pins both credential layers through the settings rename. */
export function withProfileCredentialRevisions<T>(
  cwd: string,
  expected: ProfileCredentialRevisions,
  write: (areCurrent: () => boolean) => T,
): T {
  const user = credentialDirectory(undefined, { scope: "user" });
  const project = credentialDirectory(undefined, { scope: "project", cwd });
  mkdirSync(user, { recursive: true, mode: 0o700 });
  const userInfo = checkCredentialDirectory(user)!;
  const projectInfo = checkCredentialDirectory(project);
  const sameDirectory =
    projectInfo && projectInfo.dev === userInfo.dev && projectInfo.ino === userInfo.ino;
  const release = sameDirectory ? undefined : acquireFileLock(join(user, "credentials.json"));
  try {
    return write(() => {
      checkCredentialDirectory(user);
      checkCredentialDirectory(project);
      return (
        revisionOf(readBoundedJsonFile(join(user, "credentials.json"), maxBytes)) ===
          expected.user &&
        revisionOf(readBoundedJsonFile(join(project, "credentials.json"), maxBytes)) ===
          expected.project
      );
    });
  } finally {
    release?.();
  }
}
