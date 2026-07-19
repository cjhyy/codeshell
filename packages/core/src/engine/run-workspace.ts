/**
 * Run-workspace resolution — the pre-session phase of Engine.runExclusive:
 * pins session kind, resolves the switchable work-Session profile binding,
 * behavior profile / permission mode / plan mode, workspace resume (with its
 * two early-return shapes), and the effective cwd. Pure of Engine — everything
 * arrives via the args object (run-setup.ts / run-image-input.ts style).
 */
import type { SessionKind } from "../types.js";
import type { SessionManager } from "../session/session-manager.js";
import type { SettingsManager } from "../settings/manager.js";
import type { EngineConfig, EngineResult } from "./types.js";
import type { EngineRunOptions, RunBehaviorProfile } from "./run-types.js";
import { resolveRunProfileState, type RunProfileState } from "./run-setup.js";

/**
 * Resolve the working directory for a run. Precedence for legacy sessions:
 *   options.cwd  >  resumed session's state.cwd  >  config.cwd  >  process.cwd()
 * (Moved verbatim from engine.ts; engine.ts re-exports it for compatibility.)
 */
export function resolveRunCwd(args: {
  optionCwd?: string;
  sessionCwd?: string;
  configCwd?: string;
  processCwd: string;
}): string {
  return args.optionCwd ?? args.sessionCwd ?? args.configCwd ?? args.processCwd;
}

export interface RunWorkspaceResolution {
  sessionKind: SessionKind;
  sessionWorkspaceProfile: string | undefined;
  profile: RunBehaviorProfile | undefined;
  profileParams: Readonly<Record<string, unknown>>;
  runPermissionMode: NonNullable<EngineConfig["permissionMode"]>;
  runPlanMode: boolean;
  cwd: string;
  profileState: RunProfileState;
}

export type ResolveRunWorkspaceResult =
  | { ok: true; resolution: RunWorkspaceResolution }
  | { ok: false; result: EngineResult };

export async function resolveRunWorkspace(args: {
  options: EngineRunOptions | undefined;
  sessionManager: Pick<
    SessionManager,
    | "exists"
    | "readSessionKind"
    | "readSessionWorkspaceProfile"
    | "resolveSessionWorkspaceForResume"
    | "readSessionMainRoot"
  >;
  resolveBehaviorProfile: (
    sessionKind: string,
    behaviorMode: string | undefined,
  ) => RunBehaviorProfile | undefined;
  configPermissionMode: EngineConfig["permissionMode"];
  configCwd: string | undefined;
  settings: SettingsManager;
  processCwd: string;
}): Promise<ResolveRunWorkspaceResult> {
  const { options } = args;
  const persistedSessionKind =
    options?.sessionId && args.sessionManager.exists(options.sessionId)
      ? args.sessionManager.readSessionKind(options.sessionId)
      : undefined;
  if (
    persistedSessionKind !== undefined &&
    options?.kind !== undefined &&
    persistedSessionKind !== options.kind
  ) {
    throw new Error(
      `session kind mismatch: persisted ${persistedSessionKind}, requested ${options.kind}`,
    );
  }
  const sessionKind = persistedSessionKind ?? options?.kind ?? "work";
  const persistedWorkspaceProfile =
    options?.sessionId && args.sessionManager.exists(options.sessionId)
      ? args.sessionManager.readSessionWorkspaceProfile(options.sessionId)
      : undefined;
  const sessionWorkspaceProfile = options?.workspaceProfile ?? persistedWorkspaceProfile;
  if (sessionKind !== "work" && sessionWorkspaceProfile) {
    throw new Error(`session kind ${sessionKind} cannot bind a workspace profile`);
  }
  const profile = args.resolveBehaviorProfile(sessionKind, options?.behaviorMode);
  // Normalize per-run profile parameters. The legacy pet-named run options
  // fold into the generic bag (runtimeContext / workspaces) so existing
  // hosts keep working; an explicit profileParams entry wins on key clash.
  const profileParams: Readonly<Record<string, unknown>> = {
    ...(options?.petRuntimeContext !== undefined
      ? { runtimeContext: options.petRuntimeContext }
      : {}),
    ...(options?.petWorkspaces !== undefined ? { workspaces: options.petWorkspaces } : {}),
    ...(options?.profileParams ?? {}),
  };
  const planModeDisabled = profile?.disablePlanMode === true;
  let runPermissionMode =
    profile?.forcePermissionMode ??
    options?.permissionMode ??
    args.configPermissionMode ??
    "acceptEdits";
  if (!planModeDisabled && options?.planMode === true) {
    runPermissionMode = "plan";
  } else if (!planModeDisabled && options?.planMode === false && runPermissionMode === "plan") {
    runPermissionMode = "acceptEdits";
  }
  const runPlanMode = runPermissionMode === "plan";
  const workspaceResume =
    options?.sessionId && args.sessionManager.exists(options.sessionId)
      ? await args.sessionManager.resolveSessionWorkspaceForResume(options.sessionId)
      : undefined;
  if (workspaceResume && !workspaceResume.ok) {
    return {
      ok: false,
      result: {
        text: `ERROR: ${workspaceResume.message}`,
        reason: "completed",
        sessionId: options!.sessionId!,
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  }
  if (
    workspaceResume?.ok &&
    workspaceResume.reason === "worktree_missing_branch_gone" &&
    workspaceResume.message
  ) {
    return {
      ok: false,
      result: {
        text: workspaceResume.message,
        reason: "completed",
        sessionId: options!.sessionId!,
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  }

  // Existing P1 sessions resolve cwd from SessionWorkspace, even if the host
  // passes a stale cwd. Legacy sessions without workspace keep the historical
  // explicit-cwd precedence for backward compatibility.
  const workspaceCwd =
    workspaceResume?.ok && workspaceResume.reason !== "legacy" ? workspaceResume.cwd : undefined;
  const sessionCwd =
    workspaceCwd === undefined && options?.cwd === undefined && options?.sessionId
      ? workspaceResume?.ok
        ? workspaceResume.cwd
        : args.sessionManager.readSessionMainRoot(options.sessionId)
      : undefined;
  const cwd =
    workspaceCwd ??
    resolveRunCwd({
      optionCwd: options?.cwd,
      sessionCwd,
      configCwd: args.configCwd,
      processCwd: args.processCwd,
    });
  const profileState = resolveRunProfileState({
    sessionWorkspaceProfile,
    cwd,
    settings: args.settings,
  });

  return {
    ok: true,
    resolution: {
      sessionKind,
      sessionWorkspaceProfile,
      profile,
      profileParams,
      runPermissionMode,
      runPlanMode,
      cwd,
      profileState,
    },
  };
}
