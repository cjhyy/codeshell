import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { environmentIdentity } from "../environment-identity.js";

/** Context identity only. This value grants no Host permissions. */
export interface PanelProjectScope {
  version: 1;
  environmentId: string;
  projectId: string;
  rootId: string;
}

export interface PanelProjectScopeBinding {
  readonly scope: Readonly<PanelProjectScope>;
  /** Revalidates the frozen authority; a failed binding can never be revived. */
  assertCurrent(): void;
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function directory(path: string) {
  const selected = resolve(path);
  const canonical = realpathSync(selected);
  const info = lstatSync(canonical, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid Panel project root");
  const identity = [canonical, String(info.dev), String(info.ino), String(info.birthtimeNs)];
  return {
    identity,
    assertCurrent() {
      if (realpathSync(selected) !== canonical) throw new Error("Panel project root changed");
      const current = lstatSync(canonical, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== info.dev ||
        current.ino !== info.ino ||
        current.birthtimeNs !== info.birthtimeNs
      )
        throw new Error("Panel project root changed");
    },
  };
}

function readEnvironment(path: string, expectedId: string) {
  const fd = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size <= 0n || before.size > 256n)
      throw new Error("Invalid Panel environment identity");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error("Panel environment identity changed");
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      named.isSymbolicLink() ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      value?.version !== 1 ||
      value.id !== expectedId
    )
      throw new Error("Panel environment identity changed");
    return [String(before.dev), String(before.ino), String(before.birthtimeNs)];
  } finally {
    closeSync(fd);
  }
}

/** Only Host composition calls this factory, after resolving its selected roots. */
export async function capturePanelProjectScope(options: {
  environmentDir: string;
  /** Hub supplies its already advertised descriptor identity. */
  environmentId?: string;
  projectPath: string;
  cwd: string;
  /** Desktop supplies opaque IDs resolved from its authoritative project registry. */
  projectId?: string;
  rootId?: string;
  assertAuthority(): void;
}): Promise<PanelProjectScopeBinding> {
  options.assertAuthority();
  const environmentId =
    options.environmentId ?? (await environmentIdentity(options.environmentDir));
  options.assertAuthority();
  const environmentRoot = directory(options.environmentDir);
  const environmentFile = join(options.environmentDir, "environment.json");
  const environmentPin = readEnvironment(environmentFile, environmentId);
  const project = directory(options.projectPath);
  const root = directory(options.cwd);
  const scope: Readonly<PanelProjectScope> = Object.freeze({
    version: 1,
    environmentId,
    projectId: options.projectId ?? digest(["project", project.identity]),
    // The registered mount and the execution root are different for worktrees.
    rootId: digest(["root", options.rootId ?? null, root.identity]),
  });
  let revoked = false;
  const binding: PanelProjectScopeBinding = {
    scope,
    assertCurrent() {
      if (revoked) throw new Error("Panel project scope was revoked; reopen the panel");
      try {
        options.assertAuthority();
        environmentRoot.assertCurrent();
        if (digest(readEnvironment(environmentFile, environmentId)) !== digest(environmentPin))
          throw new Error("Panel environment identity changed");
        project.assertCurrent();
        root.assertCurrent();
      } catch (cause) {
        revoked = true;
        throw new Error("Panel project scope changed; reopen the panel", { cause });
      }
    },
  };
  binding.assertCurrent();
  return binding;
}
