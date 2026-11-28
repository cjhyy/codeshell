import { join } from "node:path";
import { userHome } from "../utils/paths.js";
import { StampedMemo } from "../utils/file-stamp-memo.js";
import {
  getCredentialAccess,
  localCredentialAccess,
  type CredentialAccessScope,
  type CredentialMetadata,
} from "./access.js";

/** The secret-free, time-independent part of a listed credential. */
export type CredentialListingEntry = Readonly<Pick<CredentialMetadata, "id" | "type" | "meta">>;

const memo = new StampedMemo<readonly CredentialListingEntry[]>(16);

/**
 * Credential listing for tool availability and descriptions, which the run
 * tool surface re-evaluates before every tool call. A local listing reads both
 * store files and decrypts every secret, so it is reused while the files keep
 * their stamps; any write is a miss on the next call. Only identity fields are
 * cached (never secrets or expiry summaries). Host-provided access keeps its
 * own freshness contract and is always asked directly.
 */
export function listCredentialEntries(
  cwd: string,
  scope: CredentialAccessScope,
): readonly CredentialListingEntry[] {
  const access = getCredentialAccess();
  const read = () =>
    Object.freeze(
      access
        .listMasked(cwd, scope)
        .map(({ id, type, meta }) => Object.freeze({ id, type, ...(meta ? { meta } : {}) })),
    );
  if (access !== localCredentialAccess) return read();
  // Mirrors CredentialStore's default layout (no user-directory override).
  const userDir = join(userHome(), ".code-shell");
  const projectDir = join(cwd, ".code-shell");
  return memo.get(
    `${scope}\0${cwd}`,
    [
      { directory: userDir },
      { directory: projectDir },
      join(userDir, "credentials.json"),
      join(projectDir, "credentials.json"),
    ],
    read,
  );
}
