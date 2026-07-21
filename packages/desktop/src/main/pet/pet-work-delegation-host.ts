import { createHash } from "node:crypto";
import {
  injectMobileRunAndAwaitAcceptance,
  type MobileRunBridge,
} from "@cjhyy/code-shell-server/mobile-remote";
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
    const sessionId =
      delegation.targetSessionId ?? petDelegationSessionId(delegation.clientMessageId);
    const cwd = delegation.workspacePath ?? this.options.noWorkspaceCwd;
    const runId = `pet-delegation-run-${delegationKey(delegation.clientMessageId)}`;
    const workClientMessageId = `pet-delegation:${delegationKey(delegation.clientMessageId)}`;
    const wasKnownToHost = this.options.bridge.hasKnownSession(sessionId);
    // Only a brand-new Session needs a host cwd reservation. A reused Session
    // already has its own real cwd registered; overwriting it with this
    // delegation's workspace-derived cwd would corrupt later cwd lookups
    // (credentials, browser partition) — especially if the reuse run is then
    // rejected and the entry is intentionally kept.
    if (!wasKnownToHost) this.options.bridge.reserveHostSession(sessionId, cwd);
    const acceptance = await injectMobileRunAndAwaitAcceptance(this.options.bridge, {
      id: runId,
      params: {
        task: delegation.task,
        sessionId,
        cwd,
        clientMessageId: workClientMessageId,
        permissionMode: "default",
        // Goal is opt-in. Ordinary Work Sessions can still use tools, span many
        // model/tool steps, and resume from async notifications; forcing every
        // loosely-worded delegation into persistent Goal mode caused ambiguous
        // objectives to keep re-driving instead of returning a useful result.
        ...(delegation.goalObjective ? { goal: delegation.goalObjective } : {}),
        ...(delegation.targetSessionId ? { requireExisting: true } : {}),
      },
    });
    if (!acceptance.ok) {
      if (!wasKnownToHost) this.options.bridge.forgetSession(sessionId);
      throw new Error(acceptance.message);
    }
    this.options.bridge.broadcastPetDelegationSession({
      sessionId,
      cwd,
      title: delegationTitle(delegation.task),
      prompt: delegation.task,
      clientMessageId: workClientMessageId,
    });
    return { sessionId, cwd };
  }
}
