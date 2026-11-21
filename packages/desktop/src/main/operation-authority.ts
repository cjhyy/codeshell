import { homedir } from "node:os";
import type { readOperationSessionOwner } from "@cjhyy/code-shell-core/internal";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { codeShellHome } from "@cjhyy/code-shell-core";

export function operationRootIdentity(cwd: string): string {
  const info = lstatSync(cwd);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Operation project root is unavailable");
  return JSON.stringify([cwd, info.dev, info.ino]);
}

export function operationRegistryRevision(): string {
  return JSON.stringify(
    ["projects.json", "trust.json"].map((name) => {
      const info = lstatSync(join(codeShellHome(), "desktop", name), { bigint: true });
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Operation authority registry unavailable");
      return [name, info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String);
    }),
  );
}

export interface OperationProjectScope {
  cwd: string;
  root: string;
  authority: string;
}

export function operationOwnerIdentity(owner: ReturnType<typeof readOperationSessionOwner>) {
  return JSON.stringify([
    owner.incarnation,
    operationRootIdentity(owner.directory),
    owner.state.cwd,
    owner.state.project,
    owner.state.workspace,
    owner.state.workspaceProfile,
  ]);
}

/** Short-lived guard for a freshly read metadata snapshot. No keyring I/O takes place inside a ledger lock. */
export function operationCredentialRevision(cwd: string) {
  return JSON.stringify(
    [join(process.env.HOME ?? homedir(), ".code-shell"), join(cwd, ".code-shell")].map((folder) => {
      try {
        const info = lstatSync(join(folder, "credentials.json"), { bigint: true });
        if (!info.isFile() || info.isSymbolicLink())
          throw new Error("Invalid operation credential store");
        return [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs].map(String);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    }),
  );
}
