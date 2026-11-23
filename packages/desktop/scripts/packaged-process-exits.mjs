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
  requireHostEvidence = false,
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
  let hosts = [],
    hostExits = [];
  if (requireHostEvidence) {
    hosts = await rows(home, "spawned-hosts.jsonl", false);
    hostExits = await rows(home, "host-exits.jsonl", false);
    const mainExits = await rows(home, "main-exits.jsonl", false);
    if (
      !children.every((child) => {
        const pid = mainPid(child);
        const known = hosts.filter((host) => host.ppid === pid);
        const exits = mainExits.filter((x) => x.pid === pid);
        return known.length > 0 && exits.length === 1 && exits[0].hostSpawnCount === known.length;
      }) ||
      !hosts.every((host) => {
        const exits = hostExits.filter((x) => x.pid === host.pid && x.ppid === host.ppid);
        return (
          exits.length === 1 &&
          exits[0].code === 0 &&
          exits[0].workerSpawnCount ===
            spawned.filter((worker) => worker.ppid === host.pid && worker.mainPid === host.ppid)
              .length
        );
      }) ||
      spawned.some(
        (worker) => !hosts.some((host) => host.pid === worker.ppid && host.ppid === worker.mainPid),
      )
    )
      return false;
  }
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
        const count = requireHostEvidence
          ? hostExits.filter((x) => x.ppid === pid).reduce((n, x) => n + x.workerSpawnCount, 0)
          : proofs[0].workerSpawnCount;
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
