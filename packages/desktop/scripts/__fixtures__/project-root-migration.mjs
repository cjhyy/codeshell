/* global window */
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
const migratingId = "host-offline-root-migration";

export async function withdrawPendingRootMigration({
  isolated,
  mount,
  projectId,
  first,
  observeHost,
  fixture,
  application,
}) {
  const migratingDir = join(isolated.codeShellHome, "sessions", migratingId);
  await mkdir(migratingDir);
  const statePath = join(migratingDir, "state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      sessionId: migratingId,
      cwd: mount,
      project: { projectId, mainRootId: "root" },
      workspace: { kind: "main", root: mount },
      stateRevision: 1,
    }),
  );
  // Hold the first worker's stdin with the existing confinement guard. Reload the
  // initiating document while its real ownership handoff is still outstanding.
  await first.evaluate((id) => {
    window.codeshell.projectRegistry.migrateSessionMainRoot(id, "secondary").catch(() => {});
  }, migratingId);
  const grantDir = join(isolated.codeShellHome, "sessions", ".root-migrations");
  const until = async (predicate, message) => {
    const deadline = Date.now() + 12_000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, message);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  await until(
    async () =>
      (await readdir(grantDir).catch(() => [])).length === 1 &&
      (await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8").catch(() => "")).trim()
        .length > 0,
    "Expected the migration grant and the confined worker before reload",
  );
  await first.reload({ waitUntil: "domcontentloaded" });
  await observeHost(first);
  await until(
    async () => (await readdir(grantDir)).length === 0,
    "Reload must withdraw the pending grant",
  );
  const receipt = await fixture.assertWorker(application);
  assert.equal(receipt.spawned.length, 1);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).project.mainRootId, "root");
  return receipt;
}

export async function verifyRootMigrations({
  first,
  second,
  isolated,
  mount,
  secondRoot,
  projectId,
}) {
  const statePath = join(isolated.codeShellHome, "sessions", migratingId, "state.json");
  const moveSession = (page, target) =>
    page.evaluate(
      ([id, root]) => window.codeshell.projectRegistry.migrateSessionMainRoot(id, root),
      [migratingId, target],
    );
  assert.equal((await moveSession(first, "secondary")).mainRoot, secondRoot);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).project.mainRootId, "secondary");
  await assert.rejects(
    second.evaluate(
      (id) => window.codeshell.projectRegistry.removeRoot(id, "secondary"),
      projectId,
    ),
    /main root for sessions/,
  );
  assert.equal((await moveSession(second, "root")).mainRoot, mount);
  const liveId = "host-resident-root-migration";
  const { run, errors } = await first.evaluate(async ({ cwd, projectId, liveId }) => {
    const errors = [];
    const stop = window.codeshell.onStreamEvent(({ sessionId, event }) => {
      if (sessionId === liveId && event.type === "error" && errors.length < 3)
        errors.push(String(event.error).slice(0, 600));
    });
    try {
      const run = await window.codeshell.run("Reply briefly to this local fixture", {
        cwd, projectId, sessionId: liveId, clientMessageId: "host-migration-turn",
      });
      return { run, errors };
    } finally {
      stop();
    }
  }, { cwd: mount, projectId, liveId });
  assert.equal(run.reason, "completed", JSON.stringify({ run, errors }));
  const live = await first.evaluate(
    (id) => window.codeshell.projectRegistry.migrateSessionMainRoot(id, "secondary"),
    liveId,
  );
  assert.equal(live.workspace.root, secondRoot);
  assert.equal(
    (
      await second.evaluate(
        (id) => window.codeshell.projectRegistry.migrateSessionMainRoot(id, "root"),
        liveId,
      )
    ).workspace.root,
    mount,
  );
  const remaining = await first.evaluate(
    (id) => window.codeshell.projectRegistry.removeRoot(id, "secondary"),
    projectId,
  );
  assert.deepEqual(
    remaining.roots.map((root) => root.id),
    ["root"],
  );
  console.log(
    "PASS: both workbenches migrate through the actual Engine claim and registry writer; busy roots stay registered",
  );
}
