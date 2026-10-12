import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface TranscriptCheckpoint {
  version: 1;
  roomId: string;
  cwd: string;
  sessionId: string;
  kind: "claude-code" | "codex";
  file: string;
  identity: string;
  sourceId: string;
  /** Last durably ingested complete newline, never the partial writer tail. */
  offset: number;
  digest: string;
  roomCursor: number;
  status: "committed" | "pending" | "failed";
  reason?: string;
}

/** Owned Host state. The external CLI transcript is always opened read-only. */
export class TranscriptCheckpointStore {
  private readonly identity: string;
  private readonly realPath: string;
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("invalid transcript checkpoint root");
    this.identity = `${stat.dev}:${stat.ino}`;
    this.realPath = realpathSync(directory);
    this.syncDirectory();
    if (process.platform !== "win32") {
      const fd = openSync(dirname(directory), "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  private path(roomId: string): string {
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      `${stat.dev}:${stat.ino}` !== this.identity ||
      realpathSync(this.directory) !== this.realPath
    )
      throw new Error("transcript checkpoint root changed");
    return join(this.directory, `${createHash("sha256").update(roomId).digest("hex")}.json`);
  }
  private syncDirectory(): void {
    if (process.platform === "win32") return;
    const fd = openSync(this.directory, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  load(roomId: string): TranscriptCheckpoint | undefined {
    const path = this.path(roomId);
    if (!existsSync(path)) return undefined;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384)
      throw new Error("invalid transcript checkpoint file");
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let value: TranscriptCheckpoint;
    try {
      const opened = fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino)
        throw new Error("transcript checkpoint changed while opening");
      if (!opened.isFile() || opened.nlink !== 1 || opened.size > 16384)
        throw new Error("invalid transcript checkpoint file");
      const buffer = Buffer.allocUnsafe(16385);
      let total = 0;
      while (total < buffer.length) {
        const count = readSync(fd, buffer, total, buffer.length - total, total);
        if (!count) break;
        total += count;
      }
      const after = fstatSync(fd);
      const pathStat = lstatSync(path);
      if (
        total > 16384 ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        !pathStat.isFile() ||
        pathStat.isSymbolicLink() ||
        pathStat.nlink !== 1 ||
        pathStat.dev !== opened.dev ||
        pathStat.ino !== opened.ino ||
        pathStat.size !== opened.size ||
        pathStat.mtimeMs !== opened.mtimeMs ||
        pathStat.ctimeMs !== opened.ctimeMs
      )
        throw new Error("transcript checkpoint changed while reading");
      this.path(roomId);
      value = JSON.parse(buffer.subarray(0, total).toString("utf8"));
    } finally {
      closeSync(fd);
    }
    if (
      value?.version !== 1 ||
      value.roomId !== roomId ||
      typeof value.cwd !== "string" ||
      typeof value.sessionId !== "string" ||
      (value.kind !== "codex" && value.kind !== "claude-code") ||
      typeof value.file !== "string" ||
      typeof value.identity !== "string" ||
      !/^[0-9a-f-]{36}$/.test(value.sourceId) ||
      !/^[0-9a-f]{64}$/.test(value.digest) ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 0 ||
      !Number.isSafeInteger(value.roomCursor) ||
      value.roomCursor < 0 ||
      !["committed", "pending", "failed"].includes(value.status)
    )
      throw new Error("invalid transcript checkpoint");
    return value;
  }
  save(value: TranscriptCheckpoint): void {
    const target = this.path(value.roomId);
    if (existsSync(target)) {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
        throw new Error("invalid transcript checkpoint target");
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    let created = false;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      created = true;
      const data = Buffer.from(JSON.stringify(value));
      if (data.length > 16384) throw new Error("transcript checkpoint exceeds limit");
      let written = 0;
      while (written < data.length) {
        const count = writeSync(fd, data, written, data.length - written);
        if (!count) throw new Error("transcript checkpoint write made no progress");
        written += count;
      }
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      this.path(value.roomId);
      renameSync(temp, target);
      this.syncDirectory();
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (created) rmSync(temp, { force: true });
    }
  }
}
