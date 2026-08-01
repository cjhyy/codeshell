/**
 * Desktop wiring for external Agent Runtimes (Codex / Claude Code).
 *
 * Desktop main is the composition root the design calls for (§7.4): it is the only
 * layer that knows the window that owns a session, whether the project is trusted,
 * and which feature flags are on. Everything security-relevant is resolved HERE
 * and passed down explicitly — the layers below deliberately refuse to default it.
 *
 * Two host-side obligations that only Desktop can meet:
 *
 *  1. **Owner claim.** `Panel.invoke` refuses to broadcast, so a session with no
 *     owning renderer window cannot invoke a Panel App tool at all. An external
 *     runtime's turns never pass through `agent/run`, so nothing claims an owner
 *     implicitly — this service claims it explicitly (§9.3.2).
 *  2. **Trust.** `permissions` is the first `DANGEROUS_PROJECT_FIELD`; an
 *     untrusted project's rules must be stripped. Desktop owns the trust store,
 *     so it resolves the real value rather than letting a default decide.
 */
import type { BrowserWindow } from "electron";
import { startExternalRuntimeSession } from "@cjhyy/code-shell-capability-coding/external-runtimes";
import type {
  ExternalRuntimeKind,
  ExternalRuntimeSession,
} from "@cjhyy/code-shell-capability-coding/external-runtimes";
import { BUILTIN_AGENT_PRESETS, ToolRegistry, type StreamEvent } from "@cjhyy/code-shell-core";
import { isFeatureEnabled, type FeatureFlagOverrides } from "@cjhyy/code-shell-core/extension";
import { getTrustCachedSync } from "./trust-store.js";
import { dlog } from "./desktop-logger.js";

export interface ExternalRuntimeStartRequest {
  kind: ExternalRuntimeKind;
  sessionId: string;
  cwd: string;
  model?: string;
  /** The renderer window that owns this session's host-loopback surface. */
  ownerWindow?: BrowserWindow;
}

export interface ExternalRuntimeServiceDeps {
  /** Resolved feature flags for this workspace. */
  featureFlags: () => FeatureFlagOverrides;
  /**
   * Register a session that main owns but `agent/run` never created
   * (AgentBridge.registerExternalSession): reserves the session, registers its
   * browser bucket, and claims the panel owner when there is a window.
   *
   * Paired with `releaseExternalSession` — both halves come from the same
   * object so the several registries they touch cannot be half-updated.
   */
  registerSession: (sessionId: string, cwd: string, webContentsId?: number) => void;
  /** Undo registerSession (AgentBridge.releaseExternalSession). */
  releaseSession: (sessionId: string) => void;
  /** Forward translated events to the renderer. */
  emit: (sessionId: string, event: StreamEvent) => void;
  /** Host seams the exposed tools need (panels, browser, …). */
  toolContextOverrides?: (sessionId: string) => Record<string, unknown>;
}

/**
 * Owns the live external-runtime sessions for this Desktop process.
 *
 * One session per business session id; starting a second for the same id closes
 * the first, because two runtimes writing the same session would interleave turns.
 */
export class ExternalRuntimeService {
  private readonly sessions = new Map<string, ExternalRuntimeSession>();

  constructor(private readonly deps: ExternalRuntimeServiceDeps) {}

  /** Whether the product currently permits an external runtime at all. */
  isEnabled(): boolean {
    return isFeatureEnabled(this.deps.featureFlags(), "external_agent_runtime");
  }

  /** Whether CodeShell tools may be exposed to it. Separate flag, on purpose. */
  areHostToolsEnabled(): boolean {
    return isFeatureEnabled(this.deps.featureFlags(), "external_host_tools");
  }

  get(sessionId: string): ExternalRuntimeSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Start (or restart) an external-runtime session.
   *
   * Refuses when the feature flag is off rather than silently falling back to the
   * native Engine: a caller that asked for Codex and got the native engine without
   * being told would be debugging the wrong thing.
   */
  async start(request: ExternalRuntimeStartRequest): Promise<ExternalRuntimeSession> {
    if (!this.isEnabled()) {
      throw new Error(
        "External Agent Runtimes are disabled. Enable the `external_agent_runtime` " +
          "feature flag to run a session on Codex or Claude Code.",
      );
    }

    // Replacing an existing session: close the old one first so two runtimes
    // cannot interleave turns on the same business session.
    await this.stop(request.sessionId);

    // Trust is resolved HERE, from the store Desktop owns. `permissions` is the
    // first DANGEROUS_PROJECT_FIELD, so an untrusted project's rules must be
    // stripped — and the layers below deliberately have no default for this.
    const projectTrusted = getTrustCachedSync(request.cwd) === "trusted";

    // Host tools are gated by their OWN flag, so the runtime can be trialled with
    // no tool surface at all (§20). An empty allowlist is the honest expression of
    // "off" — the bridge still exists, it just advertises nothing.
    const exposure = this.areHostToolsEnabled()
      ? undefined // the reviewed first-phase allowlist
      : { mode: "allowlist" as const, toolNames: new Set<string>() };

    // Register BEFORE the runtime starts: a host tool call on the very first
    // turn would otherwise find no bucket and no owning window, and fail with
    // "no panel bucket registered" rather than doing its job (§9.3.2).
    const ownerId = request.ownerWindow?.webContents.id;
    this.deps.registerSession(request.sessionId, request.cwd, ownerId);

    const session = await startExternalRuntimeSession({
      kind: request.kind,
      cwd: request.cwd,
      businessSessionId: request.sessionId,
      registry: new ToolRegistry({}),
      permissionMode: "default",
      presetRules: BUILTIN_AGENT_PRESETS.general.defaultPermissionRules,
      projectTrusted,
      planMode: false,
      visibility: {
        cwd: request.cwd,
        hasGoal: false,
        host: "desktop",
        isSubAgent: false,
        sessionId: request.sessionId,
      },
      ...(exposure ? { exposure } : {}),
      ...(request.model ? { model: request.model } : {}),
      ...(this.deps.toolContextOverrides
        ? { contextOverrides: this.deps.toolContextOverrides(request.sessionId) as never }
        : {}),
      hooks: {
        onEvent: (event) => this.deps.emit(request.sessionId, event),
      },
      log: (event, data) => dlog("external-runtime", event, data),
    });

    this.sessions.set(request.sessionId, session);
    dlog("external-runtime", "session.started", {
      kind: request.kind,
      sessionId: request.sessionId,
      projectTrusted,
      hostToolsEnabled: this.areHostToolsEnabled(),
      exposedToolCount: session.listTools().length,
      hasOwnerWindow: ownerId !== undefined,
    });
    return session;
  }

  async send(sessionId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`no external runtime session for ${sessionId}`);
    const turn = await session.send(text);
    await turn.done;
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.interrupt();
  }

  /** Close one session. Safe when there is none. */
  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      await session.close();
    } finally {
      // In `finally` because a close() that throws must still release the host
      // registries — otherwise the bucket and the reserved session leak for the
      // life of the process, and a later session reusing the id inherits them.
      this.deps.releaseSession(sessionId);
    }
    dlog("external-runtime", "session.stopped", { sessionId });
  }

  /**
   * Close every session. Must run on app quit: each session holds a child process
   * and a listening port, and neither dies with the parent on Windows.
   */
  async stopAll(): Promise<void> {
    const ids = [...this.sessions.keys()];
    await Promise.all(ids.map((id) => this.stop(id)));
  }
}
