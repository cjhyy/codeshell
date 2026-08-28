import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
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

async function readDocument(file: string): Promise<ApprovalDocument> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_STORE_BYTES) {
      throw new Error("Panel process approval store must be a bounded regular file");
    }
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_STORE_BYTES) {
      throw new Error("Panel process approval store must be a bounded regular file");
    }
    return parseDocument(JSON.parse(await handle.readFile("utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSafeParent(file: string): Promise<void> {
  const parent = dirname(file);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const entry = await lstat(parent);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Panel process approval directory must be a real directory");
  }
}

async function writeDocument(file: string, document: ApprovalDocument): Promise<void> {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
    throw new Error("Panel process approval store is too large");
  }
  await assertSafeParent(file);
  try {
    const entry = await lstat(file);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error("Panel process approval store target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, file);
    if (process.platform !== "win32") await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
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
      return (await readDocument(this.file)).approvals.some(
        (approval) => approvalKey(approval) === key,
      );
    } catch {
      return false;
    }
  }

  remember(scope: PanelProcessApprovalScope): Promise<void> {
    if (!validScope(scope)) throw new Error("invalid Panel process approval scope");
    const mutation = this.mutationQueue.then(async () => {
      await assertSafeParent(this.file);
      const release = acquireFileLock(this.file);
      try {
        let document: ApprovalDocument;
        try {
          document = await readDocument(this.file);
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
        await writeDocument(this.file, {
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
