import { lstatSync } from "node:fs";
import { join } from "node:path";
import { getProjectStore } from "../../main/project-store.js";
import { recentSessionIds } from "../../main/pet/pet-notice-goal-reconcile.js";
import { isTopLevelWork } from "../../main/pet/pet-notice-external-sessions.js";
import { persistedGoalAttention } from "../../main/external-runtime-goal-attention.js";
import { SessionManager } from "@cjhyy/code-shell-core";
import { goalGetPayload } from "@cjhyy/code-shell-core/internal";
import type { StateStorage } from "@cjhyy/code-shell-core/internal/storage";
import { assertDesktopSessionId } from "../../main/session-validation.js";
import { ExternalRuntimeGoals } from "../../main/external-runtime-goals.js";
import { resolveExternalRuntimeStartWorkspace } from "../../main/external-runtime-start-workspace.js";
import {
  isPersistedExternalRuntime,
  persistedExternalRuntimeModelKey,
} from "../../main/mobile-remote/external-runtime-commands.js";
import { getSessionEvents } from "../../main/rawTranscript.js";
import { buildExternalRuntimeHandoffFromEvents } from "../../main/external-runtime-handoff.js";
import type { GoalRecoveryOperations } from "../../shared/goal-recovery.js";
import type { BusinessMethods } from "./business-calls.js";

type GoalRead = keyof GoalRecoveryOperations;

export async function readStoredGoal(
  method: GoalRead,
  input: unknown,
  sessions: SessionManager,
): Promise<GoalRecoveryOperations[GoalRead]["result"]> {
  if (method === "goals/recent") {
    if (
      !input ||
      typeof input !== "object" ||
      !("sinceMs" in input) ||
      typeof input.sinceMs !== "number" ||
      !Number.isSafeInteger(input.sinceMs)
    )
      throw Error("Invalid recent Goal read");
    return recentSessionIds(sessions.getStorageDir(), input.sinceMs);
  }
  if (!input || typeof input !== "object" || !("sessionId" in input))
    throw Error("Invalid goal read");
  const { sessionId } = input;
  assertDesktopSessionId(sessionId);
  const state = sessions.readSessionState(sessionId);
  const external = isPersistedExternalRuntime(state);
  if (method === "goals/attention") {
    return {
      topLevel: !!state && isTopLevelWork(state),
      external,
      attention: persistedGoalAttention(state),
    };
  }
  if (method === "goals/read") {
    // Online provider questions stay with their runtime. Cold reads use the canonical Goal lifecycle.
    const goal = external
      ? new ExternalRuntimeGoals(() => {}, Date.now, sessions).get(sessionId)
      : goalGetPayload(sessions.readActiveGoal(sessionId), sessions.readGoalProgress(sessionId));
    return { external, goal };
  }
  if (!("includeContext" in input) || typeof input.includeContext !== "boolean")
    throw Error("Invalid goal resume read");
  const modelKey = persistedExternalRuntimeModelKey(state);
  if (!state || !modelKey) throw Error("External goal task is no longer available");
  const directory = join(sessions.getStorageDir(), sessionId);
  const generation = () => {
    const stat = lstatSync(directory, { bigint: true });
    if (!stat.isDirectory()) throw Error("Invalid external Session directory");
    return [stat.dev.toString(), stat.ino.toString()];
  };
  const before = generation();
  const workspace = await resolveExternalRuntimeStartWorkspace(sessionId, state.cwd, { sessions });
  const initialContext = input.includeContext
    ? buildExternalRuntimeHandoffFromEvents(
        await getSessionEvents(sessionId, undefined, sessions.getStorageDir()),
      )
    : undefined;
  workspace.assertStartAuthority();
  // The recorder upgrades legacy cwd-only Sessions to this exact registered root on start.
  // Fence the effective authority across the upgrade, while detecting a later explicit unbind.
  const stamp = (s: typeof state, directoryId: string[]) => {
    const root = s.project ? undefined : getProjectStore().resolveExactRootSync(workspace.mainRoot);
    return JSON.stringify([
      ...directoryId,
      s.sessionId,
      s.startedAt,
      s.cwd,
      persistedExternalRuntimeModelKey(s),
      s.workspace?.root ?? s.cwd,
      s.project?.projectId ?? root?.project.id,
      s.project?.mainRootId ?? root?.mainRoot.id,
      workspace.cwd,
      workspace.mainRoot,
    ]);
  };
  const identity = stamp(state, before);
  const current = sessions.readSessionState(sessionId);
  if (!current || (state.project && !current.project) || stamp(current, generation()) !== identity)
    throw Error("External goal Session changed");
  return {
    identity,
    projectBound: !!current.project,
    modelKey,
    cwd: workspace.cwd,
    mainRoot: workspace.mainRoot,
    initialContext,
  };
}

export function goalRecoveryOperations(storage: Promise<StateStorage>) {
  function read<K extends GoalRead>(method: K) {
    return async (input: GoalRecoveryOperations[K]["input"]) => {
      const db = await storage;
      const result = await db.request<GoalRecoveryOperations[K]["result"]>(method, input);
      if (!result) throw Error("Goal storage unavailable");
      return result;
    };
  }
  return {
    "goals/read": read("goals/read"),
    "goals/recent": read("goals/recent"),
    "goals/attention": read("goals/attention"),
    "goals/resume": read("goals/resume"),
  } satisfies Pick<BusinessMethods, GoalRead>;
}
