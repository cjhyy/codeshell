import { fileURLToPath } from "node:url";

/**
 * Convert a `file://` root URI to a platform filesystem path.
 *
 * The LSP manager used `rootUri.replace("file://", "")`, which only strips the
 * first occurrence and leaves percent-encoding intact, and on Windows turns
 * `file:///C:/x` into the invalid `/C:/x`. fileURLToPath does the proper
 * platform conversion (drive letters, percent-decoding, UNC).
 */
export function rootUriToPath(rootUri: string): string {
  return fileURLToPath(rootUri);
}
