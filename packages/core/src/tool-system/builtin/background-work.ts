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
import { asyncAgentRegistry } from "./agent-registry.js";
import { backgroundJobRegistry } from "./background-jobs.js";
import { backgroundShellManager } from "../../runtime/background-shell.js";

export type BackgroundWorkKind = "subagent" | "job" | "shell";

export interface BackgroundWorkItem {
  kind: BackgroundWorkKind;
  /** Human description for the judge (sub-agent task / video prompt / shell command). */
  description: string;
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
      items.push({ kind: "shell", description: s.command });
    }
  }

  return items;
}
