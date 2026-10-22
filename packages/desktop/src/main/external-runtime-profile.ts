/**
 * Digital-human (workspace Profile) binding for external runtime Sessions.
 *
 * An external runtime never passes through `agent/run`, so the Engine's
 * first-run binding (`run-session-open`) and profile resolution
 * (`resolveRunProfileState`) never run for it. Desktop main repeats the same
 * chain here: persist the requested pin on the canonical Session before any
 * turn, then resolve the effective Profile (Session pin first, project default
 * otherwise). Source authorization reads that persisted pin per run, so a
 * missing pin would fall back to the broader project default Profile.
 */
import {
  SessionManager,
  SettingsManager,
  WORKSPACE_PROFILE_NAME_RE,
  type SettingsScope,
} from "@cjhyy/code-shell-core";
import {
  readWorkspaceProfile,
  resolveActiveWorkspaceProfile,
  workspaceProfileDir,
} from "@cjhyy/code-shell-core/internal";

export interface ExternalRuntimeProfile {
  /** The Session's persisted pin after binding; undefined follows the project default. */
  pinned?: string;
  /** Effective Profile name, including a project default. */
  name?: string;
  mainInstruction?: string;
  /** Portable memory directory exposed to Memory tools as location "profile". */
  profileMemoryDir?: string;
}

export function assertWorkspaceProfileName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !WORKSPACE_PROFILE_NAME_RE.test(value)) {
    throw new Error("invalid workspace profile name");
  }
  return value;
}

/** The pin a start request asks for: an explicit renderer value, else the persisted one. */
export function requestedExternalRuntimeProfile(
  sessionId: string,
  requested: string | undefined,
  sessions: Pick<SessionManager, "readSessionWorkspaceProfile"> = new SessionManager(),
): string | undefined {
  return requested ?? sessions.readSessionWorkspaceProfile(sessionId);
}

/**
 * Persist `requested` on an already materialized canonical Session (as the
 * native first run does), then resolve the effective Profile. A pinned but
 * unavailable Profile fails the start instead of widening to the default.
 */
export function bindExternalRuntimeProfile(input: {
  sessionId: string;
  cwd: string;
  requested?: string;
  settingsScope?: SettingsScope;
  sessions?: Pick<SessionManager, "readSessionState" | "saveStateOrUpdateFields">;
}): ExternalRuntimeProfile {
  const sessions = input.sessions ?? new SessionManager();
  const state = sessions.readSessionState(input.sessionId);
  if (!state) throw new Error(`external runtime Session is not materialized: ${input.sessionId}`);
  const requested = assertWorkspaceProfileName(input.requested);
  if (requested && state.workspaceProfile !== requested) {
    if (state.kind !== undefined && state.kind !== "work") {
      throw new Error(`session kind ${state.kind} cannot bind a workspace profile`);
    }
    if (!readWorkspaceProfile(requested)) {
      throw new Error(`Workspace profile "${requested}" is unavailable`);
    }
    if (!sessions.saveStateOrUpdateFields(state, { workspaceProfile: requested })) {
      throw new Error(`Could not bind workspace profile for Session ${input.sessionId}`);
    }
  }
  const pinned =
    requested ??
    (typeof state.workspaceProfile === "string" && state.workspaceProfile
      ? state.workspaceProfile
      : undefined);
  const profile = resolveActiveWorkspaceProfile({
    cwd: input.cwd,
    settings: new SettingsManager(input.cwd, input.settingsScope ?? "full"),
    ...(pinned ? { sessionProfile: pinned } : {}),
  });
  if (pinned && !profile) throw new Error(`Workspace profile "${pinned}" is unavailable`);
  return {
    ...(pinned ? { pinned } : {}),
    ...(profile ? { name: profile.name } : {}),
    ...(profile?.mainInstruction ? { mainInstruction: profile.mainInstruction } : {}),
    ...(profile?.portableMemory ? { profileMemoryDir: workspaceProfileDir(profile.name) } : {}),
  };
}

/** Developer-instruction section mirroring the native "Digital-Human Main Instruction". */
export function externalRuntimeProfileInstructions(
  profile: ExternalRuntimeProfile,
): string | undefined {
  if (!profile.name) return undefined;
  return [
    `Active CodeShell digital human (workspace profile): ${profile.name}`,
    profile.mainInstruction && `# Digital-Human Main Instruction\n\n${profile.mainInstruction}`,
    profile.profileMemoryDir &&
      'This digital human has portable memory: use the CodeShell Memory tools with location "profile" to read or save it.',
  ]
    .filter(Boolean)
    .join("\n\n");
}
