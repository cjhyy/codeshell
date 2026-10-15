import { SessionManager, SettingsManager, type SettingsScope } from "@cjhyy/code-shell-core";
import type { ToolContext } from "@cjhyy/code-shell-core/extension";
import {
  canonicalKey,
  resolveActiveWorkspaceProfileSelection,
} from "@cjhyy/code-shell-core/internal";

export type ExternalRuntimeSourceContext = Pick<ToolContext, "workspaceProfileName"> &
  Required<Pick<ToolContext, "isSourceProfileCurrent">>;

/** Capture once per logical Run, after its business Session has been persisted. */
export function createExternalRuntimeSourceContext(input: {
  sessionId: string;
  cwd: string;
  settingsScope?: SettingsScope;
  sessions?: Pick<SessionManager, "readSessionState">;
}): ExternalRuntimeSourceContext {
  const { sessionId, cwd } = input;
  const sessions = input.sessions ?? new SessionManager();
  const settingsScope = input.settingsScope ?? "full";
  const cwdKey = canonicalKey(cwd);
  const read = () => {
    const state = sessions.readSessionState(sessionId);
    if (
      !state ||
      state.sessionId !== sessionId ||
      typeof state.cwd !== "string" ||
      !state.cwd ||
      !Number.isFinite(state.startedAt) ||
      canonicalKey(state.cwd) !== cwdKey ||
      canonicalKey(cwd) !== cwdKey ||
      (state.workspaceProfile !== undefined &&
        (typeof state.workspaceProfile !== "string" || !state.workspaceProfile))
    ) {
      return undefined;
    }
    const selection = resolveActiveWorkspaceProfileSelection({
      cwd,
      settings: new SettingsManager(cwd, settingsScope),
      sessionProfile: state.workspaceProfile,
    });
    // An unavailable pin must never fall back to the project's broader profile.
    if (selection.name && !selection.profile) return undefined;
    return {
      name: selection.name,
      fingerprint: JSON.stringify({
        startedAt: state.startedAt,
        pin: state.workspaceProfile,
        selection,
      }),
    };
  };
  let captured: ReturnType<typeof read>;
  try {
    captured = read();
  } catch {
    // Persisted Session/Profile authority must be readable before granting access.
  }
  let revoked = !captured;
  return {
    workspaceProfileName: captured?.name,
    isSourceProfileCurrent() {
      if (revoked) return false;
      try {
        revoked = read()?.fingerprint !== captured!.fingerprint;
      } catch {
        revoked = true;
      }
      return !revoked;
    },
  };
}
