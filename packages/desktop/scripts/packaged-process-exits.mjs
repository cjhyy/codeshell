import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function rows(home, name, allowMissing) {
  const contents = await readFile(join(home, name), "utf8").catch((error) => {
    if (allowMissing && error.code === "ENOENT") return "";
    throw error;
  });
  return contents.trim().split("\n").filter(Boolean).map(JSON.parse);
}

/** A missing worker log alone never proves that no worker was created. UI-only
 * fixtures also need each guarded Main's normal-exit spawn counter receipt. */
export async function canCleanupPackagedProcesses({
  home,
  requireWorkerEvidence = true,
  launchFailed,
  children,
  verifiedMains,
  verifiedWorkerMains,
  workers,
  mainPidByChild = new Map(),
}) {
  const mainPid = (child) => mainPidByChild.get(child) ?? child.pid;
  if (
    launchFailed ||
    !children.length ||
    !children.every(
      (child) =>
        verifiedMains.has(mainPid(child)) && (child.exitCode !== null || child.signalCode !== null),
    )
  )
    return false;
  const spawned = await rows(home, "spawned-workers.jsonl", !requireWorkerEvidence);
  const exits = await rows(home, "worker-exits.jsonl", !requireWorkerEvidence);
  if (
    spawned.some((row) => !Number.isSafeInteger(row.pid) || row.pid <= 0) ||
    exits.some(
      (row) =>
        !Number.isSafeInteger(row.pid) ||
        row.pid <= 0 ||
        (!Number.isInteger(row.code) && !(typeof row.signal === "string" && row.signal.length > 0)),
    )
  )
    return false;
  if (requireWorkerEvidence) {
    if (!workers.size || !children.every((child) => verifiedWorkerMains.has(mainPid(child))))
      return false;
  } else {
    const mainExits = await rows(home, "main-exits.jsonl", false);
    if (
      !children.every((child) => {
        const pid = mainPid(child);
        const proofs = mainExits.filter((row) => row.pid === pid);
        if (proofs.length !== 1) return false;
        // A real AppImage runtime has a separate launcher PID and propagates
        // its child's exit. Require both independently observed normal exits.
        if (
          mainPidByChild.has(child) &&
          (child.exitCode !== 0 || child.signalCode !== null || proofs[0].code !== 0)
        )
          return false;
        const count = proofs[0].workerSpawnCount;
        return (
          Number.isSafeInteger(count) &&
          count >= 0 &&
          count === spawned.filter((worker) => worker.mainPid === pid).length &&
          (count === 0 || verifiedWorkerMains.has(pid))
        );
      }) ||
      spawned.some((worker) => !children.some((child) => mainPid(child) === worker.mainPid))
    )
      return false;
  }
  return [...workers, ...spawned.map((worker) => worker.pid)].every((pid) =>
    exits.some((exit) => exit.pid === pid),
  );
}
