// packages/desktop/src/main/automationMemory.ts
/**
 * 任务级跨运行记忆:每个 automation 任务一份 memory.md
 * (~/.code-shell/automations/<jobId>/memory.md)。跑前读、跑完追加。
 * 独立于项目主记忆,不污染。baseDir 可注入(测试用)。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { acquireFileLock } from "@cjhyy/code-shell-core/internal";

const BASE = path.join(os.homedir(), ".code-shell", "automations");
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;
const MAX_MEMORY_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 256 * 1024;

function memFile(jobId: string, baseDir: string): string | null {
  if (!SAFE_ID.test(jobId) || jobId === "." || jobId === "..") return null;
  return path.join(baseDir, jobId, "memory.md");
}

export function readAutomationMemory(jobId: string, baseDir: string = BASE): string {
  const f = memFile(jobId, baseDir);
  if (!f) return "";
  let fd: number | undefined;
  try {
    const jobDir = path.dirname(f);
    const jobInfo = fs.lstatSync(jobDir);
    if (jobInfo.isSymbolicLink() || !jobInfo.isDirectory()) return "";
    fd = fs.openSync(f, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const info = fs.fstatSync(fd);
    if (!info.isFile()) return "";
    const length = Math.min(info.size, MAX_MEMORY_BYTES);
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, Math.max(0, info.size - length));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    if ((e as NodeJS.ErrnoException).code === "ELOOP") return "";
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function appendAutomationMemory(jobId: string, summary: string, baseDir: string = BASE): void {
  const f = memFile(jobId, baseDir);
  if (!f) return;
  const entry = `${summary.trim()}\n\n`;
  if (Buffer.byteLength(entry, "utf8") > MAX_SUMMARY_BYTES) {
    throw new Error(`automation memory summary exceeds ${MAX_SUMMARY_BYTES} bytes`);
  }
  assertSafeMemoryTarget(f);
  const release = acquireFileLock(f);
  try {
    assertSafeMemoryTarget(f);
    const current = readAutomationMemory(jobId, baseDir);
    const combined = Buffer.from(`${current}${entry}`, "utf8");
    const bounded =
      combined.byteLength <= MAX_MEMORY_BYTES
        ? combined
        : combined.subarray(combined.byteLength - MAX_MEMORY_BYTES);
    const decoded = bounded.toString("utf8");
    writeMemoryAtomic(f, decoded.startsWith("\uFFFD") ? decoded.slice(1) : decoded);
  } finally {
    release();
  }
}

function writeMemoryAtomic(file: string, contents: string): void {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function assertSafeMemoryTarget(file: string): void {
  const baseDir = path.dirname(path.dirname(file));
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const baseInfo = fs.lstatSync(baseDir);
  if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) {
    throw new Error("automation memory root must be a real directory");
  }

  const jobDir = path.dirname(file);
  fs.mkdirSync(jobDir, { recursive: true, mode: 0o700 });
  const jobInfo = fs.lstatSync(jobDir);
  if (jobInfo.isSymbolicLink() || !jobInfo.isDirectory()) {
    throw new Error("automation memory job path must be a real directory");
  }
  try {
    const fileInfo = fs.lstatSync(file);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) {
      throw new Error("automation memory target must be a regular file");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
