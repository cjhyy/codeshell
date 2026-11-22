// This bootstrap observes the real worker's exclusive mkdir on the fixture's
// held publish lock. Its Git, lock retries and cleanup all run unmodified.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, relative } from "node:path";
import threads, { isMainThread, threadId, workerData } from "node:worker_threads";

export function observeMarketplaceWorker(entry, heldLock, receipt) {
  const Worker = threads.Worker;
  threads.Worker = class extends Worker {
    constructor(url, options) {
      if (url?.href === entry) {
        super(new URL(import.meta.url), {
          ...options,
          workerData: { ...options.workerData, lockWitness: { entry, heldLock, receipt } },
        });
      } else super(url, options);
    }
  };
  syncBuiltinESMExports();
}

if (!isMainThread && workerData?.lockWitness) {
  const { entry, heldLock, receipt } = workerData.lockWitness;
  const mkdir = fs.mkdirSync;
  let recorded = false;
  fs.mkdirSync = function (target, ...args) {
    try {
      return mkdir.call(this, target, ...args);
    } catch (error) {
      if (
        !recorded &&
        error.code === "EEXIST" &&
        typeof target === "string" &&
        basename(target) === basename(heldLock) &&
        relative(fs.realpathSync(target), fs.realpathSync(heldLock)) === ""
      ) {
        fs.writeFileSync(receipt, JSON.stringify({ pid: process.pid, threadId }), {
          flag: "wx",
          mode: 0o600,
        });
        recorded = true;
      }
      throw error;
    }
  };
  syncBuiltinESMExports();
  await import(entry);
}
