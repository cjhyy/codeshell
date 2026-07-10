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
import { SessionSnapshotStore, type Snapshot, type SnapshotEntry } from "./SessionSnapshotStore.js";
import { parseLiveStreamEnvelope, parseSnapshotAppend } from "./parseStreamLine.js";
import {
  parseBrowserActionLine,
  buildBrowserActionReply,
  parseCredentialActionLine,
  buildCredentialActionReply,
  parseWorkspaceActionLine,
  buildWorkspaceActionReply,
} from "./browser-driver/intercept.js";
import { handleBrowserAction } from "./browser-driver/automation-host.js";
import { SessionManager } from "@cjhyy/code-shell-core";
import { restoreCookiesToBrowser, type ElectronCookieLike } from "./credentials-service.js";
import { resolveCookieCredentialForBrowser } from "./credential-action.js";
import {
  buildCredentialSnapshot,
  materializeCredentialCookieForWorker,
  resolveCredentialValueForWorker,
} from "./credential-access-service.js";
import {
  activeGuestForSession,
  bucketForSession,
  focusGuestForSession,
  listGuestsForSession,
  partitionForSession,
  registerSessionBucket,
} from "./browser-driver/active-guest.js";
import { loadBrowserAutomationPolicy } from "./browser-driver/load-policy.js";
import {
  buildNoChildFallbackReply,
  compactQuerySessionId,
  forkSourceSessionId,
  quickChatForkRequest,
} from "./agent-bridge-fallback.js";
import { QuickChatForkRouter, type QuickChatForkLifecycle } from "./quick-chat-fork-router.js";
import { prepareAgentRunMetadata, resolveCredentialSessionCwd } from "./agent-run-metadata.js";
import { getTrustCachedSync } from "./trust-store.js";
import { reloadAutomations } from "./automation-service.js";
import { switchSessionWorkspaceForUi } from "./session-workspace-service.js";

/**
 * Neutral sandbox directory used when the user is in a "no project"
 * conversation. We do NOT want the agent worker booting in $HOME —
 * tools like Bash/Read/Write would then roam the entire home folder.
 * `~/.code-shell/no-repo` is created on demand and kept stable across
 * runs so the worker always lands in a contained directory.
 */
export function resolveNoRepoCwd(): string {
  const dir = join(homedir(), ".code-shell", "no-repo");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best-effort */
  }
  return dir;
}

export type { QuickChatForkLifecycle } from "./quick-chat-fork-router.js";

const require = createRequire(import.meta.url);
const agentEntry = require.resolve("@cjhyy/code-shell-core/bin/agent-server-stdio");

const RESTART_WINDOW_MS = 60_000;
const RESTART_LIMIT = 3;

function previewLine(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max} more)` : s;
}

function normalizeCredentialResolveParams(params: Record<string, unknown> | undefined): {
  cwd?: string;
  id: string;
  scope: "full" | "project";
  purpose: "use" | "mcp";
} {
  const id = typeof params?.id === "string" ? params.id : "";
  if (!id) throw new Error("credentialResolve requires id");
  const scope = params?.scope === "project" ? "project" : "full";
  const purpose = params?.purpose === "mcp" ? "mcp" : "use";
  return {
    cwd: typeof params?.cwd === "string" ? params.cwd : undefined,
    id,
    scope,
    purpose,
  };
}

function normalizeCredentialMaterializeParams(params: Record<string, unknown> | undefined): {
  cwd?: string;
  id: string;
  scope: "full" | "project";
} {
  const id = typeof params?.id === "string" ? params.id : "";
  if (!id) throw new Error("credentialMaterializeCookie requires id");
  return {
    cwd: typeof params?.cwd === "string" ? params.cwd : undefined,
    id,
    scope: params?.scope === "project" ? "project" : "full",
  };
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
  private readonly outboundTaps = new Set<
    (line: string, snapshotEntry?: SnapshotEntry & { sessionId: string }) => void
  >();
  /**
   * The cwd/sessionId of the most recent `agent/run` (from renderer OR mobile).
   * Used as the default context when a mobile client sends chat without an
   * explicit session — the phone follows whatever the desktop is working on.
   */
  private lastRunContext: { cwd?: string; sessionId?: string } = {};
  /**
   * Per-session cwd, populated on each `agent/run`. Cookie restore
   * (InjectCredential) must resolve the credential against the ORIGINATING
   * session's cwd — reading the global `lastRunContext.cwd` instead would, in a
   * shared-worker multi-tab desktop, resolve session B's cookie against session
   * A's project (injecting the wrong account's cookie when two projects share a
   * credentialId). Keyed by sessionId; cleared in forgetSession.
   */
  private sessionCwd = new Map<string, string>();
  private credentialSnapshotRevision = 0;
  private readonly credentialSnapshotCwds = new Set<string>();
  private readonly quickChatForkRouter: QuickChatForkRouter | null;

  constructor(
    window: BrowserWindow,
    private readonly oauthAccessResolver?: (req: {
      id: string;
      scope: "full";
      forceRefresh?: boolean;
    }) => Promise<{ accessToken: string; expiresAt?: string }>,
    private readonly quickChatForkLifecycle?: QuickChatForkLifecycle,
  ) {
    dlog("bridge", "ctor", { agentEntry, execPath: process.execPath });
    this.windows.add(window);
    this.quickChatForkRouter = quickChatForkLifecycle
      ? new QuickChatForkRouter(quickChatForkLifecycle)
      : null;
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
      // Internal credential access: worker asks main to resolve/materialize
      // secrets. Consumed here; never forwarded to renderer/transcript.
      if (this.maybeHandleCredentialAccessMessage(line)) return;
      // Browser automation: intercept __browser_action__ requests here (drive the
      // webview in main, reply to the worker) and DON'T forward to the renderer.
      if (this.maybeHandleBrowserAction(line)) return;
      // InjectCredential: intercept __credential_action__ (restore a cookie
      // credential into the built-in browser) here; DON'T forward to renderer.
      if (this.maybeHandleCredentialAction(line)) return;
      // Workspace switching: intercept __workspace_action__ so the worker uses
      // the same main-process service path as the UI switcher.
      if (this.maybeHandleWorkspaceAction(line)) return;
      // cron change: the worker created/deleted a cron job (agent/cronChanged);
      // reload main's scheduler so it arms immediately. DON'T forward to renderer.
      if (this.maybeHandleCronChanged(line)) return;
      const quickChatForkSettlement = this.quickChatForkRouter?.routeWorkerResponse(line) ?? null;
      let summary: Record<string, unknown> = { raw: previewLine(line) };
      try {
        const m = JSON.parse(line) as { method?: string; id?: number };
        if (m.method) summary = { method: m.method, raw: previewLine(line) };
        else if (m.id !== undefined) summary = { responseId: m.id, raw: previewLine(line) };
      } catch {
        /* keep raw */
      }
      // Mirror stream events into the per-session snapshot so a remounted
      // renderer can replay what it missed. Non-streamEvent lines yield null.
      const append = parseSnapshotAppend(line);
      const snapshotEntry = append
        ? { sessionId: append.sessionId, ...this.snapshots.append(append.sessionId, append.event) }
        : undefined;
      const liveStreamEnvelope = parseLiveStreamEnvelope(line, snapshotEntry);
      dlog("bridge", "worker→renderer", summary);
      if (liveStreamEnvelope) {
        this.safeSend("agent:streamEvent", liveStreamEnvelope);
      } else if (!quickChatForkSettlement) {
        this.safeSend("agent:msg", line);
      }
      void quickChatForkSettlement?.catch((error) =>
        dlog("bridge", "quick_chat.fork_settle_failed", { error: String(error) }),
      );
      if (!quickChatForkSettlement) {
        for (const tap of this.outboundTaps) {
          try {
            tap(line, snapshotEntry);
          } catch {
            /* a tap must never break worker streaming */
          }
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
      } catch {
        /* ignore */
      }
      this.child = null;
      this.outbox = [];
      this.failPendingQuickChatForks();
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
      this.failPendingQuickChatForks();
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

  private handleAgentRunMetadata(prepared: ReturnType<typeof prepareAgentRunMetadata>): string {
    this.spawnChild(prepared.cwd);
    this.lastRunContext = {
      cwd: prepared.cwd,
      sessionId: prepared.sessionId,
    };
    if (prepared.sessionId && prepared.cwd) {
      this.sessionCwd.set(prepared.sessionId, prepared.cwd);
    }
    if (prepared.sessionId && prepared.bucket) {
      try {
        registerSessionBucket(prepared.sessionId, prepared.bucket, prepared.browserPartition);
      } catch (err) {
        dlog("bridge", "browser.register_session_bucket_failed", { error: String(err) });
      }
    }
    this.pushCredentialSnapshot(prepared.cwd);
    return prepared.outLine;
  }

  private cwdForSessionOrThrow(sessionId: string): string {
    const cwd = resolveCredentialSessionCwd(sessionId, this.sessionCwd, (sid) =>
      this.sessionsForFallback().readCwd(sid),
    );
    this.sessionCwd.set(sessionId, cwd);
    return cwd;
  }

  private attachIpcListener(): void {
    if (this.ipcListenerAttached) return;
    this.ipcListenerAttached = true;

    ipcMain.on("agent:msg", (event, line: string) => {
      // Inspect the message: an agent/run is the only one that can trigger
      // a fresh spawn. Other messages (agent/approve, agent/cancel) only
      // make sense if the worker is already alive.
      const prepared = prepareAgentRunMetadata(
        line,
        (cwd) => getTrustCachedSync(cwd) === "trusted",
      );
      const parsed = prepared.parsed;
      // Line forwarded to the worker. Only rewritten when we inject fields
      // (agent/run trust) — everything else is passed through verbatim so we
      // don't re-serialize on the hot path.
      let outLine = line;
      const quickChatFork = quickChatForkRequest(parsed, event.sender.id);
      let quickChatForkWireId: string | undefined;
      if (quickChatFork && this.quickChatForkRouter) {
        const started = this.quickChatForkRouter.start(quickChatFork, event.sender, line);
        if (!started) return;
        outLine = started.line;
        quickChatForkWireId = started.wireId;
      }

      if (parsed.method === "agent/run") {
        outLine = this.handleAgentRunMetadata(prepared);
      } else {
        const forkSourceId = forkSourceSessionId(parsed);
        if (forkSourceId) {
          this.spawnChild(this.sessionsForFallback().readCwd(forkSourceId));
        }
        const compactSessionId = compactQuerySessionId(parsed);
        if (compactSessionId) {
          this.spawnChild(
            this.sessionsForFallback().readCwd(compactSessionId) ?? parsed.params?.cwd,
          );
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
        if (quickChatForkWireId) {
          void this.quickChatForkRouter
            ?.fail(quickChatForkWireId)
            .catch((error) =>
              dlog("bridge", "quick_chat.fork_settle_failed", { error: String(error) }),
            );
        }
        return;
      }
      dlog("bridge", "renderer→worker", { method: parsed.method, raw: previewLine(outLine) });
      this.child.stdin.write(outLine + "\n");
    });

    ipcMain.on(
      "desktop:log",
      (_event, payload: { msg: string; data?: Record<string, unknown> }) => {
        dlog("renderer", payload.msg, payload.data);
      },
    );
  }

  private failPendingQuickChatForks(): void {
    void this.quickChatForkRouter
      ?.failAll()
      .catch((error) => dlog("bridge", "quick_chat.fork_settle_failed", { error: String(error) }));
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
        if (!parsed.sessionId) {
          resultJson = JSON.stringify({
            ok: false,
            detail: "browser action missing sessionId",
          });
        } else if (!bucketForSession(parsed.sessionId)) {
          resultJson = JSON.stringify({
            ok: false,
            detail: `no browser bucket registered for session ${parsed.sessionId}`,
          });
        } else {
          resultJson = await handleBrowserAction(parsed.request, {
            activeGuest: () => activeGuestForSession(parsed.sessionId)?.guest ?? null,
            policy: loadBrowserAutomationPolicy,
            // Sensitive browser page actions are gated by the preset permission
            // rules before they reach here; permissionDefault is only UI metadata.
            // A second hard-decline at the bridge would just dead-block legit
            // flows the user already approved. So we allow at the bridge level.
            // The one bridge-only gate that still hard-enforces is
            // the DOMAIN WHITELIST: it's opt-in (empty list = allow all), and when
            // the user did set one, blocking an off-list host is the intended
            // behavior. An interactive per-action approval dialog is a follow-up.
            approve: async () => true,
            openPanel: (url) => this.openBrowserPanelForSession(parsed.sessionId, url),
            listTabs: () => listGuestsForSession(parsed.sessionId),
            switchTab: (tabId) => focusGuestForSession(parsed.sessionId, tabId),
          });
        }
      } catch (e) {
        resultJson = JSON.stringify({
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
      }
      const reply = buildBrowserActionReply(parsed, resultJson);
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(reply + "\n");
      }
    })();
    return true;
  }

  /** Intercept the worker's `agent/cronChanged` notification: reload main's
   *  cron scheduler so an AI-created/deleted job arms immediately. Returns true
   *  (consume, don't forward to renderer) when handled. */
  private maybeHandleCronChanged(line: string): boolean {
    let parsed: { method?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (parsed.method !== "agent/cronChanged") return false;
    try {
      reloadAutomations();
    } catch (err) {
      dlog("bridge", "cronChanged.reload_failed", { error: String(err) });
    }
    return true;
  }

  private maybeHandleCredentialAccessMessage(line: string): boolean {
    let parsed: {
      id?: string | number;
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      return false;
    }
    if (
      parsed.method !== "desktop/credentialResolve" &&
      parsed.method !== "desktop/credentialMaterializeCookie" &&
      parsed.method !== "desktop/oauthAccessResolve"
    ) {
      return false;
    }
    const id = parsed.id;
    if (id === undefined) return true;
    void (async () => {
      let reply: Record<string, unknown>;
      try {
        if (parsed.method === "desktop/credentialResolve") {
          reply = {
            jsonrpc: "2.0",
            id,
            result: resolveCredentialValueForWorker(
              normalizeCredentialResolveParams(parsed.params),
            ),
          };
        } else if (parsed.method === "desktop/credentialMaterializeCookie") {
          reply = {
            jsonrpc: "2.0",
            id,
            result: materializeCredentialCookieForWorker(
              normalizeCredentialMaterializeParams(parsed.params),
            ),
          };
        } else {
          if (!this.oauthAccessResolver) throw new Error("OAuth access resolver is unavailable");
          const credentialId = typeof parsed.params?.id === "string" ? parsed.params.id : "";
          if (!credentialId) throw new Error("oauthAccessResolve requires id");
          reply = {
            jsonrpc: "2.0",
            id,
            result: await this.oauthAccessResolver({
              id: credentialId,
              scope: "full",
              forceRefresh: parsed.params?.forceRefresh === true,
            }),
          };
        }
      } catch (err) {
        reply = {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        };
      }
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(JSON.stringify(reply) + "\n");
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
  private maybeHandleCredentialAction(line: string): boolean {
    const parsed = parseCredentialActionLine(line);
    if (!parsed) return false;
    void (async () => {
      let resultJson: string;
      try {
        if (parsed.action !== "injectCookie") {
          throw new Error(`unsupported credential action: ${parsed.action}`);
        }
        if (!parsed.sessionId) {
          throw new Error("credential inject missing sessionId");
        }
        const bucket = bucketForSession(parsed.sessionId);
        if (!bucket) {
          throw new Error(`no browser bucket registered for session ${parsed.sessionId}`);
        }
        // Resolve the credential against the ORIGINATING session's cwd (from the
        // parsed action's sessionId). If this process lost the in-memory map,
        // recover from persisted state.json; never fall back to lastRunContext,
        // which may belong to a different project/session.
        const sessionCwd = this.cwdForSessionOrThrow(parsed.sessionId);
        const resolved = resolveCookieCredentialForBrowser(
          sessionCwd,
          parsed.credentialId,
          parsed.credentialScope,
        );
        if (!resolved.ok) {
          resultJson = JSON.stringify({ ok: false, error: resolved.error });
        } else {
          // Inject into the exact bucket this engine session owns. If no live
          // guest is mounted, write the persistent partition directly so the
          // next panel open / app restart still sees the restored login state.
          const target = activeGuestForSession(parsed.sessionId);
          const targetPartition = partitionForSession(parsed.sessionId);
          if (!target?.guest && !targetPartition) {
            throw new Error(`no browser partition registered for session ${parsed.sessionId}`);
          }
          const targetSession = target?.guest.session ?? targetPartition ?? undefined;
          const { count } = await restoreCookiesToBrowser(
            resolved.jar as ElectronCookieLike[],
            resolved.switchMode,
            targetSession,
          );
          for (const w of BrowserWindow.getAllWindows()) {
            if (!w.isDestroyed()) w.webContents.send("browser:reload", { bucket });
          }
          resultJson = JSON.stringify({ ok: true, count });
        }
      } catch (e) {
        resultJson = JSON.stringify({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      const reply = buildCredentialActionReply(parsed, resultJson);
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(reply + "\n");
      }
    })();
    return true;
  }

  private maybeHandleWorkspaceAction(line: string): boolean {
    const parsed = parseWorkspaceActionLine(line);
    if (!parsed) return false;
    void (async () => {
      let resultJson: string;
      try {
        if (!parsed.sessionId) throw new Error("workspace action requires sessionId");
        if (parsed.action !== "switch")
          throw new Error(`unsupported workspace action: ${parsed.action}`);
        const cwd =
          this.sessionCwd.get(parsed.sessionId) ?? this.lastRunContext.cwd ?? process.cwd();
        const list = await switchSessionWorkspaceForUi(parsed.sessionId, cwd, parsed.target);
        this.safeSend("workspace:changed", {
          sessionId: parsed.sessionId,
          workspace: list.current,
          mainRoot: list.mainRoot,
        });
        resultJson = JSON.stringify(list.current);
      } catch (e) {
        resultJson = JSON.stringify({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      const reply = buildWorkspaceActionReply(parsed, resultJson);
      if (this.child?.stdin?.writable) {
        this.child.stdin.write(reply + "\n");
      }
    })();
    return true;
  }

  /**
   * Open the in-app browser panel for the originating session bucket, then wait
   * for that bucket's <webview> guest to attach. Never falls back to a globally
   * focused guest: a missing session->bucket mapping is a fail-closed error.
   */
  private async openBrowserPanelForSession(
    sessionId: string | undefined,
    url?: string,
  ): Promise<boolean> {
    if (!sessionId) return false;
    const bucket = bucketForSession(sessionId);
    if (!bucket) return false;
    const win = [...this.windows].find((w) => !w.isDestroyed());
    if (!win) return false;
    // A blank panel needs *some* URL to attach a <webview>; default to about:blank.
    win.webContents.send("browser:open-url", {
      sessionId,
      bucket,
      url: url ?? "about:blank",
    });
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const target = activeGuestForSession(sessionId);
      if (target?.guest && !target.guest.isDestroyed()) return true;
      await new Promise((r) => setTimeout(r, 150));
    }
    return !!activeGuestForSession(sessionId);
  }

  pushCredentialSnapshot(cwd?: string): void {
    if (typeof cwd === "string" && cwd) this.credentialSnapshotCwds.add(cwd);
    if (!this.child?.stdin?.writable) return;
    this.credentialSnapshotRevision += 1;
    const snapshot = buildCredentialSnapshot(
      [...this.credentialSnapshotCwds],
      this.credentialSnapshotRevision,
    );
    this.child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "desktop/credentialSnapshot",
        params: snapshot,
      }) + "\n",
    );
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
    this.sessionCwd.delete(sessionId);
  }

  hasKnownSession(sessionId: string): boolean {
    return this.sessionCwd.has(sessionId);
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
    const prepared = prepareAgentRunMetadata(line, (cwd) => getTrustCachedSync(cwd) === "trusted");
    const parsed = prepared.parsed;
    let outLine = line;
    if (parsed.method === "agent/run") {
      outLine = this.handleAgentRunMetadata(prepared);
    }
    if (!this.child?.stdin || this.child.stdin.destroyed) {
      dlog("bridge", "inject.dropped", {
        reason: this.child ? "stdin destroyed" : "no child",
        method: parsed.method,
      });
      return;
    }
    dlog("bridge", "inject→worker", { method: parsed.method, raw: previewLine(outLine) });
    this.child.stdin.write(outLine + "\n");
  }

  /**
   * Observe every worker→renderer line (e.g. to mirror onto the Mobile Web
   * Remote). Returns an unsubscribe. Taps are read-only and isolated: a
   * throwing tap never disrupts the renderer stream.
   */
  subscribeOutbound(
    tap: (line: string, snapshotEntry?: SnapshotEntry & { sessionId: string }) => void,
  ): () => void {
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

  releaseWorkspace(sessionId: string): Promise<void> {
    if (!this.child?.stdin || this.child.stdin.destroyed) return Promise.resolve();
    const id = `release-workspace-${sessionId}-${Date.now()}`;
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "agent/releaseWorkspace",
      params: { sessionId },
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        if (err) reject(err);
        else resolve();
      };
      const unsubscribe = this.subscribeOutbound((outLine) => {
        try {
          const msg = JSON.parse(outLine) as {
            id?: string | number;
            error?: { message?: string };
            result?: { ok?: boolean; error?: string };
          };
          if (msg.id === id) {
            const resultError =
              msg.result && msg.result.ok === false
                ? new Error(msg.result.error ?? "releaseWorkspace failed")
                : undefined;
            finish(
              msg.error ? new Error(msg.error.message ?? "releaseWorkspace failed") : resultError,
            );
          }
        } catch {
          /* ignore non-json worker output */
        }
      });
      const timer = setTimeout(
        () => finish(new Error(`releaseWorkspace timed out for session ${sessionId}`)),
        5000,
      );
      try {
        this.child!.stdin!.write(line + "\n");
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Feed an event produced OUTSIDE the stdio worker (e.g. an in-main automation
   *  Engine) into the same snapshot + renderer stream, so renderer reconnect works
   *  identically for automation sessions. */
  ingestExternalEvent(sessionId: string, event: unknown): void {
    const entry = this.snapshots.append(sessionId, event);
    this.safeSend("agent:streamEvent", { sessionId, event, seq: entry.seq });
  }

  /**
   * Announce a live automation session to the renderer so it can create the
   * sidebar entry under the project owning `cwd` (stream events carry no cwd).
   * Separate JSON-RPC method from `agent/streamEvent` so the shared core
   * StreamEvent shape stays untouched and the interactive path is unaffected.
   */
  broadcastAutomationSession(meta: {
    sessionId: string;
    cwd: string;
    title: string;
    prompt: string;
    cronJobId: string;
    clientMessageId?: string;
  }): void {
    this.safeSend(
      "agent:msg",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/automationSession",
        params: meta,
      }),
    );
  }

  kill(): void {
    dlog("bridge", "kill", { pid: this.child?.pid });
    this.child?.kill("SIGTERM");
  }
}
