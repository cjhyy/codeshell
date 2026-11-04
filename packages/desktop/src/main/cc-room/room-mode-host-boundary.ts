import {
  requireRendererLinkedSessionPath,
  type RendererProjectPathOptions,
} from "../renderer-project-path.js";
import {
  resolveLinkedSessionFromDisk,
  type LinkedSessionResolverOptions,
} from "./linked-session-resolver.js";
import type { RoomModeAuthorityDeps } from "./room-mode-authority.js";

/**
 * Desktop Main's facts for opening an external CLI session, shared by the
 * paired phone and Desktop windows.
 *
 * - The directory is authorized by the same rule as linked-session
 *   navigation: a registered project root, a directory inside one, or a linked
 *   git worktree whose repository is registered, all compared by realpath. A
 *   client-supplied cwd never authorizes itself.
 * - The session must exist in the CLI's own on-disk records under exactly the
 *   requested id, kind and cwd.
 */
export function desktopRoomModeHostBoundary(
  options: { paths?: RendererProjectPathOptions; sessions?: LinkedSessionResolverOptions } = {},
): Pick<RoomModeAuthorityDeps, "requireProjectPath" | "resolveSession"> {
  return {
    requireProjectPath: (cwd) => requireRendererLinkedSessionPath(cwd, options.paths),
    resolveSession: (target) => resolveLinkedSessionFromDisk(target, options.sessions),
  };
}
