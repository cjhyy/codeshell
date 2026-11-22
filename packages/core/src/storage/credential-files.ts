import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  acquireFileLock,
  acquireLockOnPath,
  mutateJsonFile,
  readBoundedJsonFile,
  writeFileAtomic,
} from "../utils/file-mutex.js";
import { retirementCount } from "./credential-file-records.js";
import type { CredentialStoreFile } from "../credentials/types.js";

export const credentialCommands = [
  "credentials/read",
  "credentials/commit",
  "credentials/pendingRetirements",
] as const;
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
function parseFile(raw: string | undefined): CredentialStoreFile {
  try {
    return raw === undefined ? { version: 1, credentials: [] } : checkedFile(JSON.parse(raw));
  } catch {
    throw new Error("Invalid credential store");
  }
}
function image(raw: string | undefined): CredentialFileSnapshot {
  return { file: parseFile(raw), revision: revisionOf(raw) };
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
): CredentialFileSnapshot | boolean | number {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid credential request");
  const p = input as Partial<CredentialFileAddress> & {
    expectedRevision?: unknown;
    file?: unknown;
    projectGuard?: { cwd?: unknown; revision?: unknown };
  };
  const counting = command === "credentials/pendingRetirements";
  const allowed = counting
    ? []
    : command === "credentials/read"
      ? ["scope", "cwd"]
      : ["scope", "cwd", "expectedRevision", "file", "projectGuard"];
  if (Object.keys(p).some((k) => !allowed.includes(k)))
    throw new Error("Invalid credential request");
  const base = credentialDirectory(userDir, counting ? { scope: "user" } : p);
  const path = join(base, "credentials.json");
  function read(raw: string | undefined) {
    const result = counting ? retirementCount(parseFile(raw).credentials) : image(raw);
    assertPermit(permit);
    return result;
  }
  const readOnly = counting || command === "credentials/read";
  if (readOnly && !checkCredentialDirectory(base)) return read(undefined);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  checkCredentialDirectory(base);
  if (readOnly)
    return mutateJsonFile<string | undefined, number | CredentialFileSnapshot>(path, {
      maxBytes,
      parse: (raw) => raw,
      serialize: (raw) => raw!,
      mutation: (raw) => ({ result: read(raw) }),
    })!;
  if (
    command !== "credentials/commit" ||
    typeof p.expectedRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(p.expectedRevision)
  )
    throw new Error("Invalid credential commit");
  const file = checkedFile(p.file);
  const serialized = JSON.stringify(file, null, 2) + "\n";
  if (p.projectGuard !== undefined) {
    const guard = p.projectGuard;
    if (
      p.scope !== "user" ||
      !guard ||
      typeof guard !== "object" ||
      Object.keys(guard).some((k) => k !== "cwd" && k !== "revision") ||
      typeof guard.cwd !== "string" ||
      typeof guard.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(guard.revision)
    )
      throw new Error("Invalid credential project revision");
    const project = credentialDirectory(userDir, { scope: "project", cwd: guard.cwd });
    // The project file may not exist yet. Its directory lock also excludes the
    // first writer of a project shadow; never recreate a deleted workspace.
    if (!checkCredentialDirectory(project)) {
      try {
        mkdirSync(project, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      checkCredentialDirectory(project);
    }
    if (Buffer.byteLength(serialized) > maxBytes) throw Error("Credential store is too large");
    return withUserRevisionLock(
      base,
      project,
      { user: p.expectedRevision, project: guard.revision },
      (current) => {
        const releaseProject = acquireLockOnPath(project);
        try {
          if (!current()) return false;
          assertPermit(permit);
          writeFileAtomic(path, serialized, 0o600);
          return true;
        } finally {
          releaseProject();
        }
      },
    );
  }
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
  return withUserRevisionLock(user, project, expected, write);
}

/** The caller takes the project directory lock inside write. Both credential
 * commits and profile adoption always acquire user first, or one lock for aliases. */
function withUserRevisionLock<T>(
  user: string,
  project: string,
  expected: ProfileCredentialRevisions,
  write: (areCurrent: () => boolean) => T,
): T {
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
