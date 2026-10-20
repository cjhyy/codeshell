import { realpath } from "node:fs/promises";
import { canonicalKey } from "@cjhyy/code-shell-core/internal";
import {
  requireRendererProjectPath,
  type RendererProjectPathOptions,
} from "./renderer-project-path.js";
import {
  getSessionWorkspaceAuthorityForUi,
  requireSessionFileRootForUi,
} from "./session-workspace-service.js";
import { assertDesktopSessionId } from "./session-validation.js";

export type { PtyStartRequest } from "../shared/pty.js";

/**
 * Authorize a renderer-supplied working directory (terminal cwd, image root).
 *
 * Registered project roots and the no-repo workspace pass as before. A
 * Session's current workspace — notably a CodeShell managed worktree, which is
 * never a registered root — passes only when the request names that Session
 * and Main re-derives the same directory from the Session's own authority.
 */
export async function requireRendererOrSessionPath(
  input: unknown,
  engineSessionId: unknown,
  options: RendererProjectPathOptions = {},
): Promise<string> {
  try {
    return await requireRendererProjectPath(input, options);
  } catch (error) {
    if (engineSessionId === undefined || engineSessionId === null || engineSessionId === "") {
      throw error;
    }
    assertDesktopSessionId(engineSessionId);
    const authority = await getSessionWorkspaceAuthorityForUi(engineSessionId).catch(() => null);
    if (!authority?.mainRootId || typeof input !== "string") throw error;
    const workspaceRoot = await requireSessionFileRootForUi(
      engineSessionId,
      authority.mainRootId,
    ).catch(() => null);
    if (!workspaceRoot) throw error;
    const [requested, authorized] = await Promise.all([
      realpath(input).catch(() => null),
      realpath(workspaceRoot).catch(() => null),
    ]);
    if (!requested || !authorized || canonicalKey(requested) !== canonicalKey(authorized)) {
      throw error;
    }
    return requested;
  }
}
