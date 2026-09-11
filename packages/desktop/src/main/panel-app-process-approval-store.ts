import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";

const STORE_VERSION = 1;
const MAX_APPROVALS = 512;
const MAX_STORE_BYTES = 512 * 1024;
const MAX_APP_ID_LENGTH = 128;
const MAX_REVISION_LENGTH = 256;
const MAX_EXECUTABLE_PATH_LENGTH = 32_768;
const FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

export interface PanelProcessApprovalScope {
  appId: string;
  revision: string;
  executablePath: string;
  executableFingerprint: string;
}

interface StoredApproval extends PanelProcessApprovalScope {
  approvedAt: number;
}

interface ApprovalDocument {
  version: 1;
  approvals: StoredApproval[];
}

function validBoundedString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !value.includes("\0")
  );
}

function validScope(value: unknown): value is PanelProcessApprovalScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Partial<PanelProcessApprovalScope>;
  return (
    validBoundedString(scope.appId, MAX_APP_ID_LENGTH) &&
    validBoundedString(scope.revision, MAX_REVISION_LENGTH) &&
    validBoundedString(scope.executablePath, MAX_EXECUTABLE_PATH_LENGTH) &&
    isAbsolute(scope.executablePath) &&
    typeof scope.executableFingerprint === "string" &&
    FINGERPRINT_PATTERN.test(scope.executableFingerprint)
  );
}

function approvalKey(scope: PanelProcessApprovalScope): string {
  return createHash("sha256")
    .update(scope.appId)
    .update("\0")
    .update(scope.revision)
    .update("\0")
    .update(scope.executablePath)
    .update("\0")
    .update(scope.executableFingerprint)
    .digest("hex");
}

function emptyDocument(): ApprovalDocument {
  return { version: STORE_VERSION, approvals: [] };
}

function parseDocument(value: unknown): ApprovalDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Panel process approval store root must be an object");
  }
  const document = value as { version?: unknown; approvals?: unknown };
  if (document.version !== STORE_VERSION || !Array.isArray(document.approvals)) {
    throw new Error("Panel process approval store has an unsupported schema");
  }
  if (document.approvals.length > MAX_APPROVALS) {
    throw new Error("Panel process approval store is too large");
  }
  const approvals: StoredApproval[] = [];
  const keys = new Set<string>();
  for (const value of document.approvals) {
    if (!validScope(value))
      throw new Error("Panel process approval store contains an invalid scope");
    const approvedAt = (value as { approvedAt?: unknown }).approvedAt;
    if (typeof approvedAt !== "number" || !Number.isSafeInteger(approvedAt) || approvedAt <= 0) {
      throw new Error("Panel process approval store contains an invalid timestamp");
    }
    const approval = { ...value, approvedAt } as StoredApproval;
    const key = approvalKey(approval);
    if (keys.has(key)) continue;
    keys.add(key);
    approvals.push(approval);
  }
  return { version: STORE_VERSION, approvals };
}

function readDocument(file: string): ApprovalDocument {
  let descriptor: number | undefined;
  try {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_STORE_BYTES) {
      throw new Error("Panel process approval store must be a bounded regular file");
    }
    descriptor = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.size > MAX_STORE_BYTES) {
      throw new Error("Panel process approval store must be a bounded regular file");
    }
    return parseDocument(JSON.parse(readFileSync(descriptor, "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original read/validation outcome.
      }
    }
  }
}

function assertSafeParent(file: string): void {
  const parent = dirname(file);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const entry = lstatSync(parent);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Panel process approval directory must be a real directory");
  }
}

function writeDocument(file: string, document: ApprovalDocument): void {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
    throw new Error("Panel process approval store is too large");
  }
  assertSafeParent(file);
  try {
    const entry = lstatSync(file);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("Panel process approval store target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, file);
    if (process.platform !== "win32") chmodSync(file, 0o600);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // Temporary cleanup must not replace the write outcome.
    }
  }
}

export class PanelAppProcessApprovalStore {
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async has(scope: PanelProcessApprovalScope): Promise<boolean> {
    if (!validScope(scope)) return false;
    await this.mutationQueue.catch(() => undefined);
    try {
      const key = approvalKey(scope);
      return readDocument(this.file).approvals.some(
        (approval) => approvalKey(approval) === key,
      );
    } catch {
      return false;
    }
  }

  remember(scope: PanelProcessApprovalScope): Promise<void> {
    if (!validScope(scope)) throw new Error("invalid Panel process approval scope");
    const mutation = this.mutationQueue.then(() => {
      assertSafeParent(this.file);
      const release = acquireFileLock(this.file);
      try {
        // A second store can contend on this directory in the same process.
        // Never yield while holding its synchronous cross-process lock.
        let document: ApprovalDocument;
        try {
          document = readDocument(this.file);
        } catch {
          document = emptyDocument();
        }
        const key = approvalKey(scope);
        const approvals = document.approvals.filter(
          (approval) =>
            approvalKey(approval) !== key &&
            !(approval.appId === scope.appId && approval.revision !== scope.revision),
        );
        approvals.unshift({ ...scope, approvedAt: Date.now() });
        writeDocument(this.file, {
          version: STORE_VERSION,
          approvals: approvals.slice(0, MAX_APPROVALS),
        });
      } finally {
        release();
      }
    });
    this.mutationQueue = mutation.catch(() => undefined);
    return mutation;
  }
}
