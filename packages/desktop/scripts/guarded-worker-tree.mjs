import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Require both the observed fork and the child's own pre-import receipt at
 * each hop. Callers independently validate the storage and network receipts. */
export async function guardedWorkerTree(home, mainPid, receipts, ready = () => true) {
  const text = await readFile(join(home, "spawned-hosts.jsonl"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const hosts = new Set(
    text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse)
      .filter(
        (row) =>
          row.ppid === mainPid &&
          receipts.some((r) => r.pid === row.pid && r.ppid === mainPid && ready(r)),
      )
      .map((row) => row.pid),
  );
  return {
    hasWorker(worker) {
      return (
        hosts.has(worker.ppid) &&
        receipts.some((r) => r.pid === worker.pid && r.ppid === worker.ppid && ready(r))
      );
    },
    belongs(receipt) {
      return receipt.pid === mainPid || hosts.has(receipt.pid) || hosts.has(receipt.ppid);
    },
  };
}
