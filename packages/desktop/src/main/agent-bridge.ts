/**
 * AgentBridge — Electron main ↔ agent worker subprocess broker.
 *
 * Responsibilities:
 *   - Spawn a Node subprocess running @cjhyy/code-shell-core's
 *     agent-server-stdio.js with ELECTRON_RUN_AS_NODE=1 so the
 *     Electron binary serves as the Node runtime. Worker is spawned
 *     on-demand (when an agent/run request arrives) and exits cleanly
 *     after each run completes.
 *   - Pipe child stdout (readline-split) → renderer via
 *     window.webContents.send("agent:msg", line).
 *   - Pipe ipcMain "agent:msg" lines from renderer → child stdin.
 *   - Watch for child exit. Differentiate clean exits (code=0) from
 *     crashes. After a crash, track a 3×/60s restart cap and emit
 *     lifecycle events; but DON'T pre-emptively respawn — next user
 *     run will trigger a fresh spawn anyway.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { BrowserWindow, ipcMain } from "electron";
import { dlog } from "./desktop-logger.js";
import { SessionSnapshotStore, type Snapshot } from "./SessionSnapshotStore.js";
import { parseSnapshotAppend } from "./parseStreamLine.js";

/**
 * Neutral sandbox directory used when the user is in a "no project"
 * conversation. We do NOT want the agent worker booting in $HOME —
 * tools like Bash/Read/Write would then roam the entire home folder.
 * `~/.code-shell/no-repo` is created on demand and kept stable across
 * runs so the worker always lands in a contained directory.
 */
function resolveNoRepoCwd(): string {
  const dir = join(homedir(), ".code-shell", "no-repo");
  try { mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
  return dir;
}

const require = createRequire(import.meta.url);
const agentEntry = require.resolve(
  "@cjhyy/code-shell-core/bin/agent-server-stdio",
);

const RESTART_WINDOW_MS = 60_000;
const RESTART_LIMIT = 3;

function previewLine(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} more)` : s;
}

export class AgentBridge {
  private child: ChildProcess | null = null;
  /** Pending lines that arrived before the worker was spawned. */
  private outbox: string[] = [];
  private restartCount = 0;
  private restartWindowStart = Date.now();
  private ipcListenerAttached = false;
  /**
   * All BrowserWindows we should broadcast worker events to. The bridge
   * is process-global; each window registers via attachWindow(). When
   * a window closes we detach it so we don't `webContents.send` to a
   * destroyed window.
   */
  private windows = new Set<BrowserWindow>();
  /**
   * Per-session event snapshot. Lives in main (which never remounts), so a
   * reloaded renderer can re-subscribe and replay the events it missed while
   * it was gone. See SessionSnapshotStore.
   */
  private readonly snapshots = new SessionSnapshotStore();

  constructor(window: BrowserWindow) {
    dlog("bridge", "ctor", { agentEntry, execPath: process.execPath });
    this.windows.add(window);
    window.on("closed", () => this.windows.delete(window));
    this.attachIpcListener();
  }

  /** Add another window to broadcast list (multi-window mode). */
  attachWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on("closed", () => this.windows.delete(window));
  }

  /**
   * Spawn the worker for a new run. `cwd` is the working directory the
   * Engine will use (i.e. the repo root). Idempotent if a child is alive.
   */
  private spawnChild(cwd: string | undefined): void {
    if (this.child) return;
    const workerCwd = cwd ?? resolveNoRepoCwd();
    dlog("bridge", "spawn.start", {
      cwd: workerCwd,
      requestedCwd: cwd,
      restartCount: this.restartCount,
    });
    this.child = spawn(process.execPath, [agentEntry], {
      cwd: workerCwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODESHELL_AGENT_STDIO: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    dlog("bridge", "spawn.ok", { pid: this.child.pid, cwd: workerCwd, requestedCwd: cwd });
    if (!this.child.stdout || !this.child.stdin || !this.child.stderr) {
      dlog("bridge", "spawn.error", { reason: "stdio not piped" });
      throw new Error("AgentBridge: child stdio not piped");
    }
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let summary: Record<string, unknown> = { raw: previewLine(line) };
      try {
        const m = JSON.parse(line) as { method?: string; id?: number };
        if (m.method) summary = { method: m.method, raw: previewLine(line) };
        else if (m.id !== undefined) summary = { responseId: m.id, raw: previewLine(line) };
      } catch { /* keep raw */ }
      // Mirror stream events into the per-session snapshot so a remounted
      // renderer can replay what it missed. Non-streamEvent lines yield null.
      const append = parseSnapshotAppend(line);
      if (append) this.snapshots.append(append.sessionId, append.event);
      dlog("bridge", "worker→renderer", summary);
      this.safeSend("agent:msg", line);
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      dlog("agent", "stderr", { text: previewLine(text, 800) });
      process.stderr.write(`[agent] ${text}`);
    });
    this.child.on("exit", (code, signal) => {
      // Close the readline interface bound to the dead child's stdout so it
      // (and its "line" listener) doesn't leak across restarts.
      rl.close();
      dlog("bridge", "child.exit", { code, signal, pid: this.child?.pid });
      this.child = null;
      this.outbox = []; // any queued messages were for the dead child; drop
      // Snapshots intentionally survive worker exit — a respawn may resume the
      // same session, and a remounted renderer still needs to replay them.
      this.snapshots.onWorkerExit();
      if (code === 0 && signal === null) {
        // Normal completion. Reset restart counter — clean exits don't count.
        this.restartCount = 0;
        this.safeSend("agent:lifecycle", { type: "exited", code });
        return;
      }
      // Real crash. Note it but DON'T pre-emptively respawn — next user
      // run will trigger a fresh spawn anyway. We just decide whether to
      // declare "gave up" so the renderer can show a banner.
      if (this.shouldDeclareGaveUp()) {
        dlog("bridge", "crash.gave_up", { restartCount: this.restartCount });
        this.safeSend("agent:lifecycle", { type: "gave_up" });
      } else {
        dlog("bridge", "crash.tolerable", { restartCount: this.restartCount });
        this.safeSend("agent:lifecycle", { type: "exited", code });
      }
    });
    // Flush queued lines now that stdin exists.
    for (const queued of this.outbox) {
      this.child.stdin.write(queued + "\n");
    }
    this.outbox = [];
  }

  /** Returns true after >= RESTART_LIMIT crashes in the current 60s window. */
  private shouldDeclareGaveUp(): boolean {
    const now = Date.now();
    if (now - this.restartWindowStart > RESTART_WINDOW_MS) {
      this.restartWindowStart = now;
      this.restartCount = 0;
    }
    this.restartCount++;
    return this.restartCount > RESTART_LIMIT;
  }

  private attachIpcListener(): void {
    if (this.ipcListenerAttached) return;
    this.ipcListenerAttached = true;

    ipcMain.on("agent:msg", (_event, line: string) => {
      // Inspect the message: an agent/run is the only one that can trigger
      // a fresh spawn. Other messages (agent/approve, agent/cancel) only
      // make sense if the worker is already alive.
      let parsed: { method?: string; params?: { cwd?: string } } = {};
      try { parsed = JSON.parse(line); } catch { /* fall through */ }

      if (parsed.method === "agent/run") {
        this.spawnChild(parsed.params?.cwd);
      }

      if (!this.child?.stdin || this.child.stdin.destroyed) {
        // No live worker. For approve / cancel this is fine — drop.
        // For run, spawnChild above should have created one; if it
        // didn't, log and drop.
        dlog("bridge", "renderer→worker.dropped", {
          reason: this.child ? "stdin destroyed" : "no child",
          method: parsed.method,
        });
        return;
      }
      dlog("bridge", "renderer→worker", { method: parsed.method, raw: previewLine(line) });
      this.child.stdin.write(line + "\n");
    });

    ipcMain.on("desktop:log", (_event, payload: { msg: string; data?: Record<string, unknown> }) => {
      dlog("renderer", payload.msg, payload.data);
    });
  }

  private safeSend(channel: string, payload: unknown): void {
    for (const w of this.windows) {
      if (w.isDestroyed()) {
        this.windows.delete(w);
        continue;
      }
      w.webContents.send(channel, payload);
    }
  }

  /**
   * Snapshot of a session's events for a (re)subscribing renderer. With
   * `sinceSeq`, returns only the events the renderer is missing past that
   * cursor; the renderer aligns them against its live stream by seq.
   */
  getSnapshot(sessionId: string, sinceSeq = 0): Snapshot {
    return this.snapshots.get(sessionId, sinceSeq);
  }

  /** Drop a session's snapshot (e.g. when the session is deleted). */
  forgetSession(sessionId: string): void {
    this.snapshots.forget(sessionId);
  }

  /** Feed an event produced OUTSIDE the stdio worker (e.g. an in-main automation
   *  Engine) into the same snapshot + renderer stream, so renderer reconnect works
   *  identically for automation sessions. */
  ingestExternalEvent(sessionId: string, event: unknown): void {
    this.snapshots.append(sessionId, event);
    this.safeSend("agent:msg", JSON.stringify({
      jsonrpc: "2.0", method: "agent/streamEvent", params: { sessionId, event },
    }));
  }

  /**
   * Announce a live automation session to the renderer so it can create the
   * sidebar entry under the project owning `cwd` (stream events carry no cwd).
   * Separate JSON-RPC method from `agent/streamEvent` so the shared core
   * StreamEvent shape stays untouched and the interactive path is unaffected.
   */
  broadcastAutomationSession(meta: { sessionId: string; cwd: string; title: string; prompt: string; cronJobId: string }): void {
    this.safeSend("agent:msg", JSON.stringify({
      jsonrpc: "2.0", method: "agent/automationSession", params: meta,
    }));
  }

  kill(): void {
    dlog("bridge", "kill", { pid: this.child?.pid });
    this.child?.kill("SIGTERM");
  }
}
