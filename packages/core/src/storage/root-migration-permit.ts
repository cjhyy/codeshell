import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { lstat, rm } from "node:fs/promises";
import { join } from "node:path";
interface MigrationTarget {
  projectId: string;
  mainRootId: string;
  mainRoot: string;
}
function targetIdentity(target: MigrationTarget) {
  return JSON.stringify([target.projectId, target.mainRootId, realpathSync(target.mainRoot)]);
}

const lifetimeMs = 120_000;
function pathFor(root: string, sessionId: string, ticket: string) {
  if (typeof sessionId !== "string" || !sessionId)
    throw Error("Invalid Session root-migration owner");
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(ticket))
    throw Error("Invalid Session root-migration ticket");
  const directory = join(root, ".root-migrations");
  const name = createHash("sha256").update(sessionId).update("\0").update(ticket).digest("hex");
  return { directory, file: join(directory, name) };
}

/** The Host and the stdio Engine cannot share an Atomics permit. Consuming or withdrawing the
 * same one-use directory entry gives them a single commit decision under the Session lock. */
export function reserveRootMigration(
  root: string,
  sessionId: string,
  ticket: string,
  target: MigrationTarget,
) {
  const { directory, file } = pathFor(root, sessionId, ticket);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory()) throw Error("Invalid Session migration grant directory");
  // A Host crash can leave an expired entry. Other active reservations remain independent.
  for (const name of readdirSync(directory)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const path = join(directory, name);
    const entry = statSync(path, { throwIfNoEntry: false });
    if (entry && Date.now() - entry.mtimeMs >= lifetimeMs) rmSync(path, { force: true });
  }
  writeFileSync(file, targetIdentity(target), { flag: "wx", mode: 0o600 });
  return {
    claim: () => claimRootMigration(root, sessionId, ticket, target),
    revoke: () => {
      if (lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())
        rmSync(file, { force: true });
    },
  };
}

export async function withdrawRootMigration(root: string, sessionId: string, ticket: string) {
  const { directory, file } = pathFor(root, sessionId, ticket);
  const info = await lstat(directory).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  });
  if (info?.isDirectory()) await rm(file, { force: true });
}

export function claimRootMigration(
  root: string,
  sessionId: string,
  ticket: string,
  target: MigrationTarget,
) {
  const { directory, file } = pathFor(root, sessionId, ticket);
  if (!lstatSync(directory, { throwIfNoEntry: false })?.isDirectory())
    throw Error("Session root migration was revoked");
  const stat = statSync(file, { throwIfNoEntry: false });
  if (!stat || Date.now() - stat.mtimeMs >= lifetimeMs)
    throw Error("Session root migration was revoked or expired");
  try {
    if (readFileSync(file, "utf8") !== targetIdentity(target))
      throw Error("Session migration target changed");
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw Error("Session root migration was revoked", { cause: error });
    throw error;
  }
}
