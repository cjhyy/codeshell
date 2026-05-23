/**
 * AgentBridge — Electron main ↔ agent worker subprocess broker.
 *
 * Responsibilities:
 *   - Spawn a Node subprocess running @cjhyy/code-shell-core's
 *     agent-server-stdio.js with ELECTRON_RUN_AS_NODE=1 so the
 *     Electron binary serves as the Node runtime.
 *   - Pipe child stdout (readline-split) → renderer via
 *     window.webContents.send("agent:msg", line).
 *   - Pipe ipcMain "agent:msg" lines from renderer → child stdin.
 *   - Watch for child exit. Auto-respawn up to 3 times per 60s window;
 *     emit "agent:lifecycle" events to the renderer.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { BrowserWindow, ipcMain } from "electron";

const require = createRequire(import.meta.url);
const agentEntry = require.resolve(
  "@cjhyy/code-shell-core/dist/cli/agent-server-stdio.js",
);

const RESTART_WINDOW_MS = 60_000;
const RESTART_LIMIT = 3;

export class AgentBridge {
  private child: ChildProcess | null = null;
  private restartCount = 0;
  private restartWindowStart = Date.now();
  private ipcListenerAttached = false;

  constructor(private window: BrowserWindow) {
    this.spawnChild();
    this.attachIpcListener();
  }

  private spawnChild(): void {
    this.child = spawn(process.execPath, [agentEntry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CODESHELL_AGENT_STDIO: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!this.child.stdout || !this.child.stdin || !this.child.stderr) {
      throw new Error("AgentBridge: child stdio not piped");
    }

    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      this.safeSend("agent:msg", line);
    });

    // Mirror child stderr into the Electron main console so logs and
    // crashes are visible during dev.
    this.child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[agent] ${chunk.toString()}`);
    });

    this.child.on("exit", (code) => {
      this.safeSend("agent:lifecycle", { type: "exited", code });
      if (this.shouldRestart()) {
        this.spawnChild();
        this.safeSend("agent:lifecycle", { type: "restarted" });
      } else {
        this.safeSend("agent:lifecycle", { type: "gave_up" });
      }
    });
  }

  private shouldRestart(): boolean {
    const now = Date.now();
    if (now - this.restartWindowStart > RESTART_WINDOW_MS) {
      this.restartWindowStart = now;
      this.restartCount = 0;
    }
    this.restartCount++;
    return this.restartCount <= RESTART_LIMIT;
  }

  private attachIpcListener(): void {
    if (this.ipcListenerAttached) return;
    this.ipcListenerAttached = true;
    ipcMain.on("agent:msg", (_event, line: string) => {
      if (!this.child?.stdin || this.child.stdin.destroyed) return;
      this.child.stdin.write(line + "\n");
    });
  }

  private safeSend(channel: string, payload: unknown): void {
    if (this.window.isDestroyed()) return;
    this.window.webContents.send(channel, payload);
  }

  kill(): void {
    this.child?.kill("SIGTERM");
  }
}
