import { createLinkService, type LinkServiceOptions } from "@cjhyy/code-shell-server/links";
import {
  desktopPendingLinkRetirements,
  runDesktopCredentialOperation,
} from "./credential-file-client.js";

/** Only platform crypto crosses into Electron. The Host owns both credential files and CAS. */
export function createDesktopLinkService(
  options: LinkServiceOptions = {},
  withCaller?: <T>(work: () => T) => T,
) {
  if (options.store) return createLinkService(options);
  const scopes = ["user", "project"] as const;
  return createLinkService({
    ...options,
    credentials: {
      read: (work) => runDesktopCredentialOperation(options.cwd, scopes, undefined, work),
      write: (work, assertCurrent) => {
        const commit = () =>
          runDesktopCredentialOperation(options.cwd, scopes, "user", work, assertCurrent, {
            guardProjectRevision: true,
          });
        // A window's grant uses its live document permit at the storage rename.
        // Orphan grant cleanup must also run after that document is gone.
        return assertCurrent && withCaller ? withCaller(commit) : commit();
      },
      pendingRetirements: desktopPendingLinkRetirements,
    },
  });
}
