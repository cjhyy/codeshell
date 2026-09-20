import {
  requireSessionFileRootForUi,
  resolveSessionReviewWorkspaceForUi,
} from "./session-workspace-service.js";
import type { MediaPreviewAuthority } from "./media-preview-service.js";
import { assertDesktopSessionId } from "./session-validation.js";

/** Session files and playback share the same Main-owned mounted-root/worktree boundary. */
export async function resolveMediaPreviewAuthority(
  sessionId: string,
): Promise<MediaPreviewAuthority> {
  assertDesktopSessionId(sessionId);
  const workspace = await resolveSessionReviewWorkspaceForUi(sessionId);
  const roots = workspace.projectId
    ? await Promise.all(
        workspace.roots.map(async (root) => ({
          ...root,
          path: await requireSessionFileRootForUi(sessionId, root.id),
        })),
      )
    : workspace.roots;
  return { mainRootId: workspace.mainRootId, roots };
}
