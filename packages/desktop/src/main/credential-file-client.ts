import type { CallCookieFile } from "../shared/cookie-files.js";
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
let cookieHost: CallCookieFile | undefined;
export function desktopCookieHost(): CallCookieFile {
  if (!cookieHost) throw Error("Cookie storage unavailable");
  return cookieHost;
}
/** Installed once by Desktop Main. Shell-less unit callers can inject a fixture transport. */
export function setDesktopCredentialFiles(transport: CredentialCommand, call?: CallCookieFile) {
  const previous = command;
  const previousCookieHost = cookieHost;
  command = transport;
  cookieHost = call;
  return () => {
    if (command === transport) {
      command = previous;
      cookieHost = previousCookieHost;
    }
  };
}

async function issue<T>(method: CredentialFileCommand, payload: unknown): Promise<T> {
  if (command) return command<T>(method, payload);
  // Core and test-only callers use the same bounded read and CAS implementation.
  const { credentialFileCommand } = await import("@cjhyy/code-shell-core/internal/storage");
  return credentialFileCommand(undefined, method, payload) as T;
}

/** Count pending cleanup in the storage worker. This query never opens the keychain. */
export function desktopPendingLinkRetirements(): Promise<number> {
  return issue<number>("credentials/pendingRetirements", {});
}

export function credentialFiles() {
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
  assertCurrent?: () => void | Promise<void>,
  options?: { guardProjectRevision?: boolean },
): Promise<T> {
  const files = credentialFiles();
  const guardProject = Boolean(options?.guardProjectRevision && cwd);
  if (guardProject && (write !== "user" || !read.includes("project")))
    throw Error("A project revision requires a user write and a project read");
  let observedProject: string | undefined;
  const guarded = {
    async read(address: CredentialFileAddress) {
      const snapshot = await files.read(address);
      if (guardProject && address.scope === "project") observedProject = snapshot.revision;
      return snapshot;
    },
    async commit(
      address: CredentialFileAddress,
      expectedRevision: string,
      file: CredentialStoreFile,
    ) {
      await assertCurrent?.();
      if (!guardProject) return files.commit(address, expectedRevision, file);
      if (!observedProject) throw Error("Missing credential project revision");
      return issue<boolean>("credentials/commit", {
        ...address,
        expectedRevision,
        file,
        projectGuard: { cwd, revision: observedProject },
      });
    },
  };
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
