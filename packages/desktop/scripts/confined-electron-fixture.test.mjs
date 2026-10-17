import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";

test("guard verification binds the connected actual Main, never a Windows command wrapper", async (t) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "codeshell-confined-main-identity-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const executable = createRequire(import.meta.url)("electron");
  const origin = "http://127.0.0.1:32109";
  const fixture = await prepareConfinedElectronFixture({
    appDir: home,
    isolated: { home },
    origin,
  });
  const ledger = {
    pid: 42,
    ppid: process.pid,
    origin,
    homeId: createHash("sha256").update(home).digest("hex"),
  };
  await writeFile(join(home, "network-guard.jsonl"), JSON.stringify(ledger) + "\n");
  const identity = { pid: 42, ppid: process.pid, executable, home };
  const application = (changes = {}) => ({
    process: () => ({ pid: 42 }),
    evaluate: async () => ({ ...identity, ...changes }),
  });
  const valid = await fixture.assertWorker(application(), { requireWorker: false });
  assert.equal(valid.mainPid, 42);
  assert.deepEqual(valid.mainIdentity, identity);
  assert.equal(valid.workerCreated, false);
  // The ledger intentionally matches the wrapper. Native Main evaluation must
  // reject that apparent proof before issuing any worker permit.
  const forgedWorker = { ...ledger, pid: 44, ppid: 42 };
  const forgedLedger = JSON.stringify(ledger) + "\n" + JSON.stringify(forgedWorker) + "\n";
  await writeFile(join(home, "network-guard.jsonl"), forgedLedger);
  await writeFile(join(home, "spawned-workers.jsonl"), JSON.stringify({ pid: 44 }) + "\n");
  await assert.rejects(fixture.assertWorker(application({ pid: 43 })), /Main PID differs/);
  await assert.rejects(access(join(home, "worker-44.permit")), { code: "ENOENT" });
  await assert.rejects(
    fixture.assertWorker(application({ ppid: 999 }), { requireWorker: false }),
    /Main parent differs/,
  );
  await assert.rejects(
    fixture.assertWorker(application({ home: home + "-foreign" }), { requireWorker: false }),
    /Main HOME differs/,
  );
  const other = join(home, "foreign-executable");
  await writeFile(other, "owned negative fixture only");
  await assert.rejects(
    fixture.assertWorker(application({ executable: other }), { requireWorker: false }),
    /Main executable differs/,
  );
  assert.equal(await readFile(join(home, "network-guard.jsonl"), "utf8"), forgedLedger);
});
