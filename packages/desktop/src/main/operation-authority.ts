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
