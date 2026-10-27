import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWebHostProcessCustody,
  finishWebHostOperations,
} from "./web-host-process-custody.mjs";

// Births use the `ps -o lstart` form custody validates; later seconds mean a later process.
const born = (second) => `Tue Oct 27 10:00:${String(second).padStart(2, "0")} 2026`;

test("reused Host PID cannot authorize or signal a new incarnation or its child", () => {
  let rows = [{ pid: 10, ppid: 1, pgid: 10, birth: born(0) }];
  const calls = [];
  const custody = createWebHostProcessCustody(
    { pid: 10 },
    { parentPid: 1, snapshot: () => rows, signalProcess: (...args) => calls.push(args) },
  );
  rows = [
    { pid: 10, ppid: 1, pgid: 10, birth: born(5) },
    { pid: 11, ppid: 10, pgid: 10, birth: born(6) },
  ];
  custody.signal("SIGKILL");
  assert.deepEqual(calls, []);
  assert.deepEqual(custody.remaining(), []);
  assert.equal(custody.evidence().owned.length, 1);
});

test("an observed Worker survives reparenting but every signal rechecks its birth and group", () => {
  let rows = [
    { pid: 10, ppid: 1, pgid: 10, birth: born(0) },
    { pid: 11, ppid: 10, pgid: 10, birth: born(1) },
  ];
  const calls = [];
  const custody = createWebHostProcessCustody(
    { pid: 10 },
    { parentPid: 1, snapshot: () => rows, signalProcess: (...args) => calls.push(args) },
  );
  rows = [{ pid: 11, ppid: 1, pgid: 10, birth: born(1) }];
  custody.signal("SIGTERM");
  assert.deepEqual(calls, [[11, "SIGTERM"]]);
  rows = [{ pid: 11, ppid: 1, pgid: 50, birth: born(1) }];
  custody.signal("SIGKILL");
  assert.deepEqual(calls, [[11, "SIGTERM"]]);
  assert.equal(custody.remaining().length, 1, "Changed group stays an explicit unresolved cleanup");
  rows = [{ pid: 11, ppid: 1, pgid: 10, birth: born(9) }];
  custody.signal("SIGKILL");
  assert.deepEqual(calls, [[11, "SIGTERM"]]);
});

for (const fault of ["browser", "fixture", "report"])
  test(`${fault} failure still attempts all acquired cleanup and keeps failure evidence`, async () => {
    const calls = [];
    await assert.rejects(
      finishWebHostOperations({
        closeBrowser: async () => {
          calls.push("browser");
          if (fault === "browser") throw new Error("owned failure");
        },
        closeFixture: async () => {
          calls.push("fixture");
          if (fault === "fixture") throw new Error("owned failure");
        },
        report: async (failures) => {
          calls.push("report");
          assert.equal(failures.length, fault === "report" ? 0 : 1);
          if (fault === "report") throw new Error("owned failure");
        },
      }),
      AggregateError,
    );
    assert.deepEqual(calls, ["browser", "fixture", "report"]);
  });
