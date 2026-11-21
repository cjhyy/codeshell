// Interactive terminal backend (node-pty). Modeled on Codex's TerminalService:
// The owning process keeps a terminal per renderer-local session handle.
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
export interface PtyOwner {
  readonly id: number;
  isDestroyed(): boolean;
  send(
    channel: "pty:data" | "pty:exit" | "pty:remoteViewers",
    value: {
      sessionId: string;
      data?: string;
      exitCode?: number;
      signal?: number;
      replay?: boolean;
      count?: number;
    },
  ): void;
}
import { dlog } from "./desktop-logger.js";
import { ptyEntryPath } from "./pty-entry.mjs";

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
  if (!nodePty)
    nodePty = require(ptyEntryPath(require.resolve("node-pty"), process.resourcesPath)) as NodePty;
  return nodePty;
}

export function _setPtyForTest(next: any): void {
  nodePty = next as NodePty | null;
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
    const found = out
      .split(/\r?\n/)
      .find((line) => line.trim().toLowerCase().endsWith("powershell.exe"));
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
    return (
      resolveGitBashForPty() ??
      resolvePowerShellForPty() ??
      process.env.COMSPEC?.trim() ??
      "cmd.exe"
    );
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

/** A remote (phone/browser) tab watching a Desktop terminal. */
export interface PtyRemoteViewer {
  /** Stable per remote tab; reattaching with the same key replaces the old entry. */
  key: string;
  onData(data: string): void;
  onExit(exitCode: number, signal?: number): void;
}

interface Session {
  pty: IPty;
  /** The Desktop window that opened it; null for a terminal opened remotely. */
  webContents: PtyOwner | null;
  /** Rolling scrollback so a re-attached/re-mounted xterm can be replayed. */
  buffer: string;
  cwd: string;
  startedAt: number;
  cols: number;
  rows: number;
  /** Last size each client reported; the most recently active client wins. */
  sizes: Map<string, { cols: number; rows: number }>;
  /** The client that typed, resized or attached last; only it answers terminal queries. */
  activeKey: string | undefined;
  remotes: Map<string, PtyRemoteViewer>;
}

const OWNER_SIZE_KEY = "\0owner";

const sessions = new Map<string, Session>();

/**
 * PTY ids are renderer-local composite keys, not persisted Engine session ids.
 * PanelRegistry deliberately builds them as
 * `term:<project>::<session>:<tab>@<window>`, so keep the alphabet path-safe
 * while accepting the separators used by that canonical format.
 */
export function isValidPtySessionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.startsWith("term:") &&
    !value.includes("..") &&
    /^[A-Za-z0-9_.:@-]+$/.test(value)
  );
}

export function assertValidPtySessionId(value: unknown): asserts value is string {
  if (!isValidPtySessionId(value)) throw new Error("invalid pty sessionId");
}

/** Cap the replay buffer so a long-running shell can't grow main unbounded. */
const MAX_BUFFER = 256 * 1024; // 256 KB

function appendBuffer(s: Session, data: string): void {
  s.buffer += data;
  if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(s.buffer.length - MAX_BUFFER);
}

function webContentsId(wc: PtyOwner): number | undefined {
  try {
    return wc.id;
  } catch {
    return undefined;
  }
}

function sessionForOwner(wc: PtyOwner, sessionId: string, action: string): Session | undefined {
  const s = sessions.get(sessionId);
  if (!s) return undefined;
  if (!s.webContents || s.webContents !== wc) {
    dlog("main", `pty.${action}.denied`, {
      sessionId,
      ownerId: s.webContents ? webContentsId(s.webContents) : undefined,
      senderId: webContentsId(wc),
    });
    return undefined;
  }
  return s;
}

function killSession(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  try {
    s.pty.kill();
  } catch {
    /* already gone */
  }
  sessions.delete(sessionId);
}

function ownerAlive(s: Session): s is Session & { webContents: PtyOwner } {
  return s.webContents !== null && !s.webContents.isDestroyed();
}

/** Tell the owning window how many remote viewers share its terminal. */
function notifyRemoteViewers(sessionId: string, s: Session): void {
  if (ownerAlive(s)) {
    s.webContents.send("pty:remoteViewers", { sessionId, count: s.remotes.size });
  }
}

/** One pty has one size: whoever typed or resized last gets theirs applied. */
function applyClientSize(sessionId: string, s: Session, clientKey: string): void {
  s.activeKey = clientKey;
  const size = s.sizes.get(clientKey);
  if (!size || (size.cols === s.cols && size.rows === s.rows)) return;
  try {
    s.pty.resize(size.cols, size.rows);
    s.cols = size.cols;
    s.rows = size.rows;
  } catch (e) {
    dlog("main", "pty.resize.error", { sessionId, error: String(e) });
  }
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
export function ptyStart(wc: PtyOwner, opts: PtyStartOpts): PtyStartResult {
  const { sessionId } = opts;
  const existing = sessions.get(sessionId);
  if (existing) {
    if (!sessionForOwner(wc, sessionId, "reattach")) {
      return { ok: false, detail: "pty session is owned by another webContents" };
    }
    // Replay scrollback so the freshly-mounted xterm isn't blank while the
    // shell keeps running behind it.
    if (existing.buffer && !wc.isDestroyed()) {
      wc.send("pty:data", { sessionId, data: existing.buffer, replay: true });
    }
    return { ok: true, pid: existing.pty.pid };
  }
  return spawnSession(sessionId, wc, opts);
}

function spawnSession(
  sessionId: string,
  owner: PtyOwner | null,
  opts: { cwd?: string; cols?: number; rows?: number },
): PtyStartResult {
  const shell = resolveShell();
  // Login + interactive so the user gets their normal prompt/aliases.
  const args = shellArgs(shell);
  const cwdResult = resolvePtyCwd(opts.cwd);
  if (!cwdResult.ok) return { ok: false, detail: cwdResult.detail };
  const cwd = cwdResult.cwd;
  const cols = clampPtyDim(opts.cols ?? 80);
  const rows = clampPtyDim(opts.rows ?? 24);
  let pty: IPty;
  try {
    pty = loadPty().spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: buildEnv(),
    });
  } catch (e) {
    return {
      ok: false,
      detail: `failed to start pty: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const session: Session = {
    pty,
    webContents: owner,
    buffer: "",
    cwd,
    startedAt: Date.now(),
    cols,
    rows,
    sizes: new Map(owner ? [[OWNER_SIZE_KEY, { cols, rows }]] : []),
    activeKey: owner ? OWNER_SIZE_KEY : undefined,
    remotes: new Map(),
  };
  sessions.set(sessionId, session);
  dlog("main", "pty.start", { sessionId, shell, cwd, pid: pty.pid, remote: owner === null });

  pty.onData((data) => {
    const s = sessions.get(sessionId);
    if (s !== session) return;
    appendBuffer(s, data);
    if (ownerAlive(s)) s.webContents.send("pty:data", { sessionId, data });
    for (const viewer of s.remotes.values()) viewer.onData(data);
  });
  pty.onExit(({ exitCode, signal }) => {
    const s = sessions.get(sessionId);
    if (s !== session) return;
    if (ownerAlive(s)) {
      s.webContents.send("pty:exit", { sessionId, exitCode, signal });
    }
    for (const viewer of s.remotes.values()) viewer.onExit(exitCode, signal);
    sessions.delete(sessionId);
    dlog("main", "pty.exit", { sessionId, exitCode, signal });
  });
  return { ok: true, pid: pty.pid };
}

/**
 * `reply` marks xterm's automatic answers to terminal queries (colors, device
 * attributes). Every attached viewer produces them, so only the active client's
 * reach the program; a duplicate answer would otherwise be read as typed input.
 */
function writeFrom(sessionId: string, s: Session, key: string, data: string, reply: boolean) {
  if (reply) {
    if (s.activeKey === key) s.pty.write(data);
    return;
  }
  applyClientSize(sessionId, s, key);
  s.pty.write(data);
}

export function ptyWrite(wc: PtyOwner, sessionId: string, data: string, reply = false): void {
  // Renderer-supplied; a non-string reaching the native addon can crash main.
  if (typeof data !== "string") return;
  const s = sessionForOwner(wc, sessionId, "write");
  if (s) writeFrom(sessionId, s, OWNER_SIZE_KEY, data, reply === true);
}

/** Reap any session whose webContents has been destroyed (window closed). */
export function ptyReapDestroyed(): void {
  for (const [id, s] of [...sessions.entries()]) {
    if (s.webContents?.isDestroyed()) killSession(id);
  }
}

/** Clamp a pty dimension to a positive integer. `Math.max(1, NaN)` is NaN, and
 *  node-pty.resize(NaN, …) throws / misbehaves — a non-finite or <1 dim (from a
 *  malformed IPC resize) must floor to 1. Exported for unit testing. */
export function clampPtyDim(n: number): number {
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

export function ptyResize(wc: PtyOwner, sessionId: string, cols: number, rows: number): void {
  const s = sessionForOwner(wc, sessionId, "resize");
  if (!s) return;
  s.sizes.set(OWNER_SIZE_KEY, { cols: clampPtyDim(cols), rows: clampPtyDim(rows) });
  applyClientSize(sessionId, s, OWNER_SIZE_KEY);
}

export function ptyKill(wc: PtyOwner, sessionId: string): void {
  if (!sessionForOwner(wc, sessionId, "kill")) return;
  killSession(sessionId);
}

/** Kill every pty (called on app quit). */
export function ptyKillAll(): void {
  for (const id of [...sessions.keys()]) killSession(id);
}

// ── Remote viewers (phone / browser through the authenticated remote host) ──
// Authorization (paired device + the Desktop "remote terminal" switch) is the
// caller's job; these functions only enforce that a viewer is attached before
// it may type, resize or kill.

export interface PtyInfo {
  id: string;
  cwd: string;
  pid: number;
  startedAt: number;
  origin: "desktop" | "remote";
  cols: number;
  rows: number;
}

function info(id: string, s: Session): PtyInfo {
  return {
    id,
    cwd: s.cwd,
    pid: s.pty.pid,
    startedAt: s.startedAt,
    origin: s.webContents ? "desktop" : "remote",
    cols: s.cols,
    rows: s.rows,
  };
}

/** Running terminals whose window (if any) is still open, oldest first. */
export function ptyList(): PtyInfo[] {
  return [...sessions.entries()]
    .filter(([, s]) => s.webContents === null || !s.webContents.isDestroyed())
    .map(([id, s]) => info(id, s))
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Start a terminal no Desktop window owns; it lives until killed or the app quits. */
export function ptyRemoteStart(opts: {
  sessionId: string;
  cwd?: string;
  cols?: number;
  rows?: number;
}): PtyStartResult {
  assertValidPtySessionId(opts.sessionId);
  if (sessions.has(opts.sessionId)) return { ok: false, detail: "pty session already exists" };
  return spawnSession(opts.sessionId, null, opts);
}

/** Attach a remote viewer; returns the scrollback to replay before live output. */
export function ptyAttachRemote(
  sessionId: string,
  viewer: PtyRemoteViewer,
  size: { cols: number; rows: number },
): { info: PtyInfo; replay: string } | undefined {
  const s = sessions.get(sessionId);
  if (!s || (s.webContents && s.webContents.isDestroyed())) return undefined;
  s.remotes.set(viewer.key, viewer);
  s.sizes.set(viewer.key, { cols: clampPtyDim(size.cols), rows: clampPtyDim(size.rows) });
  applyClientSize(sessionId, s, viewer.key);
  notifyRemoteViewers(sessionId, s);
  return { info: info(sessionId, s), replay: s.buffer };
}

export function ptyDetachRemote(sessionId: string, key: string): void {
  const s = sessions.get(sessionId);
  if (!s || !s.remotes.delete(key)) return;
  s.sizes.delete(key);
  if (s.activeKey === key) s.activeKey = s.webContents ? OWNER_SIZE_KEY : undefined;
  notifyRemoteViewers(sessionId, s);
}

/** Drop every remote viewer matching `keep === false`; used when tabs go away. */
export function ptyPruneRemoteViewers(keep: (key: string) => boolean): void {
  for (const [id, s] of sessions) {
    let changed = false;
    for (const key of [...s.remotes.keys()]) {
      if (keep(key)) continue;
      s.remotes.delete(key);
      s.sizes.delete(key);
      if (s.activeKey === key) s.activeKey = s.webContents ? OWNER_SIZE_KEY : undefined;
      changed = true;
    }
    if (changed) notifyRemoteViewers(id, s);
  }
}

function attached(sessionId: string, key: string, action: string): Session | undefined {
  const s = sessions.get(sessionId);
  if (s?.remotes.has(key)) return s;
  dlog("main", `pty.remote.${action}.denied`, { sessionId });
  return undefined;
}

export function ptyRemoteWrite(sessionId: string, key: string, data: string, reply = false): void {
  if (typeof data !== "string") return;
  const s = attached(sessionId, key, "write");
  if (s) writeFrom(sessionId, s, key, data, reply);
}

export function ptyRemoteResize(sessionId: string, key: string, cols: number, rows: number): void {
  const s = attached(sessionId, key, "resize");
  if (!s) return;
  s.sizes.set(key, { cols: clampPtyDim(cols), rows: clampPtyDim(rows) });
  applyClientSize(sessionId, s, key);
}

export function ptyRemoteKill(sessionId: string, key: string): void {
  if (attached(sessionId, key, "kill")) killSession(sessionId);
}

/** Remote access was switched off: detach everyone and end remote-only shells. */
export function ptyRevokeRemoteAccess(): void {
  for (const [id, s] of [...sessions.entries()]) {
    if (s.webContents === null) {
      killSession(id);
      continue;
    }
    if (s.remotes.size === 0) continue;
    for (const key of s.remotes.keys()) s.sizes.delete(key);
    s.remotes.clear();
    s.activeKey = OWNER_SIZE_KEY;
    notifyRemoteViewers(id, s);
  }
}
