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
import {
  parseBrowserActionLine,
  buildBrowserActionReply,
  parseCredentialActionLine,
  buildCredentialActionReply,
} from "./browser-driver/intercept.js";
import { handleBrowserAction } from "./browser-driver/automation-host.js";
import { CredentialStore, SessionManager } from "@cjhyy/code-shell-core";
import { restoreCookiesToBrowser, type ElectronCookieLike } from "./credentials-service.js";
import { activeGuest, listGuests, focusGuest } from "./browser-driver/active-guest.js";
import { loadBrowserAutomationPolicy } from "./browser-driver/load-policy.js";
import { buildNoChildFallbackReply, type ParsedRpc } from "./agent-bridge-fallback.js";
import { getTrustCachedSync } from "./trust-store.js";
import { reloadAutomations } from "./automation-service.js";

/**
 * Neutral sandbox directory used when the user is in a "no project"
 * conversation. We do NOT want the agent worker booting in $HOME —
 * tools like Bash/Read/Write would then roam the entire home folder.
 * `~/.code-shell/no-repo` is created on demand and kept stable across
 * runs so the worker always lands in a contained directory.
 */
export function resolveNoRepoCwd(): string {
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
   * Lazily-created SessionManager for disk-backed fallbacks when no worker is
   * live (goalGet / goalClear reach state.json without spinning up a worker).
   * Reads CODE_SHELL_HOME / ~/.code-shell like the worker does, so it targets
   * the same sessions dir. Created on first use to keep construction cheap.
   */
  private fallbackSessions: SessionManager | null = null;
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
  /**
   * Out-of-band observers of worker→renderer lines (e.g. the Mobile Web
   * Remote, which streams the same events to a phone). Taps are read-only:
   * they see the exact JSON-RPC lines the renderer sees, so the phone shares
   * the renderer's single run/permission path rather than a second runtime.
   */
  private readonly outboundTaps = new Set<(line: string) => void>();
  /**
   * The cwd/sessionId of the most recent `agent/run` (from renderer OR mobile).
   * Used as the default context when a mobile client sends chat without an
   * explicit session — the phone follows whatever the desktop is working on.
   */
  private lastRunContext: { cwd?: string; sessionId?: string } = {};

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
    try {
      this.child = spawn(process.execPath, [agentEntry], {
        cwd: workerCwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CODESHELL_AGENT_STDIO: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      // spawn() can throw synchronously (e.g. invalid execPath). Don't let it
      // bubble out of the ipcMain listener / injectWorkerMessage uncaught —
      // declare give-up so preload rejects the pending run instead of hanging.
      dlog("bridge", "spawn.throw", { error: String(e) });
      this.child = null;
      this.safeSend("agent:lifecycle", { type: "gave_up" });
      return;
    }
    dlog("bridge", "spawn.ok", { pid: this.child.pid, cwd: workerCwd, requestedCwd: cwd });
    if (!this.child.stdout || !this.child.stdin || !this.child.stderr) {
      dlog("bridge", "spawn.error", { reason: "stdio not piped" });
      this.child = null;
      this.safeSend("agent:lifecycle", { type: "gave_up" });
      return;
    }
    const rl = createInterface({ input: this.child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      // Browser automation: intercept __browser_action__ requests here (drive the
      // webview in main, reply to the worker) and DON'T forward to the renderer.
      if (this.maybeHandleBrowserAction(line)) return;
      // InjectCredential: intercept __credential_action__ (restore a cookie
      // credential into the built-in browser) here; DON'T forward to renderer.
      if (this.maybeHandleCredentialAction(line)) return;
      // cron change: the worker created/deleted a cron job (agent/cronChanged);
      // reload main's scheduler so it arms immediately. DON'T forward to renderer.
      if (this.maybeHandleCronChanged(line)) return;
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
      for (const tap of this.outboundTaps) {
        try {
          tap(line);
        } catch {
          /* a tap must never break worker streaming */
        }
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      dlog("agent", "stderr", { text: previewLine(text, 800) });
      process.stderr.write(`[agent] ${text}`);
    });
    // A failed spawn (ENOENT/EACCES/EAGAIN/process-limit) emits 'error' and
    // NO 'exit'. Without this listener Node throws it as an uncaught exception
    // (can crash main), and — worse — neither path below fires, so the
    // renderer's run() (timeout disabled) never settles and the UI hangs busy
    // forever. Treat a spawn error like a give-up crash so preload rejects the
    // pending run.
    this.child.on("error", (err) => {
      dlog("bridge", "child.error", { error: String(err) });
      try {
        rl.close();
      } catch { /* ignore */ }
      this.child = null;
      this.outbox = [];
      this.snapshots.onWorkerExit();
      this.safeSend("agent:lifecycle", { type: "gave_up" });
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

  /** Lazily build the disk-backed SessionManager used for no-worker fallbacks. */
  private sessionsForFallback(): SessionManager {
    if (!this.fallbackSessions) this.fallbackSessions = new SessionManager();
    return this.fallbackSessions;
  }

  private attachIpcListener(): void {
    if (this.ipcListenerAttached) return;
    this.ipcListenerAttached = true;

    ipcMain.on("agent:msg", (_event, line: string) => {
      // Inspect the message: an agent/run is the only one that can trigger
      // a fresh spawn. Other messages (agent/approve, agent/cancel) only
      // make sense if the worker is already alive.
      let parsed: ParsedRpc = {};
      try { parsed = JSON.parse(line); } catch { /* fall through */ }

      // Line forwarded to the worker. Only rewritten when we inject fields
      // (agent/run trust) — everything else is passed through verbatim so we
      // don't re-serialize on the hot path.
      let outLine = line;

      if (parsed.method === "agent/run") {
        this.spawnChild(parsed.params?.cwd);
        this.lastRunContext = {
          cwd: parsed.params?.cwd,
          sessionId: parsed.params?.sessionId,
        };
        // Workspace trust is a main-process authority (trust-store), never the
        // renderer's to assert — inject it here so a cloned malicious repo's
        // .code-shell settings can't self-authorize. "unknown"/never-trusted →
        // fail-closed (projectTrusted:false), which makes core strip the
        // dangerous project settings fields. Synchronous cache read: this IPC
        // handler can't await without reordering run vs approve/cancel.
        if (parsed.params && typeof parsed.params === "object") {
          const cwd = parsed.params.cwd;
          const trusted = typeof cwd === "string" && getTrustCachedSync(cwd) === "trusted";
          (parsed.params as Record<string, unknown>).projectTrusted = trusted;
          outLine = JSON.stringify(parsed);
        }
      }

      if (!this.child?.stdin || this.child.stdin.destroyed) {
        // No live worker. For approve / cancel this is fine — drop.
        // For run, spawnChild above should have created one; if it
        // didn't, log and drop.
        // BUT some requests must still get a REPLY, or the renderer's rpc()
        // hangs its 30s timeout: read-only registry queries (backgroundShells /
        // backgroundWork — the in-RAM registry is gone with the worker) and
        // disk-backed goal ops (goalGet / goalClear — a persistent goal lives
        // in state.json and outlives the worker; without this the "Clear goal"
        // button did nothing for an aborted goal session).
        const fallback = buildNoChildFallbackReply(parsed, this.sessionsForFallback());
        if (fallback !== null) {
          this.safeSend("agent:msg", fallback);
        }
        dlog("bridge", "renderer→worker.dropped", {
          reason: this.child ? "stdin destroyed" : "no child",
          method: parsed.method,
          answered: fallback !== null,
        });
        return;
      }
      dlog("bridge", "renderer→worker", { method: parsed.method, raw: previewLine(outLine) });
      this.child.stdin.write(outLine + "\n");
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
   * If `line` is a __browser_action__ request from the worker, drive the active
   * webview here (main) and write the result back to the worker as an approve
   * reply, returning true (caller must NOT forward to renderer). Otherwise
   * false. Never throws — a failure still replies so the worker tool unblocks.
   */
  private maybeHandleBrowserAction(line: string): boolean {
    const parsed = parseBrowserActionLine(line);
    if (!parsed) return false;
    void (async () => {
      let resultJson: string;
      try {
        resultJson = await handleBrowserAction(parsed.request, {
          activeGuest,
          policy: loadBrowserAutomationPolicy,
          // The click/type TOOLS already carry permissionDefault:"ask", so a
          // sensitive page action is gated at the tool-permission layer BEFORE
          // it reaches here — a second hard-decline at the bridge would just
          // dead-block legit flows the user already approved. So we allow at the
          // bridge level. The one bridge-only gate that still hard-enforces is
          // the DOMAIN WHITELIST: it's opt-in (empty list = allow all), and when
          // the user did set one, blocking an off-list host is the intended
          // behavior. An interactive per-action approval dialog is a follow-up.
          approve: async () => true,
          openPanel: (url) => this.openBrowserPanel(url),
          listTabs: listGuests,
          switchTab: focusGuest,
        });
      } catch (e) {
        resultJson = JSON.stringify({ ok: false, detail: e instanceof Error ? e.message : String(e) });
      }
      const reply = buildBrowserActionReply(parsed, resultJson);
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(reply + "\n");
      }
    })();
    return true;
  }

  /**
   * If `line` is a __credential_action__ request (InjectCredential tool), restore
   * the named cookie credential's jar into the built-in browser here (main) and
   * reply to the worker. Returns true (caller must NOT forward to renderer).
   * Never throws — a failure still replies so the worker tool unblocks.
   * The AI-side approval gate already ran in the worker tool; this just executes.
   */
  /** Intercept the worker's `agent/cronChanged` notification: reload main's
   *  cron scheduler so an AI-created/deleted job arms immediately. Returns true
   *  (consume, don't forward to renderer) when handled. */
  private maybeHandleCronChanged(line: string): boolean {
    let parsed: { method?: string };
    try { parsed = JSON.parse(line); } catch { return false; }
    if (parsed.method !== "agent/cronChanged") return false;
    try {
      reloadAutomations();
    } catch (err) {
      dlog("bridge", "cronChanged.reload_failed", { error: String(err) });
    }
    return true;
  }

  private maybeHandleCredentialAction(line: string): boolean {
    const parsed = parseCredentialActionLine(line);
    if (!parsed) return false;
    void (async () => {
      let resultJson: string;
      try {
        const cred = new CredentialStore(this.lastRunContext.cwd || undefined).resolve(
          parsed.credentialId,
        );
        if (!cred || cred.type !== "cookie") {
          resultJson = JSON.stringify({ ok: false, error: `无 cookie 凭证: "${parsed.credentialId}"` });
        } else {
          let jar: ElectronCookieLike[] = [];
          try {
            const arr = JSON.parse(cred.secret ?? "[]");
            if (Array.isArray(arr)) jar = arr as ElectronCookieLike[];
          } catch {
            jar = [];
          }
          if (jar.length === 0) {
            resultJson = JSON.stringify({ ok: false, error: `凭证「${cred.label}」cookie 为空或损坏` });
          } else {
            const { count } = await restoreCookiesToBrowser(
              jar,
              cred.meta?.switchMode === "merge" ? "merge" : "clear",
            );
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) w.webContents.send("browser:reload");
            }
            resultJson = JSON.stringify({ ok: true, count });
          }
        }
      } catch (e) {
        resultJson = JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
      const reply = buildCredentialActionReply(parsed, resultJson);
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(reply + "\n");
      }
    })();
    return true;
  }

  /**
   * Open the in-app browser panel (and navigate to `url` if given) on behalf of
   * the agent when no panel/tab is open yet, then wait for the <webview> guest
   * to attach. Sends `browser:open-url` to the first live window (the renderer
   * re-dispatches it as the same `codeshell:open-url` event a clicked chat link
   * uses → opens dock + browser panel + navigates). Polls activeGuest() until a
   * guest registers (did-attach-webview) or a ~6s timeout. Returns whether a
   * guest became available.
   */
  private async openBrowserPanel(url?: string): Promise<boolean> {
    const win = [...this.windows].find((w) => !w.isDestroyed());
    if (!win) return false;
    // A blank panel needs *some* URL to attach a <webview>; default to about:blank.
    win.webContents.send("browser:open-url", { url: url ?? "about:blank" });
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const g = activeGuest();
      if (g && !g.isDestroyed()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return !!activeGuest();
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

  /**
   * Inject a JSON-RPC line into the worker exactly as the renderer would via
   * the "agent:msg" IPC channel. This is the reuse seam for alternate front
   * ends (the Mobile Web Remote): an `agent/run` line spawns the worker if
   * needed; `agent/approve` / `agent/cancel` are dropped if no worker is
   * alive — identical semantics to the renderer path. The caller is
   * responsible for building a well-formed line (see preload's rpc()).
   */
  injectWorkerMessage(line: string): void {
    let parsed: { method?: string; params?: { cwd?: string; sessionId?: string } } = {};
    try {
      parsed = JSON.parse(line);
    } catch {
      /* fall through — a malformed line is dropped below */
    }
    if (parsed.method === "agent/run") {
      this.spawnChild(parsed.params?.cwd);
      this.lastRunContext = {
        cwd: parsed.params?.cwd,
        sessionId: parsed.params?.sessionId,
      };
    }
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      dlog("bridge", "inject.dropped", {
        reason: this.child ? "stdin destroyed" : "no child",
        method: parsed.method,
      });
      return;
    }
    dlog("bridge", "inject→worker", { method: parsed.method, raw: previewLine(line) });
    this.child.stdin.write(line + "\n");
  }

  /**
   * Observe every worker→renderer line (e.g. to mirror onto the Mobile Web
   * Remote). Returns an unsubscribe. Taps are read-only and isolated: a
   * throwing tap never disrupts the renderer stream.
   */
  subscribeOutbound(tap: (line: string) => void): () => void {
    this.outboundTaps.add(tap);
    return () => this.outboundTaps.delete(tap);
  }

  /** cwd/sessionId of the most recent run — the default context for a mobile
   *  client that didn't specify one. */
  getLastRunContext(): { cwd?: string; sessionId?: string } {
    return this.lastRunContext;
  }

  /**
   * Tell the worker to tear down a session explicitly (on user delete). The
   * worker's agent/closeSession handler reaps that session's background
   * shells (core design §6). No-op if no live worker — then there are no
   * shells to reap. Best-effort; delete proceeds regardless.
   */
  closeSession(sessionId: string): void {
    if (!this.child?.stdin || this.child.stdin.destroyed) return;
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: `close-${sessionId}`,
      method: "agent/closeSession",
      params: { sessionId },
    });
    try {
      this.child.stdin.write(line + "\n");
    } catch {
      /* best-effort */
    }
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
