import { createLinkService, type LinkServiceOptions } from "@cjhyy/code-shell-server/links";
import {
  desktopPendingLinkRetirements,
  runDesktopCredentialOperation,
} from "./credential-file-client.js";

/** Only platform crypto crosses into Electron. The Host owns both credential files and CAS. */
export function createDesktopLinkService(options: LinkServiceOptions = {}) {
  if (options.store) return createLinkService(options);
  const scopes = ["user", "project"] as const;
  return createLinkService({
    ...options,
    credentials: {
      read: (work) => runDesktopCredentialOperation(options.cwd, scopes, undefined, work),
      write: (work, assertCurrent) =>
        runDesktopCredentialOperation(options.cwd, scopes, "user", work, assertCurrent, {
          guardProjectRevision: true,
        }),
      pendingRetirements: desktopPendingLinkRetirements,
    },
  });
}
