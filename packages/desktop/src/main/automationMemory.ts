// packages/desktop/src/main/automationMemory.ts
/**
 * 任务级跨运行记忆:每个 automation 任务一份 memory.md
 * (~/.code-shell/automations/<jobId>/memory.md)。跑前读、跑完追加。
 * 独立于项目主记忆,不污染。baseDir 可注入(测试用)。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const BASE = path.join(os.homedir(), ".code-shell", "automations");
const SAFE_ID = /^[A-Za-z0-9_.-]+$/;

function memFile(jobId: string, baseDir: string): string | null {
  if (!SAFE_ID.test(jobId) || jobId === "." || jobId === "..") return null;
  return path.join(baseDir, jobId, "memory.md");
}

export function readAutomationMemory(jobId: string, baseDir: string = BASE): string {
  const f = memFile(jobId, baseDir);
  if (!f) return "";
  try {
    return fs.readFileSync(f, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

export function appendAutomationMemory(jobId: string, summary: string, baseDir: string = BASE): void {
  const f = memFile(jobId, baseDir);
  if (!f) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, summary.trim() + "\n\n", "utf8");
}
