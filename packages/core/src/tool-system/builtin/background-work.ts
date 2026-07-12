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
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { asyncAgentRegistry, type AsyncAgentStatus } from "./agent-registry.js";
import {
  backgroundJobRegistry,
  type BackgroundJobKind,
  type BackgroundJobStatus,
  type ExternalCliKind,
} from "./background-jobs.js";
import { backgroundShellManager, type BgShell } from "../../runtime/background-shell.js";
import { codeShellHome } from "../../session/session-manager.js";

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

  for (const j of backgroundJobRegistry.listRunningForSession(sessionId)) {
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
export interface BackgroundWorkSourceSession {
  sessionId: string;
  shortId: string;
  title?: string;
  current: boolean;
}

type WithSource<T> = T & { sourceSession: BackgroundWorkSourceSession };

export type BackgroundWorkEntry =
  | WithSource<{
      kind: "shell";
      /** Full shell snapshot — the panel already renders this shape (output/kill
       *  still go through the dedicated agent/backgroundShells RPC by shellId). */
      shell: BgShell;
    }>
  | WithSource<{
      kind: "subagent";
      agentId: string;
      name?: string;
      agentType?: string;
      description: string;
      status: AsyncAgentStatus;
      startedAt: number;
      finishedAt?: number;
    }>
  | WithSource<{
      kind: "job";
      jobId: string;
      description: string;
      status: BackgroundJobStatus;
      startedAt: number;
      finishedAt?: number;
      /** Result summary / error, once finished. */
      finalText?: string;
      /** Files an external agent (DriveAgent) changed, parsed from its transcript. */
      changedFiles?: string[];
      /** Machine-readable job kind and external-session linkage for DriveAgent. */
      jobKind?: BackgroundJobKind;
      externalSessionId?: string;
      cli?: ExternalCliKind;
      cwd?: string;
    }>;

type SessionTitleCacheEntry = { mtimeMs: number; title?: string };

const sessionTitleCache = new Map<string, SessionTitleCacheEntry>();

function shortSessionId(sessionId: string): string {
  return sessionId.length <= 10 ? sessionId : sessionId.slice(0, 10);
}

function readSessionTitle(sessionId: string): string | undefined {
  try {
    const statePath = join(codeShellHome(), "sessions", sessionId, "state.json");
    const st = statSync(statePath);
    const cached = sessionTitleCache.get(sessionId);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.title;
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as {
      title?: unknown;
      summary?: unknown;
    };
    const title =
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim()
        : typeof raw.summary === "string" && raw.summary.trim()
          ? raw.summary.trim()
          : undefined;
    sessionTitleCache.set(sessionId, { mtimeMs: st.mtimeMs, title });
    return title;
  } catch {
    return undefined;
  }
}

function sourceSession(
  currentSessionId: string,
  ownerSessionId: string,
): BackgroundWorkSourceSession {
  return {
    sessionId: ownerSessionId,
    shortId: shortSessionId(ownerSessionId),
    title: readSessionTitle(ownerSessionId),
    current: ownerSessionId === currentSessionId,
  };
}

/**
 * Every background-work item spawned by `sessionId`, with per-kind detail, for
 * the desktop panel. Includes finished sub-agents that are still within their
 * fade window (so a just-completed agent doesn't vanish before the user sees
 * it); shells carry their own terminal status and the panel decides how long to
 * keep them. Jobs are only ever present while running (the registry drops them
 * on finish).
 */
export function listBackgroundWorkForUI(
  sessionId: string,
  opts: { scope?: "session" | "all" } = {},
): BackgroundWorkEntry[] {
  const entries: BackgroundWorkEntry[] = [];
  const scope = opts.scope ?? "session";

  const shells =
    scope === "all"
      ? backgroundShellManager.list()
      : backgroundShellManager.listForSession(sessionId);
  for (const s of shells) {
    entries.push({ kind: "shell", shell: s, sourceSession: sourceSession(sessionId, s.sessionId) });
  }

  const now = Date.now();
  const agents =
    scope === "all" ? asyncAgentRegistry.list() : asyncAgentRegistry.listForSession(sessionId);
  for (const a of agents) {
    // Keep running agents, plus finished ones still inside their fade window so
    // a completion is briefly visible. (finishedFadeAt = finishedAt + 30s.)
    const fresh = a.status === "running" || (a.finishedFadeAt != null && a.finishedFadeAt > now);
    if (!fresh) continue;
    const ownerSessionId = a.sessionId ?? sessionId;
    entries.push({
      kind: "subagent",
      agentId: a.agentId,
      name: a.name,
      agentType: a.agentType,
      description: a.description,
      status: a.status,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      sourceSession: sourceSession(sessionId, ownerSessionId),
    });
  }

  const jobs =
    scope === "all"
      ? backgroundJobRegistry.list()
      : backgroundJobRegistry.listForSession(sessionId);
  for (const j of jobs) {
    const launchCwd = j.launchCwd ?? j.cwd;
    entries.push({
      kind: "job",
      jobId: j.jobId,
      description: j.description,
      status: j.status,
      startedAt: j.startedAt,
      ...(j.finishedAt != null ? { finishedAt: j.finishedAt } : {}),
      ...(j.finalText != null ? { finalText: j.finalText } : {}),
      ...(j.changedFiles && j.changedFiles.length ? { changedFiles: j.changedFiles } : {}),
      ...(j.kind ? { jobKind: j.kind } : {}),
      ...(j.ccSessionId ? { externalSessionId: j.ccSessionId } : {}),
      ...(j.cli === "claude" || j.cli === "codex" ? { cli: j.cli } : {}),
      ...(launchCwd ? { cwd: launchCwd } : {}),
      sourceSession: sourceSession(sessionId, j.sessionId),
    });
  }

  return entries;
}
