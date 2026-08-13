/**
 * FileRunStore — local filesystem implementation of RunStore.
 *
 * Layout:
 *   ~/.code-shell/runs/<runId>/
 *     run.json              — current snapshot
 *     events.jsonl          — append-only event log
 *     checkpoints/<id>.json — structured checkpoints
 *     approvals/<id>.json   — approval records
 *     artifacts/refs.jsonl  — artifact reference log
 */

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  closeSync,
  chmodSync,
  constants,
  fchmodSync,
  readdirSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { RunStore } from "./RunStore.js";
import { assertSafeRunFileId, assertSafeRunId } from "./ids.js";
import type {
  RunSnapshot,
  RunEvent,
  RunCheckpoint,
  RunApproval,
  RunArtifactRef,
  ListRunsQuery,
} from "./types.js";

const MAX_RUN_JSON_BYTES = 8 * 1024 * 1024;
const MAX_RUN_JSONL_BYTES = 128 * 1024 * 1024;
const MAX_RUN_JSONL_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_RUN_DIRECTORIES = 100_000;
const MAX_RUN_CHILD_FILES = 100_000;

export class FileRunStore implements RunStore {
  private readonly runsDir: string;

  constructor(storageDir?: string) {
    this.runsDir = storageDir ?? join(homedir(), ".code-shell", "runs");
    mkdirSync(this.runsDir, { recursive: true, mode: 0o700 });
    this.assertRealDirectory(this.runsDir);
    if (process.platform !== "win32") chmodSync(this.runsDir, 0o700);
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private runDir(runId: string): string {
    assertSafeRunId(runId);
    const dir = join(this.runsDir, runId);
    if (existsSync(dir)) this.assertRealDirectory(dir);
    return dir;
  }

  private ensureRunDir(runId: string): string {
    const dir = this.runDir(runId);
    const directories = [dir, join(dir, "checkpoints"), join(dir, "approvals"), join(dir, "artifacts")];
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.assertRealDirectory(directory);
      if (process.platform !== "win32") chmodSync(directory, 0o700);
    }
    return dir;
  }

  private writeJson(filePath: string, data: unknown): void {
    this.assertRealDirectory(dirname(filePath));
    this.assertSafeFileTarget(filePath);
    const serialized = JSON.stringify(data, null, 2);
    if (Buffer.byteLength(serialized, "utf8") > MAX_RUN_JSON_BYTES) {
      throw new Error(`Run JSON exceeds ${MAX_RUN_JSON_BYTES} bytes`);
    }
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, serialized, { encoding: "utf-8", mode: 0o600, flag: "wx" });
      // Atomic rename — prevents partial writes on crash
      renameSync(tmp, filePath);
    } catch (err) {
      // Don't leave a dangling .tmp behind on a failed write/rename.
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  private readJson<T>(filePath: string): T | null {
    if (!existsSync(filePath)) return null;
    this.assertRealDirectory(dirname(filePath));
    let fd: number | undefined;
    try {
      const entry = lstatSync(filePath);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_RUN_JSON_BYTES) {
        throw new Error(`Run JSON is not a bounded regular file: ${filePath}`);
      }
      fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_RUN_JSON_BYTES) {
        throw new Error(`Run JSON is not a bounded regular file: ${filePath}`);
      }
      return JSON.parse(readFileSync(fd, "utf-8")) as T;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  private assertRealDirectory(directory: string): void {
    const info = lstatSync(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Run storage path is not a real directory: ${directory}`);
    }
  }

  private assertSafeFileTarget(filePath: string): void {
    try {
      const info = lstatSync(filePath);
      if (info.isSymbolicLink() || !info.isFile()) {
        throw new Error(`Run storage target is not a regular file: ${filePath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  /** Serializes concurrent JSONL appends per file path. */
  private readonly appendLocks = new Map<string, Promise<void>>();

  private async appendJsonl(filePath: string, data: unknown): Promise<void> {
    // Serialize writes to the same file to prevent interleaved output. The
    // chain we STORE as the lock must never reject — otherwise a single failed
    // write poisons the lock and every later write chains off the rejected
    // promise, skips its callback, and fails forever. So sequence off the
    // previous lock's settlement (.catch(()=>{})), do the write, and surface
    // this write's own error to *this* caller via a separate promise.
    const prev = this.appendLocks.get(filePath) ?? Promise.resolve();
    let settle!: () => void;
    const lock = new Promise<void>((resolve) => {
      settle = resolve;
    });
    this.appendLocks.set(filePath, lock);

    try {
      await prev.catch(() => {});
      this.assertRealDirectory(dirname(filePath));
      this.assertSafeFileTarget(filePath);
      const record = JSON.stringify(data);
      if (Buffer.byteLength(record, "utf8") > MAX_RUN_JSONL_RECORD_BYTES) {
        throw new Error(`Run JSONL record exceeds ${MAX_RUN_JSONL_RECORD_BYTES} bytes`);
      }
      // A process crash can leave a partial final JSONL record. Without a
      // separator, the first append after restart would concatenate a valid
      // record onto that fragment and lose both records. Inspect and repair
      // the boundary through the same append-mode descriptor used to write.
      const fd = openSync(
        filePath,
        constants.O_APPEND |
          constants.O_CREAT |
          constants.O_RDWR |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        if (process.platform !== "win32") fchmodSync(fd, 0o600);
        const size = fstatSync(fd).size;
        if (size + Buffer.byteLength(record, "utf8") + 2 > MAX_RUN_JSONL_BYTES) {
          throw new Error(`Run JSONL exceeds ${MAX_RUN_JSONL_BYTES} bytes`);
        }
        let prefix = "";
        if (size > 0) {
          const lastByte = Buffer.allocUnsafe(1);
          readSync(fd, lastByte, 0, 1, size - 1);
          if (lastByte[0] !== 0x0a) prefix = "\n";
        }
        appendFileSync(fd, prefix + record + "\n", "utf-8");
      } finally {
        closeSync(fd);
      }
    } finally {
      // Release the lock for the next writer regardless of success/failure,
      // and drop the map entry if no newer writer has queued behind us.
      settle();
      if (this.appendLocks.get(filePath) === lock) {
        this.appendLocks.delete(filePath);
      }
    }
  }

  private readJsonl<T>(filePath: string): T[] {
    if (!existsSync(filePath)) return [];
    this.assertRealDirectory(dirname(filePath));
    let fd: number | undefined;
    let content: string;
    try {
      const entry = lstatSync(filePath);
      if (entry.isSymbolicLink() || !entry.isFile() || entry.size > MAX_RUN_JSONL_BYTES) {
        throw new Error(`Run JSONL is not a bounded regular file: ${filePath}`);
      }
      fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.size > MAX_RUN_JSONL_BYTES) {
        throw new Error(`Run JSONL is not a bounded regular file: ${filePath}`);
      }
      content = readFileSync(fd, "utf-8");
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    if (!content) return [];
    const records: T[] = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as T);
      } catch {
        // Append-only logs must remain readable after a torn final write. A
        // malformed record is isolated to its line; later valid records still
        // carry useful recovery state (same policy as Transcript.loadFromFile).
      }
    }
    return records;
  }

  // ─── Snapshot ──────────────────────────────────────────────────

  async create(snapshot: RunSnapshot): Promise<void> {
    const dir = this.ensureRunDir(snapshot.runId);
    this.writeJson(join(dir, "run.json"), snapshot);
  }

  async update(snapshot: RunSnapshot): Promise<void> {
    const dir = this.runDir(snapshot.runId);
    if (!existsSync(dir)) {
      throw new Error(`Run not found: ${snapshot.runId}`);
    }
    this.writeJson(join(dir, "run.json"), snapshot);
  }

  async get(runId: string): Promise<RunSnapshot | null> {
    return this.readJson<RunSnapshot>(join(this.runDir(runId), "run.json"));
  }

  async list(query?: ListRunsQuery): Promise<RunSnapshot[]> {
    if (!existsSync(this.runsDir)) return [];

    const entries = readdirSync(this.runsDir, { withFileTypes: true });
    if (entries.length > MAX_RUN_DIRECTORIES) throw new Error("Run registry has too many entries");
    const snapshots: RunSnapshot[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      let snapshot: RunSnapshot | null;
      try {
        snapshot = this.readJson<RunSnapshot>(join(this.runsDir, entry.name, "run.json"));
      } catch (error) {
        // One manually damaged/legacy partial snapshot must not make every
        // healthy run disappear from the history list. Preserve real I/O
        // failures, but isolate JSON corruption to the affected directory.
        if (error instanceof SyntaxError) continue;
        throw error;
      }
      if (!snapshot) continue;

      // Filter by status
      if (query?.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        if (!statuses.includes(snapshot.status)) continue;
      }

      // Filter by tag
      if (query?.tag && (!Array.isArray(snapshot.tags) || !snapshot.tags.includes(query.tag))) {
        continue;
      }

      snapshots.push(snapshot);
    }

    // Sort by createdAt descending (newest first)
    snapshots.sort((a, b) => b.createdAt - a.createdAt);

    // Pagination. Clamp to sane bounds before slicing: a negative offset would
    // make Array.slice count "from the end" and silently return a surprise tail
    // window; a negative limit would drop elements off the end. Both nonsensical
    // for pagination — clamp offset≥0, treat a non-positive limit as an empty page.
    const rawOffset = query?.offset ?? 0;
    const rawLimit = query?.limit ?? 50;
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 0;
    return snapshots.slice(offset, offset + limit);
  }

  async delete(runId: string): Promise<void> {
    const dir = this.runDir(runId);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // ─── Events ────────────────────────────────────────────────────

  async appendEvent(event: RunEvent): Promise<void> {
    this.ensureRunDir(event.runId);
    const dir = this.runDir(event.runId);
    await this.appendJsonl(join(dir, "events.jsonl"), event);
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return this.readJsonl<RunEvent>(join(this.runDir(runId), "events.jsonl"));
  }

  // ─── Checkpoints ───────────────────────────────────────────────

  async saveCheckpoint(cp: RunCheckpoint): Promise<void> {
    assertSafeRunId(cp.runId);
    assertSafeRunFileId(cp.checkpointId, "checkpoint id");
    const dir = this.runDir(cp.runId);
    this.writeJson(join(dir, "checkpoints", `${cp.checkpointId}.json`), cp);
  }

  async getLatestCheckpoint(runId: string): Promise<RunCheckpoint | null> {
    const cpDir = join(this.runDir(runId), "checkpoints");
    if (!existsSync(cpDir)) return null;
    this.assertRealDirectory(cpDir);

    const files = readdirSync(cpDir).filter((f) => f.endsWith(".json"));
    if (files.length > MAX_RUN_CHILD_FILES) throw new Error("Run has too many checkpoints");
    if (files.length === 0) return null;

    // Find the latest by createdAt
    let latest: RunCheckpoint | null = null;
    for (const file of files) {
      const cp = this.readJson<RunCheckpoint>(join(cpDir, file));
      if (cp && (!latest || cp.createdAt > latest.createdAt)) {
        latest = cp;
      }
    }
    return latest;
  }

  // ─── Approvals ─────────────────────────────────────────────────

  async saveApproval(approval: RunApproval): Promise<void> {
    assertSafeRunId(approval.runId);
    assertSafeRunFileId(approval.approvalId, "approval id");
    const dir = this.runDir(approval.runId);
    this.writeJson(
      join(dir, "approvals", `${approval.approvalId}.json`),
      approval,
    );
  }

  async getApproval(runId: string, approvalId: string): Promise<RunApproval | null> {
    assertSafeRunId(runId);
    assertSafeRunFileId(approvalId, "approval id");
    return this.readJson<RunApproval>(
      join(this.runDir(runId), "approvals", `${approvalId}.json`),
    );
  }

  async getPendingApproval(runId: string): Promise<RunApproval | null> {
    const approvalDir = join(this.runDir(runId), "approvals");
    if (!existsSync(approvalDir)) return null;
    this.assertRealDirectory(approvalDir);

    const files = readdirSync(approvalDir).filter((f) => f.endsWith(".json"));
    if (files.length > MAX_RUN_CHILD_FILES) throw new Error("Run has too many approvals");
    for (const file of files) {
      const approval = this.readJson<RunApproval>(join(approvalDir, file));
      if (approval?.status === "pending") return approval;
    }
    return null;
  }

  // ─── Artifact Refs ─────────────────────────────────────────────

  async appendArtifactRef(ref: RunArtifactRef): Promise<void> {
    this.ensureRunDir(ref.runId);
    const dir = this.runDir(ref.runId);
    await this.appendJsonl(join(dir, "artifacts", "refs.jsonl"), ref);
  }

  async listArtifactRefs(runId: string): Promise<RunArtifactRef[]> {
    return this.readJsonl<RunArtifactRef>(
      join(this.runDir(runId), "artifacts", "refs.jsonl"),
    );
  }
}
