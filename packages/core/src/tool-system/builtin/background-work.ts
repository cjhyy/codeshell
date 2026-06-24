/**
 * Unified view over the THREE kinds of async background work — background
 * sub-agents (asyncAgentRegistry), background jobs / video polls
 * (backgroundJobRegistry), and background shells (backgroundShellManager).
 *
 * Used by the goal-stop-hook to show the judge LLM what's still running, so it
 * can tell "the goal is done except for a finite task that will wake me" (a
 * download / video render → allow stop, wait for the wakeup) from "a long-lived
 * service that the goal doesn't depend on" (a dev server → judge the goal
 * normally). Replacing the old mechanical `hasRunningForSession` short-circuit:
 * a boolean can't distinguish a finite download from a never-ending dev server,
 * but the judge — given each task's kind + command — can.
 */
import { asyncAgentRegistry, type AsyncAgentStatus } from "./agent-registry.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { backgroundShellManager, type BgShell } from "../../runtime/background-shell.js";

export type BackgroundWorkKind = "subagent" | "job" | "shell";

export interface BackgroundWorkItem {
  kind: BackgroundWorkKind;
  /** Human description for the judge (sub-agent task / video prompt / shell command). */
  description: string;
  /**
   * For kind === "shell": a port the shell is listening on, if detected. A
   * listening port is a strong signal the shell is a long-lived service (dev
   * server) rather than a finite task — fed to the judge so it doesn't mistake
   * `make serve` / an opaquely-named server script for something to "wait on".
   */
  detectedPort?: number;
}

/** List every still-running background work item spawned by `sessionId`. */
export function listRunningBackgroundWork(sessionId: string): BackgroundWorkItem[] {
  const items: BackgroundWorkItem[] = [];

  for (const a of asyncAgentRegistry.listForSession(sessionId)) {
    if (a.status === "running") {
      items.push({
        kind: "subagent",
        description: a.description || a.name || a.agentType || "(background sub-agent)",
      });
    }
  }

  for (const j of backgroundJobRegistry.listForSession(sessionId)) {
    items.push({ kind: "job", description: j.description || "(background job)" });
  }

  for (const s of backgroundShellManager.listForSession(sessionId)) {
    if (s.status === "running" || s.status === "starting") {
      items.push({
        kind: "shell",
        description: s.command,
        ...(s.detectedPort != null ? { detectedPort: s.detectedPort } : {}),
      });
    }
  }

  return items;
}

// ─── UI-oriented listing ──────────────────────────────────────────────────
//
// `listRunningBackgroundWork` above is intentionally lossy — it exists to give
// the goal judge a flat "what's still running" description list. The desktop
// background panel needs richer, addressable rows (ids, status, timing) so it
// can group by kind, show finished items briefly, and drive per-item actions.
// This second listing serves that, leaving the judge contract untouched.

/** One background-work row for the desktop panel, discriminated by `kind`. */
export type BackgroundWorkEntry =
  | {
      kind: "shell";
      /** Full shell snapshot — the panel already renders this shape (output/kill
       *  still go through the dedicated agent/backgroundShells RPC by shellId). */
      shell: BgShell;
    }
  | {
      kind: "subagent";
      agentId: string;
      name?: string;
      agentType?: string;
      description: string;
      status: AsyncAgentStatus;
      startedAt: number;
      finishedAt?: number;
    }
  | {
      kind: "job";
      jobId: string;
      description: string;
    };

/**
 * Every background-work item spawned by `sessionId`, with per-kind detail, for
 * the desktop panel. Includes finished sub-agents that are still within their
 * fade window (so a just-completed agent doesn't vanish before the user sees
 * it); shells carry their own terminal status and the panel decides how long to
 * keep them. Jobs are only ever present while running (the registry drops them
 * on finish).
 */
export function listBackgroundWorkForUI(sessionId: string): BackgroundWorkEntry[] {
  const entries: BackgroundWorkEntry[] = [];

  for (const s of backgroundShellManager.listForSession(sessionId)) {
    entries.push({ kind: "shell", shell: s });
  }

  const now = Date.now();
  for (const a of asyncAgentRegistry.listForSession(sessionId)) {
    // Keep running agents, plus finished ones still inside their fade window so
    // a completion is briefly visible. (finishedFadeAt = finishedAt + 30s.)
    const fresh = a.status === "running" || (a.finishedFadeAt != null && a.finishedFadeAt > now);
    if (!fresh) continue;
    entries.push({
      kind: "subagent",
      agentId: a.agentId,
      name: a.name,
      agentType: a.agentType,
      description: a.description,
      status: a.status,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
    });
  }

  for (const j of backgroundJobRegistry.listForSession(sessionId)) {
    entries.push({ kind: "job", jobId: j.jobId, description: j.description });
  }

  return entries;
}
