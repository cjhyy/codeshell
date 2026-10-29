import {
  SessionManager,
  sessionsRoot,
  type OutputHistoryRecoveryAcceptance,
  type OutputHistoryRecoveryPlan,
  type OutputHistoryRecoveryResult,
} from "@cjhyy/code-shell-core";
import {
  OutputHistoryRecovery,
  listBackgroundWorkForUI,
  notificationQueue,
  type OutputHistoryRecoveryEvidence,
} from "@cjhyy/code-shell-core/internal";
import { outputHistoryCacheEvidence } from "./session-output-history-evidence.js";
import type { AgentBridge } from "./agent-bridge.js";
import type { ExternalRuntimeService } from "./external-runtime-service.js";
import {
  acquireOutputHistoryRecovery,
  assertOutputHistoryWriteAvailable,
} from "./session-output-history-lease.js";

export type OutputHistoryRecoveryCaller =
  | { kind: "desktop"; webContentsId: number }
  | { kind: "mobile"; viewerId: string; deviceId: string };
export interface OutputHistoryRecoveryAuthorization {
  key: string;
  /** The actual pre-existing Session owner; absent for a legitimate cold Session. */
  ownerWebContentsId?: number;
  projectId: string | null;
  assertCurrent(): void;
}
type RecoveryBridge = Pick<
  AgentBridge,
  "isSessionRunning" | "getSnapshot" | "quiesceForOutputRecovery" | "resetOutputHistoryRecovery"
>;
type RecoveryExternal = Pick<
  ExternalRuntimeService,
  "assertOutputRecoveryIdle" | "quiesceForOutputRecovery"
>;

/** Shared trusted Desktop/mobile endpoint. Client payloads never supply storage paths or authority. */
export class SessionOutputHistoryRecovery {
  private readonly evidenceFiles = new Map<string, OutputHistoryRecoveryEvidence[]>();
  private readonly recovery: OutputHistoryRecovery;
  private readonly pendingRetirement = new Map<string, () => void>();
  constructor(
    private readonly deps: {
      bridge: () => RecoveryBridge | null;
      external: () => RecoveryExternal | null;
      authorize: (
        sessionId: string,
        caller: OutputHistoryRecoveryCaller,
      ) => Promise<OutputHistoryRecoveryAuthorization>;
      /** All viewers/approvals for this Session, not only the caller's tab. */
      retire: (sessionId: string) => void;
      /** Only for synthetic tests; production always checks the actual registries. */
      assertBackgroundIdle?: (sessionId: string) => void;
    },
  ) {
    this.recovery = new OutputHistoryRecovery(() => sessionsRoot(), {
      evidence: (sessionId) => this.evidenceFiles.get(sessionId) ?? [],
    });
  }
  private assertIdle(sessionId: string, owner?: number) {
    const bridge = this.deps.bridge();
    if (bridge?.isSessionRunning(sessionId) || bridge?.getSnapshot(sessionId).topLevelRunning)
      throw new Error("busy");
    this.deps.external()?.assertOutputRecoveryIdle(sessionId, owner);
    if (this.deps.assertBackgroundIdle) this.deps.assertBackgroundIdle(sessionId);
    else {
      const active = listBackgroundWorkForUI(sessionId).some((entry) =>
        ["starting", "running", "cancelling", "unknown"].includes(
          entry.kind === "shell" ? entry.shell.status : entry.status,
        ),
      );
      if (active || notificationQueue.getSnapshot(sessionId).length) throw new Error("busy");
    }
  }
  private authority(sessionId: string, authorized: OutputHistoryRecoveryAuthorization) {
    const manager = new SessionManager();
    const generation = manager.registerSessionGeneration(sessionId);
    return {
      key: JSON.stringify([authorized.key, generation]),
      assertCurrent: () => {
        authorized.assertCurrent();
        if (!manager.isSessionGenerationCurrent(sessionId)) throw new Error("stale");
      },
    };
  }
  private retire(sessionId: string): boolean {
    try {
      this.deps.bridge()?.resetOutputHistoryRecovery(sessionId);
      this.deps.retire(sessionId);
      this.pendingRetirement.get(sessionId)?.();
      this.pendingRetirement.delete(sessionId);
      return true;
    } catch {
      return false;
    }
  }
  async plan(
    sessionId: string,
    caller: OutputHistoryRecoveryCaller,
  ): Promise<OutputHistoryRecoveryPlan> {
    let authorized: OutputHistoryRecoveryAuthorization;
    try {
      authorized = await this.deps.authorize(sessionId, caller);
      authorized.assertCurrent();
    } catch {
      return { status: "blocked", sessionId, reason: "unavailable" };
    }
    if (this.pendingRetirement.has(sessionId))
      return {
        status: "blocked",
        sessionId,
        reason: this.retire(sessionId) ? "not_needed" : "storage_error",
      };
    try {
      assertOutputHistoryWriteAvailable(sessionId);
      this.assertIdle(sessionId, authorized.ownerWebContentsId);
    } catch {
      return { status: "blocked", sessionId, reason: "busy" };
    }
    try {
      const files = await outputHistoryCacheEvidence(sessionId, authorized.projectId);
      authorized.assertCurrent();
      assertOutputHistoryWriteAvailable(sessionId);
      this.assertIdle(sessionId, authorized.ownerWebContentsId);
      this.evidenceFiles.set(sessionId, files);
      return this.recovery.plan(sessionId, this.authority(sessionId, authorized));
    } catch {
      return { status: "blocked", sessionId, reason: "unavailable" };
    } finally {
      this.evidenceFiles.delete(sessionId);
    }
  }
  async apply(
    sessionId: string,
    input: OutputHistoryRecoveryAcceptance,
    caller: OutputHistoryRecoveryCaller,
  ): Promise<OutputHistoryRecoveryResult> {
    if (input?.acceptHistoricalGap !== true)
      return { status: "blocked", sessionId, reason: "confirmation_required" };
    let authorized: OutputHistoryRecoveryAuthorization;
    try {
      authorized = await this.deps.authorize(sessionId, caller);
      authorized.assertCurrent();
    } catch {
      return { status: "blocked", sessionId, reason: "unavailable" };
    }
    let release: (() => void) | undefined;
    try {
      this.assertIdle(sessionId, authorized.ownerWebContentsId);
      const files = await outputHistoryCacheEvidence(sessionId, authorized.projectId);
      authorized.assertCurrent();
      this.assertIdle(sessionId, authorized.ownerWebContentsId);
      this.evidenceFiles.set(sessionId, files);
      const authority = this.authority(sessionId, authorized);
      const validated = this.recovery.validate(sessionId, input, authority);
      if (validated) {
        if (
          validated.status === "applied" &&
          this.pendingRetirement.has(sessionId) &&
          !this.retire(sessionId)
        )
          return { status: "blocked", sessionId, reason: "storage_error" };
        return validated;
      }
      release = acquireOutputHistoryRecovery(sessionId);
      await this.deps
        .external()
        ?.quiesceForOutputRecovery(sessionId, authorized.ownerWebContentsId);
      authority.assertCurrent();
      this.assertIdle(sessionId, authorized.ownerWebContentsId);
      await this.deps.bridge()?.quiesceForOutputRecovery(sessionId);
      authority.assertCurrent();
      this.assertIdle(sessionId, authorized.ownerWebContentsId);
      const result = this.recovery.apply(sessionId, input, authority);
      if (result.status === "applied") {
        // No old Main writer, pending approval or viewer cursor may cross the
        // accepted checkpoint. This does not create input or execute tools.
        new SessionManager().incrementSessionGeneration(sessionId);
        this.pendingRetirement.set(sessionId, release);
        release = undefined;
        if (!this.retire(sessionId))
          return { status: "blocked", sessionId, reason: "storage_error" };
      }
      return result;
    } catch {
      return { status: "blocked", sessionId, reason: "busy" };
    } finally {
      this.evidenceFiles.delete(sessionId);
      release?.();
    }
  }
}
