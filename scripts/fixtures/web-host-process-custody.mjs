import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rememberOwnedProcesses } from "../../packages/desktop/scripts/process-custody.mjs";

function snapshotProcesses() {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], {
    encoding: "utf8",
    timeout: 1500,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s*$/.exec(line);
    return match
      ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], birth: match[4], state: match[5] }]
      : [];
  });
}

/** Never authorize a reused PID or signal a changed process group. */
export function createWebHostProcessCustody(
  child,
  {
    snapshot = snapshotProcesses,
    signalProcess = (pid, signal) => process.kill(pid, signal),
    parentPid = process.pid,
  } = {},
) {
  const initial = snapshot();
  const root = initial.find(
    (row) => row.pid === child.pid && row.ppid === parentPid && row.birth && row.pgid,
  );
  assert(root, "Bind the owned Host PID, parent, process group and birth before continuing");
  const owned = new Map([[root.pid, root]]),
    signals = [];
  const observe = () => {
    const current = snapshot();
    rememberOwnedProcesses(
      owned,
      current.filter((row) => {
        const old = owned.get(row.pid);
        return !old || (old.birth === row.birth && old.pgid === row.pgid);
      }),
    );
    return current;
  };
  rememberOwnedProcesses(owned, initial);
  return {
    observe,
    remaining: () =>
      observe().filter(
        (row) => owned.get(row.pid)?.birth === row.birth && !row.state?.startsWith("Z"),
      ),
    signal: (signal) => {
      for (const row of [...owned.values()].reverse()) {
        const current = observe().find((value) => value.pid === row.pid);
        if (
          !current ||
          current.birth !== row.birth ||
          current.pgid !== row.pgid ||
          current.state?.startsWith("Z")
        )
          continue;
        try {
          signalProcess(row.pid, signal);
          signals.push({ pid: row.pid, birth: row.birth, pgid: row.pgid, signal });
        } catch (error) {
          if (error.code !== "ESRCH") throw error;
        }
      }
    },
    evidence: () => ({ owned: [...owned.values()], signals }),
  };
}

/** Every acquired resource is attempted even if another cleanup/report fails. */
export async function finishWebHostOperations({ closeBrowser, closeFixture, report }) {
  const failures = [];
  for (const [action, close] of [
    ["browser.close", closeBrowser],
    ["fixture.close", closeFixture],
  ]) {
    try {
      await close();
    } catch (error) {
      failures.push(new Error(`${action}: ${error.message}`, { cause: error }));
    }
  }
  try {
    await report(failures);
  } catch (error) {
    failures.push(new Error(`report: ${error.message}`, { cause: error }));
  }
  if (failures.length)
    throw new AggregateError(failures, "Web Host operation cleanup or report failed");
}
