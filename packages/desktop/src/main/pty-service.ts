// Interactive terminal backend (node-pty). Modeled on Codex's TerminalService:
// main owns the pty, renderer drives it over IPC. One pty per sessionId.
//
// node-pty is a native module; the esbuild `build:main` bundle marks all
// bare requires external and injects a createRequire banner, so we load it
// lazily here (createRequire) the same way Codex does — avoids bundling the
// native addon and keeps it resolvable from node_modules at runtime.
import { createRequire } from "node:module";
import { homedir } from "node:os";
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

/** Resolve the login shell, mirroring Codex: $SHELL, else /bin/zsh on darwin. */
function resolveShell(): string {
  // Windows: $SHELL is a POSIX concept and virtually never set; if a stray
  // unix value leaked in (e.g. from a Git-Bash env) it points at a path that
  // doesn't exist on the host. Prefer COMSPEC/powershell and ignore $SHELL.
  if (process.platform === "win32") {
    return process.env.COMSPEC?.trim() || "powershell.exe";
  }
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  return process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
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

/**
 * Start (or reuse) a pty for sessionId, streaming output to `wc` via
 * `pty:data` / `pty:exit`. Returns the pid.
 */
export function ptyStart(wc: WebContents, opts: PtyStartOpts): { pid: number } {
  const { sessionId } = opts;
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.webContents = wc; // re-attach after a renderer reload / panel re-mount
    // Replay scrollback so the freshly-mounted xterm isn't blank while the
    // shell keeps running behind it.
    if (existing.buffer && !wc.isDestroyed()) {
      wc.send("pty:data", { sessionId, data: existing.buffer });
    }
    return { pid: existing.pty.pid };
  }
  const shell = resolveShell();
  // Login + interactive so the user gets their normal prompt/aliases.
  const args = process.platform === "win32" ? [] : ["-il"];
  const cwd = opts.cwd && opts.cwd.length > 0 ? opts.cwd : homedir();
  const pty = loadPty().spawn(shell, args, {
    name: "xterm-256color",
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    cwd,
    env: buildEnv(),
  });
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
  return { pid: pty.pid };
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

export function ptyResize(sessionId: string, cols: number, rows: number): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    s.pty.resize(Math.max(1, cols), Math.max(1, rows));
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
