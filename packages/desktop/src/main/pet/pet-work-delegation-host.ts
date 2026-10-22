import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  injectMobileRunAndAwaitAcceptance,
  type MobileRunBridge,
} from "@cjhyy/code-shell-server/mobile-remote";
import { markAttachmentsSent } from "@cjhyy/code-shell-server/storage";
import { preparePetDelegationAttachments } from "./pet-delegation-attachments.js";
import type { PetAutoDelegation } from "./pet-dispatch-service.js";

export interface PetWorkDelegationLaunch {
  sessionId: string;
  cwd: string;
}

interface PetWorkDelegationBridge extends MobileRunBridge {
  hasKnownSession(sessionId: string): boolean;
  reserveHostSession(sessionId: string, cwd: string): void;
  forgetSession(sessionId: string): void;
  broadcastPetDelegationSession(meta: {
    sessionId: string;
    cwd: string;
    title: string;
    prompt: string;
    clientMessageId: string;
  }): void;
}

function delegationKey(clientMessageId: string): string {
  return createHash("sha256").update(clientMessageId).digest("hex").slice(0, 24);
}

export function petDelegationSessionId(clientMessageId: string): string {
  return `pet-work-${delegationKey(clientMessageId)}`;
}

export function petDelegationClientMessageId(clientMessageId: string): string {
  return `pet-delegation:${delegationKey(clientMessageId)}`;
}

function delegationTitle(task: string): string {
  return task.replace(/\s+/g, " ").trim().slice(0, 60) || "Mimi delegated work";
}

/**
 * Main-process execution boundary for Mimi's DelegateWork tool. A validated
 * decision becomes a normal worker Session here; renderer availability only
 * affects whether the new Session is visible immediately, never whether it runs.
 */
export class PetWorkDelegationHost {
  private readonly launches = new Map<string, Promise<PetWorkDelegationLaunch>>();

  constructor(
    private readonly options: {
      bridge: PetWorkDelegationBridge;
      noWorkspaceCwd: string;
      /** Persisted effective workspace of an existing Session, supplied by the Host. */
      resolveSessionCwd?: (sessionId: string) => Promise<string | undefined>;
    },
  ) {}

  start(delegation: PetAutoDelegation): Promise<PetWorkDelegationLaunch> {
    const existing = this.launches.get(delegation.clientMessageId);
    if (existing) return existing;
    const launch = this.startOnce(delegation).catch((error) => {
      this.launches.delete(delegation.clientMessageId);
      throw error;
    });
    this.launches.set(delegation.clientMessageId, launch);
    if (this.launches.size > 500) {
      const oldest = this.launches.keys().next().value;
      if (oldest && oldest !== delegation.clientMessageId) this.launches.delete(oldest);
    }
    return launch;
  }

  private async startOnce(delegation: PetAutoDelegation): Promise<PetWorkDelegationLaunch> {
    if (delegation.executionBackend === "codex") {
      throw new Error(
        "The external Codex execution backend is not supported; CodeShell substitution was refused",
      );
    }
    const sessionId =
      delegation.targetSessionId ?? petDelegationSessionId(delegation.clientMessageId);
    let cwd = delegation.workspacePath ?? this.options.noWorkspaceCwd;
    if (delegation.targetSessionId && delegation.inputAttachments) {
      // Core resumes an existing Session in its persisted workspace. A main
      // project selector is insufficient when that Session uses a worktree.
      const existingCwd = await this.options.resolveSessionCwd?.(sessionId);
      if (!existingCwd || !isAbsolute(existingCwd)) {
        throw new Error(
          "Mimi image handoff failed: the existing Work Session directory is unavailable",
        );
      }
      cwd = existingCwd;
    }
    const runId = `pet-delegation-run-${delegationKey(delegation.clientMessageId)}`;
    const workClientMessageId = petDelegationClientMessageId(delegation.clientMessageId);
    const wasKnownToHost = this.options.bridge.hasKnownSession(sessionId);
    // Only a brand-new Session needs a host cwd reservation. A reused Session
    // already has its own real cwd registered; overwriting it with this
    // delegation's workspace-derived cwd would corrupt later cwd lookups
    // (credentials, browser partition) — especially if the reuse run is then
    // rejected and the entry is intentionally kept.
    if (!wasKnownToHost) this.options.bridge.reserveHostSession(sessionId, cwd);
    let prepared: Awaited<ReturnType<typeof preparePetDelegationAttachments>>;
    try {
      prepared = await preparePetDelegationAttachments({
        task: delegation.task,
        cwd,
        sessionId,
        inputAttachments: delegation.inputAttachments,
      });
      const acceptance = await injectMobileRunAndAwaitAcceptance(
        this.options.bridge,
        {
          id: runId,
          params: {
            task: prepared.task,
            sessionId,
            cwd,
            clientMessageId: workClientMessageId,
            ...(prepared.attachments.length > 0 ? { attachments: prepared.attachments } : {}),
            // Delegation does not grant Mimi authority to bypass the user's normal
            // permission and sensitive-path boundaries. A run that needs approval
            // remains visible as waiting instead of silently receiving full access.
            permissionMode: "default",
            // Goal is opt-in. Ordinary Work Sessions can still use tools, span many
            // model/tool steps, and resume from async notifications; forcing every
            // loosely-worded delegation into persistent Goal mode caused ambiguous
            // objectives to keep re-driving instead of returning a useful result.
            ...(delegation.goalContinuation
              ? { goalContinuation: delegation.goalContinuation }
              : delegation.goalObjective
                ? { goal: delegation.goalObjective }
                : {}),
            ...(delegation.targetSessionId ? { requireExisting: true } : {}),
          },
        },
        { origin: "host", producer: "pet-work-delegation" },
      );
      if (!acceptance.ok) throw new Error(acceptance.message);
    } catch (error) {
      if (!wasKnownToHost) this.options.bridge.forgetSession(sessionId);
      throw error;
    }
    // Acceptance owns the run now. A retention-write failure must not turn an
    // accepted launch into a retry that could execute the same task twice.
    await markAttachmentsSent(cwd, sessionId, prepared.attachments).catch(() => undefined);
    this.options.bridge.broadcastPetDelegationSession({
      sessionId,
      cwd,
      title: delegationTitle(delegation.task),
      prompt: prepared.task,
      clientMessageId: workClientMessageId,
    });
    return { sessionId, cwd };
  }
}
