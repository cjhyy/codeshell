// Interactive terminal backend (node-pty). Modeled on Codex's TerminalService:
// main owns the pty, renderer drives it over IPC. One pty per sessionId.
//
// node-pty is a native module; the esbuild `build:main` bundle marks all
// bare requires external and injects a createRequire banner, so we load it
// lazily here (createRequire) the same way Codex does — avoids bundling the
// native addon and keeps it resolvable from node_modules at runtime.
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WebContents } from "electron";
import { dlog } from "./desktop-logger.js";

const require = createRequire(import.meta.url);

interface IPty {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  readonly pid: number;
}

interface NodePty {
  spawn(
    file: string,
    args: string[] | string,
    opts: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): IPty;
}

let nodePty: NodePty | null = null;
function loadPty(): NodePty {
  if (!nodePty) nodePty = require("node-pty") as NodePty;
  return nodePty;
}

let gitBashCache: string | null | undefined;
let powershellCache: string | null | undefined;

function isBashLike(shellPath: string): boolean {
  return /(^|[\\/])(bash|sh)(\.exe)?$/i.test(shellPath);
}

/**
 * Best-effort locate Git for Windows' bash.exe. This is for the interactive
 * desktop terminal only. The Bash and PowerShell execution tools stay separate:
 * Bash should use Git Bash on Windows, while PowerShell commands belong to the
 * dedicated PowerShell tool.
 */
export function resolveGitBashForPty(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (gitBashCache !== undefined) return gitBashCache ?? undefined;

  const override = process.env.CODE_SHELL_GIT_BASH_PATH?.trim();
  if (override && existsSync(override)) return (gitBashCache = override);

  const candidates: string[] = [];
  try {
    const out = execFileSync("where", ["git"], { encoding: "utf8", timeout: 3000 });
    const gitExe = out.split(/\r?\n/).find((line) => line.trim().toLowerCase().endsWith("git.exe"));
    if (gitExe) {
      const gitRoot = dirname(dirname(gitExe.trim()));
      candidates.push(join(gitRoot, "bin", "bash.exe"));
    }
  } catch {
    // Git isn't on PATH, or `where` itself is unavailable. Try default installs.
  }

  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  candidates.push(join(pf, "Git", "bin", "bash.exe"));
  candidates.push(join(pf86, "Git", "bin", "bash.exe"));

  const found = candidates.find((candidate) => existsSync(candidate));
  return (gitBashCache = found ?? null) ?? undefined;
}

function resolvePowerShellForPty(): string | undefined {
  if (process.platform !== "win32") return undefined;
  if (powershellCache !== undefined) return powershellCache ?? undefined;

  const override = process.env.CODE_SHELL_POWERSHELL_PATH?.trim();
  if (override && existsSync(override)) return (powershellCache = override);

  try {
    const out = execFileSync("where", ["powershell.exe"], { encoding: "utf8", timeout: 3000 });
    const found = out.split(/\r?\n/).find((line) => line.trim().toLowerCase().endsWith("powershell.exe"));
    if (found) return (powershellCache = found.trim());
  } catch {
    // Fall through to the standard Windows PowerShell location / executable name.
  }

  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
  const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(candidate)) return (powershellCache = candidate);

  powershellCache = null;
  return undefined;
}

export function _resetPtyGitBashCache(): void {
  gitBashCache = undefined;
  powershellCache = undefined;
}

/** Resolve the login shell, mirroring Codex on POSIX and preferring Git Bash on Windows. */
export function resolveShell(): string {
  // Windows: $SHELL is a POSIX concept and virtually never set; if a stray
  // unix value leaked in (e.g. from a Git-Bash env) it points at a path that
  // doesn't exist on the host. Prefer Git Bash for a POSIX-like terminal.
  // Without it, PowerShell is a more capable interactive fallback than cmd;
  // cmd remains the final always-present option.
  if (process.platform === "win32") {
    return resolveGitBashForPty() ?? resolvePowerShellForPty() ?? process.env.COMSPEC?.trim() ?? "cmd.exe";
  }
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

export function shellArgs(shellPath: string): string[] {
  if (process.platform === "win32") {
    return isBashLike(shellPath) ? ["--login", "-i"] : [];
  }
  return ["-il"];
}

function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  // Codex forces a sane terminal type and drops terminfo overrides.
  env.TERM = "xterm-256color";
  delete env.TERMINFO;
  delete env.TERMINFO_DIRS;
  env.CODE_SHELL_TERMINAL = "1";
  return env;
}

interface Session {
  pty: IPty;
  webContents: WebContents;
  /** Rolling scrollback so a re-attached/re-mounted xterm can be replayed. */
  buffer: string;
}

const sessions = new Map<string, Session>();

/** Cap the replay buffer so a long-running shell can't grow main unbounded. */
const MAX_BUFFER = 256 * 1024; // 256 KB

function appendBuffer(s: Session, data: string): void {
  s.buffer += data;
  if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER);
}

export interface PtyStartOpts {
  sessionId: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export type PtyStartResult = { ok: true; pid: number } | { ok: false; detail: string };

export function resolvePtyCwd(
  cwd: string | undefined,
): { ok: true; cwd: string } | { ok: false; detail: string } {
  const resolved = cwd && cwd.length > 0 ? cwd : homedir();
  try {
    const st = statSync(resolved);
    if (!st.isDirectory()) return { ok: false, detail: `pty cwd is not a directory: ${resolved}` };
    return { ok: true, cwd: resolved };
  } catch (e) {
    return {
      ok: false,
      detail: `pty cwd is not accessible: ${resolved} (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * Start (or reuse) a pty for sessionId, streaming output to `wc` via
 * `pty:data` / `pty:exit`.
 */
export function ptyStart(wc: WebContents, opts: PtyStartOpts): PtyStartResult {
  const { sessionId } = opts;
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.webContents = wc; // re-attach after a renderer reload / panel re-mount
    // Replay scrollback so the freshly-mounted xterm isn't blank while the
    // shell keeps running behind it.
    if (existing.buffer && !wc.isDestroyed()) {
      wc.send("pty:data", { sessionId, data: existing.buffer });
    }
    return { ok: true, pid: existing.pty.pid };
  }
  const shell = resolveShell();
  // Login + interactive so the user gets their normal prompt/aliases.
  const args = shellArgs(shell);
  const cwdResult = resolvePtyCwd(opts.cwd);
  if (!cwdResult.ok) return { ok: false, detail: cwdResult.detail };
  const cwd = cwdResult.cwd;
  let pty: IPty;
  try {
    pty = loadPty().spawn(shell, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd,
      env: buildEnv(),
    });
  } catch (e) {
    return {
      ok: false,
      detail: `failed to start pty: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const session: Session = { pty, webContents: wc, buffer: "" };
  sessions.set(sessionId, session);
  dlog("main", "pty.start", { sessionId, shell, cwd, pid: pty.pid });

  pty.onData((data) => {
    const s = sessions.get(sessionId);
    if (!s) return;
    appendBuffer(s, data);
    if (!s.webContents.isDestroyed()) s.webContents.send("pty:data", { sessionId, data });
  });
  pty.onExit(({ exitCode, signal }) => {
    const target = sessions.get(sessionId)?.webContents;
    if (target && !target.isDestroyed()) {
      target.send("pty:exit", { sessionId, exitCode, signal });
    }
    sessions.delete(sessionId);
    dlog("main", "pty.exit", { sessionId, exitCode, signal });
  });
  return { ok: true, pid: pty.pid };
}

export function ptyWrite(sessionId: string, data: string): void {
  // Renderer-supplied; a non-string reaching the native addon can crash main.
  if (typeof data !== "string") return;
  sessions.get(sessionId)?.pty.write(data);
}

/** Reap any session whose webContents has been destroyed (window closed). */
export function ptyReapDestroyed(): void {
  for (const [id, s] of [...sessions.entries()]) {
    if (s.webContents.isDestroyed()) ptyKill(id);
  }
}

/** Clamp a pty dimension to a positive integer. `Math.max(1, NaN)` is NaN, and
 *  node-pty.resize(NaN, …) throws / misbehaves — a non-finite or <1 dim (from a
 *  malformed IPC resize) must floor to 1. Exported for unit testing. */
export function clampPtyDim(n: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function ptyResize(sessionId: string, cols: number, rows: number): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    s.pty.resize(clampPtyDim(cols), clampPtyDim(rows));
  } catch (e) {
    dlog("main", "pty.resize.error", { sessionId, error: String(e) });
  }
}

export function ptyKill(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    /* already gone */
  }
  sessions.delete(sessionId);
}

/** Kill every pty (called on app quit). */
export function ptyKillAll(): void {
  for (const id of [...sessions.keys()]) ptyKill(id);
}
