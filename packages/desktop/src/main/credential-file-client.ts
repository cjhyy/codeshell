import {
  type CredentialFileAddress,
  type CredentialFileCommand,
  type CredentialFileSnapshot,
} from "@cjhyy/code-shell-core/internal/storage";
import {
  CredentialStore,
  type CredentialScope,
  type CredentialStoreFile,
} from "@cjhyy/code-shell-core";

export type CredentialCommand = <T>(command: CredentialFileCommand, payload: unknown) => Promise<T>;
let command: CredentialCommand | undefined;
/** Installed once by Desktop Main. Shell-less unit callers can inject a fixture transport. */
export function setDesktopCredentialFiles(transport: CredentialCommand) {
  command = transport;
}

export function credentialFiles() {
  async function issue<T>(method: CredentialFileCommand, payload: unknown): Promise<T> {
    if (command) return command<T>(method, payload);
    // Core and test-only callers use the same bounded read and CAS implementation.
    const { credentialFileCommand } = await import("@cjhyy/code-shell-core/internal/storage");
    return credentialFileCommand(undefined, method, payload) as T;
  }
  return {
    read: (address: CredentialFileAddress) =>
      issue<CredentialFileSnapshot>("credentials/read", address),
    commit: (address: CredentialFileAddress, expectedRevision: string, file: CredentialStoreFile) =>
      issue<boolean>("credentials/commit", { ...address, expectedRevision, file }),
  };
}

export function runDesktopCredentialOperation<T>(
  cwd: string | undefined,
  read: readonly CredentialScope[],
  write: CredentialScope | undefined,
  work: (store: CredentialStore) => T,
  assertCurrent?: () => void,
): Promise<T> {
  const files = credentialFiles();
  const guarded = assertCurrent
    ? {
        ...files,
        commit: (...args: Parameters<typeof files.commit>) => {
          assertCurrent();
          return files.commit(...args);
        },
      }
    : files;
  return new CredentialStore(cwd).withAsyncCipher(guarded, read, write, work);
}

/** Worker and panel cookie access share the same CAS-verified credential snapshot. */
export async function readDesktopCookie(
  cwd: string | undefined,
  id: string,
  scope: "full" | "project",
  approval?: string,
) {
  const { resolveCookieCredentialForBrowser } = await import("./credential-action.js");
  return runDesktopCredentialOperation(
    cwd,
    scope === "project" ? ["project"] : ["user", "project"],
    undefined,
    (store) => resolveCookieCredentialForBrowser(cwd, id, scope, approval, store),
  );
}
