/**
 * AgentBridge — Electron main ↔ agent worker subprocess broker.
 *
 * The transport-agnostic half (spawn/respawn of the stdio worker, line
 * framing, request/response correlation, inject semantics, crash accounting)
 * lives in WorkerBridgeCore (worker-bridge-core.ts, zero electron imports —
 * the reuse seam for other hosts like packages/server). This class is the
 * Electron adapter on top of it:
 *   - Configure the core with the desktop worker entry
 *     (@cjhyy/code-shell-core's agent-server-stdio.js run under
 *     ELECTRON_RUN_AS_NODE=1 so the Electron binary serves as Node).
 *   - Pipe worker stdout lines → renderer via
 *     window.webContents.send("agent:msg", line), with the desktop-only
 *     intercepts (browser/credential/workspace/panel actions, cron reload,
 *     pet projection) consumed in main and never forwarded.
 *   - Pipe ipcMain "agent:msg" lines from renderer → worker stdin.
 *   - Surface worker lifecycle to the renderer. Clean exits (code=0) differ
 *     from crashes; after a crash the core tracks a 3×/60s restart cap and we
 *     emit lifecycle events; but DON'T pre-emptively respawn — next user run
 *     will trigger a fresh spawn anyway.
 */

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
  parsePanelActionLine,
  buildPanelActionReply,
} from "./browser-driver/intercept.js";
import { handleBrowserAction } from "./browser-driver/automation-host.js";
import { Methods, SessionManager, type SessionWorkspace } from "@cjhyy/code-shell-core";
import type {
  PetProjectionDelta,
  PetProjectionSnapshotResult,
} from "@cjhyy/code-shell-pet";
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
import { PetWorkerProjectionGeneration } from "./pet/pet-worker-generation.js";
import type { AgentBridgePetEvent, PetStateBridge } from "./pet/pet-state-aggregator.js";
import { previewLine, WorkerBridgeCore } from "./worker-bridge-core.js";
import type {
  AgentPanelHostRequest,
  AgentPanelHostResponse,
  AgentPanelHostResult,
} from "../shared/agent-panels.js";

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
const agentEntry = require.resolve("@cjhyy/code-shell-capability-coding/bin/agent-server-stdio");

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

export class AgentBridge implements PetStateBridge {
  /** Transport-agnostic worker driver (spawn / framing / correlation). */
  private readonly core: WorkerBridgeCore;
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
  /** Sessions the CURRENT worker streamed events for (reset per spawn). */
  private workerSnapshotSessionIds = new Set<string>();
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
  private readonly petProjectionObservers = new Set<
    (event: AgentBridgePetEvent) => void | Promise<void>
  >();
  private petSnapshotRequestId = 0;
  private petHostRequestId = 0;
  private readonly petWorkerGeneration = new PetWorkerProjectionGeneration();
  private panelHostRequestId = 0;
  private readonly pendingPanelHostRequests = new Map<
    string,
    (result: AgentPanelHostResult) => void
  >();

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
    this.core = new WorkerBridgeCore({
      entryPath: agentEntry,
      buildEnv: () => ({
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        CODESHELL_AGENT_STDIO: "1",
        CODE_SHELL_CAPABILITY_MODULES:
          "@cjhyy/code-shell-arena#createArenaCapability," +
          "@cjhyy/code-shell-pet#createPetCapability",
      }),
      fallbackCwd: resolveNoRepoCwd,
      log: (event, data) => dlog("bridge", event, data),
      prepareInbound: (line) => this.prepareInboundLine(line),
      onStderr: (text) => {
        dlog("agent", "stderr", { text: previewLine(text, 800) });
        process.stderr.write(`[agent] ${text}`);
      },
      onWorkerStarted: () => {
        this.workerSnapshotSessionIds = new Set<string>();
        this.petWorkerGeneration.beginWorker();
        this.emitPetProjection({ kind: "lifecycle", state: "active" });
      },
      onSpawnFailed: () => {
        this.emitPetProjection({ kind: "lifecycle", state: "disconnected" });
        this.safeSend("agent:lifecycle", { type: "gave_up" });
      },
      onSpawnError: () => {
        this.failPendingQuickChatForks();
        // Snapshots intentionally survive worker exit — a respawn may resume
        // the same session, and a remounted renderer still needs to replay.
        this.snapshots.onWorkerExit(this.workerSnapshotSessionIds);
        this.emitPetProjection({ kind: "lifecycle", state: "disconnected" });
        this.safeSend("agent:lifecycle", { type: "gave_up" });
      },
      onExit: ({ code, clean, gaveUp }) => {
        this.failPendingQuickChatForks();
        this.snapshots.onWorkerExit(this.workerSnapshotSessionIds);
        if (clean) {
          this.emitPetProjection({ kind: "lifecycle", state: "reclaimed" });
          this.safeSend("agent:lifecycle", { type: "exited", code });
          return;
        }
        this.emitPetProjection({ kind: "lifecycle", state: "disconnected" });
        if (gaveUp) this.safeSend("agent:lifecycle", { type: "gave_up" });
        else this.safeSend("agent:lifecycle", { type: "exited", code });
      },
    });
    this.core.subscribeLines((line) => this.handleWorkerLine(line));
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
   * One worker stdout line (already framed by the core, and not consumed by
   * a core-internal correlated request). Runs the desktop intercept chain,
   * then forwards to renderer windows + outbound taps.
   */
  private handleWorkerLine(line: string): void {
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
    // Generic Panel tool: renderer owns the live registry and tab state.
    if (this.maybeHandlePanelAction(line)) return;
    // cron change: the worker created/deleted a cron job (agent/cronChanged);
    // reload main's scheduler so it arms immediately. DON'T forward to renderer.
    if (this.maybeHandleCronChanged(line)) return;
    // Pet projection is a host-only read model. Its snapshot RPC responses are
    // consumed inside WorkerBridgeCore (consume: true); the delta notification
    // is consumed here so core-shaped payloads never leak through the generic
    // renderer agent:msg channel.
    if (this.routePetProjectionLine(line)) return;
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
    if (append) this.workerSnapshotSessionIds.add(append.sessionId);
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
  }

  /** Lazily build the disk-backed SessionManager used for no-worker fallbacks. */
  private sessionsForFallback(): SessionManager {
    if (!this.fallbackSessions) this.fallbackSessions = new SessionManager();
    return this.fallbackSessions;
  }

  private handleAgentRunMetadata(prepared: ReturnType<typeof prepareAgentRunMetadata>): string {
    this.core.ensureWorker(prepared.cwd);
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

  /**
   * WorkerBridgeCore prepareInbound hook: rewrite injected lines the same way
   * the renderer IPC path does (an `agent/run` spawns the worker on demand
   * and gets trust/session metadata injected; everything else passes through
   * verbatim).
   */
  private prepareInboundLine(line: string): { line: string; method?: string } {
    const prepared = prepareAgentRunMetadata(line, (cwd) => getTrustCachedSync(cwd) === "trusted");
    const parsed = prepared.parsed;
    let outLine = line;
    if (parsed.method === "agent/run") {
      outLine = this.handleAgentRunMetadata(prepared);
    }
    return { line: outLine, method: parsed.method };
  }

  private cwdForSessionOrThrow(sessionId: string): string {
    const cwd = resolveCredentialSessionCwd(sessionId, this.sessionCwd, (sid) =>
      this.sessionsForFallback().readSessionMainRoot(sid),
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
          this.core.ensureWorker(this.sessionsForFallback().readSessionMainRoot(forkSourceId));
        }
        const compactSessionId = compactQuerySessionId(parsed);
        if (compactSessionId) {
          this.core.ensureWorker(
            this.sessionsForFallback().readSessionMainRoot(compactSessionId) ?? parsed.params?.cwd,
          );
        }
      }

      if (!this.core.canSend()) {
        // No live worker. For approve / cancel this is fine — drop.
        // For run, ensureWorker above should have created one; if it
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
          reason: this.core.hasChild() ? "stdin destroyed" : "no child",
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
      this.core.sendLine(outLine);
    });

    ipcMain.on(
      "desktop:log",
      (_event, payload: { msg: string; data?: Record<string, unknown> }) => {
        dlog("renderer", payload.msg, payload.data);
      },
    );

    ipcMain.on("panel:agent-response", (event, response: AgentPanelHostResponse) => {
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (
        !owner ||
        !this.windows.has(owner) ||
        !response ||
        typeof response.requestId !== "string"
      ) {
        return;
      }
      const resolve = this.pendingPanelHostRequests.get(response.requestId);
      if (!resolve) return;
      this.pendingPanelHostRequests.delete(response.requestId);
      resolve(response.result);
    });
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
      this.core.sendLine(buildBrowserActionReply(parsed, resultJson));
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
      this.core.sendLine(JSON.stringify(reply));
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
      this.core.sendLine(buildCredentialActionReply(parsed, resultJson));
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
      this.core.sendLine(buildWorkspaceActionReply(parsed, resultJson));
    })();
    return true;
  }

  private requestPanelHost(
    request: Omit<AgentPanelHostRequest, "requestId">,
  ): Promise<AgentPanelHostResult> {
    const requestId = `panel-host-${++this.panelHostRequestId}`;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: AgentPanelHostResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingPanelHostRequests.delete(requestId);
        resolve(result);
      };
      this.pendingPanelHostRequests.set(requestId, finish);
      const timer = setTimeout(
        () => finish({ ok: false, panelId: request.panelId, detail: "panel host timed out" }),
        5_000,
      );
      this.safeSend("panel:agent-request", { ...request, requestId });
    });
  }

  private maybeHandlePanelAction(line: string): boolean {
    const parsed = parsePanelActionLine(line);
    if (!parsed) return false;
    void (async () => {
      let result: AgentPanelHostResult;
      if (!parsed.sessionId) {
        result = { ok: false, panelId: parsed.panelId, detail: "panel action requires sessionId" };
      } else {
        const bucket = bucketForSession(parsed.sessionId);
        if (!bucket) {
          result = {
            ok: false,
            panelId: parsed.panelId,
            detail: `no panel bucket registered for session ${parsed.sessionId}`,
          };
        } else {
          result = await this.requestPanelHost({
            sessionId: parsed.sessionId,
            bucket,
            action: parsed.action,
            panelId: parsed.panelId,
          });
        }
      }
      this.core.sendLine(buildPanelActionReply(parsed, JSON.stringify(result)));
    })();
    return true;
  }

  /**
   * Consume the worker's `agent/petProjectionDelta` notification (the pet
   * projection is a host-only read model — it must never leak through the
   * generic renderer agent:msg channel). Snapshot RPC responses are already
   * correlated + consumed inside WorkerBridgeCore.
   */
  private routePetProjectionLine(line: string): boolean {
    let message: {
      method?: string;
      params?: unknown;
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return false;
    }
    if (message.method !== Methods.PetProjectionDelta) return false;
    const delta = message.params as Partial<PetProjectionDelta> | undefined;
    if (
      delta &&
      typeof delta.workerGeneration === "number" &&
      typeof delta.version === "number" &&
      typeof delta.observedAt === "number" &&
      typeof delta.kind === "string"
    ) {
      this.emitPetProjection({
        kind: "delta",
        delta: this.petWorkerGeneration.normalizeDelta(delta as PetProjectionDelta),
      });
    }
    return true;
  }

  private emitPetProjection(event: AgentBridgePetEvent): void {
    for (const observer of this.petProjectionObservers) {
      try {
        void Promise.resolve(observer(event)).catch((error) =>
          dlog("bridge", "pet_projection.observer_failed", { error: String(error) }),
        );
      } catch (error) {
        dlog("bridge", "pet_projection.observer_failed", { error: String(error) });
      }
    }
  }

  hasLiveWorker(): boolean {
    return this.core.hasLiveWorker();
  }

  async requestPetProjectionSnapshot(): Promise<PetProjectionSnapshotResult | null> {
    if (!this.hasLiveWorker()) return null;
    const id = `desktop-pet-snapshot-${++this.petSnapshotRequestId}`;
    const outcome = await this.core.request(Methods.GetPetProjectionSnapshot, undefined, {
      id,
      timeoutMs: 5_000,
      consume: true,
      settleOnExit: true,
      failFast: true,
    });
    if (outcome.status !== "result" || !outcome.result) return null;
    return this.petWorkerGeneration.normalizeSnapshot(
      outcome.result as PetProjectionSnapshotResult,
    );
  }

  subscribePetProjection(
    observer: (event: AgentBridgePetEvent) => void | Promise<void>,
  ): () => void {
    this.petProjectionObservers.add(observer);
    return () => this.petProjectionObservers.delete(observer);
  }

  async requestWorker(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = 120_000,
  ): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: number }> {
    const id = `desktop-pet-host-${++this.petHostRequestId}`;
    // consume: false — the response line still flows to renderer + taps, like
    // any other worker output. failFast unset — a dropped send waits out the
    // timeout, matching the old inject-then-wait semantics.
    //
    // agent/run is the only method that may spawn the worker on demand, exactly
    // as the renderer's "agent:msg" path does. Without this a pet/IM-gateway
    // agent/run to a lazily-unspawned worker is dropped and hangs to timeout
    // ("Mimi 正在整理…" forever; WeChat messages never answered).
    const ensureWorker = method === "agent/run";
    const cwd = typeof params.cwd === "string" ? params.cwd : undefined;
    const outcome = await this.core.request(method, params, {
      id,
      timeoutMs,
      ...(ensureWorker ? { ensureWorker: true, ...(cwd ? { ensureWorkerCwd: cwd } : {}) } : {}),
    });
    switch (outcome.status) {
      case "result":
        return { ok: true, result: outcome.result };
      case "error":
        return {
          ok: false,
          message: outcome.error.message ?? "worker rejected the request",
          code: outcome.error.code,
        };
      default:
        return { ok: false, message: "worker did not respond" };
    }
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
    if (!this.core.hasLiveWorker()) return;
    this.credentialSnapshotRevision += 1;
    const snapshot = buildCredentialSnapshot(
      [...this.credentialSnapshotCwds],
      this.credentialSnapshotRevision,
    );
    this.core.sendLine(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "desktop/credentialSnapshot",
        params: snapshot,
      }),
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

  /** Reserve a main-owned Session before a headless producer submits agent/run. */
  reserveHostSession(sessionId: string, cwd: string): void {
    this.sessionCwd.set(sessionId, cwd);
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
    this.core.injectWorkerMessage(line);
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
   * shells to reap. With a live worker, resolve only after its close ACK so a
   * caller can safely remove the session directory afterward.
   */
  async closeSession(sessionId: string): Promise<void> {
    if (!this.core.canSend()) return;
    const id = `close-${sessionId}-${Date.now()}`;
    const outcome = await this.core.request(
      "agent/closeSession",
      { sessionId },
      { id, timeoutMs: 30_000, failFast: true },
    );
    switch (outcome.status) {
      case "result": {
        const result = outcome.result as { ok?: boolean; error?: string } | undefined;
        if (result && result.ok === false) {
          throw new Error(result.error ?? "closeSession failed");
        }
        return;
      }
      case "error":
        throw new Error(outcome.error.message ?? "closeSession failed");
      case "timeout":
        throw new Error(`closeSession timed out for session ${sessionId}`);
      case "sendFailed":
        throw outcome.error instanceof Error
          ? outcome.error
          : new Error(String(outcome.error ?? "closeSession failed: no live worker"));
      default:
        throw new Error("closeSession failed: worker exited");
    }
  }

  async releaseWorkspace(sessionId: string): Promise<void> {
    if (!this.core.canSend()) return;
    const id = `release-workspace-${sessionId}-${Date.now()}`;
    const outcome = await this.core.request(
      "agent/releaseWorkspace",
      { sessionId },
      { id, timeoutMs: 5_000, failFast: true },
    );
    switch (outcome.status) {
      case "result": {
        const result = outcome.result as { ok?: boolean; error?: string } | undefined;
        if (result && result.ok === false) {
          throw new Error(result.error ?? "releaseWorkspace failed");
        }
        return;
      }
      case "error":
        throw new Error(outcome.error.message ?? "releaseWorkspace failed");
      case "timeout":
        throw new Error(`releaseWorkspace timed out for session ${sessionId}`);
      case "sendFailed":
        throw outcome.error instanceof Error
          ? outcome.error
          : new Error(String(outcome.error ?? "releaseWorkspace failed: no live worker"));
      default:
        throw new Error("releaseWorkspace failed: worker exited");
    }
  }

  async setWorkspace(sessionId: string, workspace: SessionWorkspace): Promise<void> {
    if (!this.core.canSend()) {
      throw new Error(`no live worker for session ${sessionId}`);
    }
    const response = await this.requestWorker(
      Methods.SetWorkspace,
      { sessionId, workspace },
      5_000,
    );
    if (!response.ok) throw new Error(response.message);
    const result = response.result as { ok?: boolean; workspace?: SessionWorkspace | null };
    if (result.ok !== true || !result.workspace) {
      throw new Error(`worker could not rebase workspace for session ${sessionId}`);
    }
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

  /** Announce a Work Session created directly by Mimi's main-process host. */
  broadcastPetDelegationSession(meta: {
    sessionId: string;
    cwd: string;
    title: string;
    prompt: string;
    clientMessageId: string;
  }): void {
    this.safeSend(
      "agent:msg",
      JSON.stringify({
        jsonrpc: "2.0",
        method: "agent/petDelegationSession",
        params: meta,
      }),
    );
  }

  kill(): void {
    this.core.kill();
  }
}
