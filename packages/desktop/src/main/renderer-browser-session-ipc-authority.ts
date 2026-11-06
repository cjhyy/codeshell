import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { externalRuntimeBrowserBucket } from "./external-runtime-browser-bucket.js";
import { readExternalRuntimeBinding } from "./external-runtime-state.js";
import { mobileSessionCommandAuthority } from "./mobile-remote/output-recovery-authority.js";
import { getProjectStore } from "./project-store.js";
import type { RendererBrowserSessionAccess } from "./renderer-browser-session-access.js";
import { assertDesktopSessionId } from "./session-validation.js";

export async function resolvePersistedBrowserSession(sessionId: string) {
  // Reuse durable Session/project checks without reserving or starting a task.
  const authority = await mobileSessionCommandAuthority(sessionId);
  const store = getProjectStore();
  const projectId =
    authority.projectId ?? store.resolveExactRootSync(authority.mainRoot)?.project.id;
  if (!projectId && !store.isNoRepoCwd(authority.mainRoot))
    throw new Error("Session project is not mounted");
  return {
    bucket: readExternalRuntimeBinding(sessionId)
      ? externalRuntimeBrowserBucket(sessionId)
      : `${projectId ?? "__no_repo__"}::${sessionId}`,
    assertCurrent: authority.assertCurrent,
  };
}

export function createRendererBrowserSessionEventAccess(
  sessionAccess: Pick<RendererBrowserSessionAccess, "prepare">,
  isDeleting: (sessionId: string) => boolean,
) {
  return async (event: IpcMainEvent | IpcMainInvokeEvent, rawSessionId: unknown) => {
    const frame = event.senderFrame;
    if (!frame || frame !== event.sender.mainFrame)
      throw new Error("browser operation requires the current Desktop main window");
    assertDesktopSessionId(rawSessionId);
    if (isDeleting(rawSessionId)) throw new Error("Session is being deleted");
    const access = await sessionAccess.prepare(rawSessionId, event.sender.id);
    const assertCurrent = () => {
      if (
        event.sender.isDestroyed() ||
        event.sender.mainFrame !== frame ||
        isDeleting(access.sessionId)
      )
        throw new Error("browser conversation window changed");
      access.assertCurrent();
    };
    assertCurrent();
    return { ...access, assertCurrent };
  };
}
