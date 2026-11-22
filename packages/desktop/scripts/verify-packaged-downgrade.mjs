/* global window */
import assert from "node:assert/strict";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { release } from "node:os";
import {
  findCodeShellWindow,
  makeIsolatedElectronHome,
  navigateSettingsMenu,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { preparePackagedPetFixture } from "./packaged-pet-fixture.mjs";

assert.equal(process.platform, "darwin");
assert.equal(process.env.NODE_ENV, "test", "Launch through run-isolated-node-smoke.mjs");
assert.equal(process.argv.length, 4, "Pass the 0.12 and 0.11 app bundle paths");
const [candidate, previous] = process.argv.slice(2).map((p) => resolve(p));
const root = await makeIsolatedElectronHome("codeshell-packaged-downgrade-");
const home = join(root.home, "profile");
const codeShellHome = join(home, ".code-shell");
const isolated = { home, codeShellHome, userDataDir: join(home, "chromium") };
const draft = { id: "release-downgrade-draft", title: "Release downgrade draft" };
const transcriptText = "Offline downgrade transcript receipt";
const external = { id: "release-downgrade-external", title: "Release downgrade external task" };
let fixture,
  app,
  page,
  canRemove = true;
async function launch(path, version) {
  const fixtureRoot = root.home;
  await mkdir(join(root.home, version));
  fixture = await preparePackagedPetFixture({
    officialApp: path,
    isolated,
    fixtureRoot,
    origin: "http://127.0.0.1:9",
    mockKeychain: true,
    requireWorkerEvidence: false,
    legacyMainWorker: version === "0.11",
  });
  canRemove = false;
  app = await fixture.launch();
  const actual = await app.evaluate(({ app }) => app.getVersion());
  assert.ok(actual.startsWith(version + "."), actual);
  page = await findCodeShellWindow(app);
  return actual;
}
async function close() {
  if (!fixture) return;
  if (app) {
    const workers = await readFile(join(home, "spawned-workers.jsonl"), "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return "";
    });
    if (workers.trim()) await fixture.assertWorker(app);
    console.log("Requesting normal application exit", app.process().pid);
    await app.close();
  }
  app = undefined;
  assert.ok(await fixture.canCleanup(), "Packaged process exit receipts are incomplete");
  const integrity = await fixture.verifyUnchanged();
  canRemove = true;
  fixture = undefined;
  return integrity.appTreeSHA256;
}
async function findTask() {
  const deadline = Date.now() + 45000;
  let observed;
  do {
    const rows = await page.evaluate(
      async () => (await window.codeshell.taskInbox.list({ limit: 200 })).records,
    );
    const record = rows.find(
      (row) => row.source === "external-runtime" && row.sourceId === external.id,
    );
    if (record) return record;
    observed = rows.map(({ source, sourceId }) => ({ source, sourceId }));
    await new Promise((resolve) => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  throw Error("Missing synthetic external task in packaged UI: " + JSON.stringify(observed));
}
try {
  await mkdir(codeShellHome, { recursive: true, mode: 0o700 });
  await seedOfflinePluginBootstrap(codeShellHome);
  await writeFile(join(codeShellHome, "settings.json"), JSON.stringify({ autoUpdates: false }), {
    mode: 0o600,
  });
  // Materialize the same on-disk facts a completed, offline external CLI leaves.
  const dir = join(codeShellHome, "sessions", external.id);
  await mkdir(dir, { recursive: true });
  const now = Date.now();
  await writeFile(
    join(dir, "external-runtime.json"),
    JSON.stringify({
      version: 1,
      kind: "codex",
      cwd: home,
      runtimeSessionId: "synthetic-provider-id",
      updatedAt: now,
    }),
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, "transcript.jsonl"),
    JSON.stringify({
      id: "fixture-input",
      type: "message",
      timestamp: now,
      data: { role: "user", content: transcriptText, clientMessageId: "fixture-input" },
    }) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(dir, "state.json"),
    JSON.stringify({
      sessionId: external.id,
      parentSessionId: null,
      origin: "desktop",
      cwd: home,
      title: external.title,
      startedAt: now,
      status: "active",
      messages: [],
    }),
    { mode: 0o600 },
  );
  const from = await launch(candidate, "0.12");
  console.log("Opened packaged candidate", from);
  await page.evaluate(async ({ id, title }) => {
    const now = Date.now();
    await window.codeshell.sessionCatalog.apply({
      projectKey: "__no_repo__",
      upserts: [
        {
          id,
          values: {
            title,
            titleManual: true,
            pendingFirstRun: true,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
      activeSessionId: id,
    });
  }, draft);
  const record = await findTask();
  console.log("0.12 persisted draft and projected external task", record.sourceId);
  assert.ok(record.capabilities.includes("open"));
  const candidateTree = await close();
  const mirror = JSON.parse(
    await readFile(join(isolated.userDataDir, "task-inbox", "v1.json"), "utf8"),
  );
  // This task still has its external-runtime sidecar. The compatibility
  // mirror only stores orphaned projections, which 0.11 cannot reconstruct.
  assert.equal(mirror.schemaVersion, 1);
  assert.ok(Array.isArray(mirror.records));
  // Each launcher requires its own diagnostics. Preserve the first launch's
  // temporary files separately while both binaries open the very same profile.
  await rename(
    join(root.home, "official-app-before.json"),
    join(root.home, "0.12", "official-app-before.json"),
  );
  for (const name of [
    "packaged-host-wrapper.mjs",
    "tmp",
    "network-guard.jsonl",
    "main-exits.jsonl",
    "spawned-hosts.jsonl",
    "host-exits.jsonl",
    "spawned-workers.jsonl",
    "worker-exits.jsonl",
  ]) {
    try {
      await rename(join(home, name), join(root.home, "0.12", name));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const to = await launch(previous, "0.11");
  console.log("Opened packaged previous version", to);
  const stored = await page.evaluate(
    async (id) =>
      (await window.codeshell.sessionCatalog.load()).indices.__no_repo__?.sessions.find(
        (row) => row.id === id,
      ),
    draft.id,
  );
  assert.equal(stored?.title, draft.title);
  assert.equal(stored.pendingFirstRun, true);
  // A fresh 0.11 profile asks about its isolated no-repo workspace. Viewing
  // a recovered draft or transcript needs no write tools.
  await page.getByRole("button", { name: /仅查看|View only/i }).click();
  await page.getByText(draft.title, { exact: true }).first().click({ timeout: 10000 });
  const reopened = await findTask();
  assert.equal(reopened.taskKey, record.taskKey);
  const result = await page.evaluate(
    (row) =>
      window.codeshell.taskInbox.act({
        taskKey: row.taskKey,
        action: "open",
        expectedRevision: row.sourceRevision,
      }),
    reopened,
  );
  assert.equal(result.status, "ok", JSON.stringify(result));
  // Ordinary external conversations are listed in 0.11's conversation history.
  await navigateSettingsMenu(page, "会话管理", { activity: true });
  const item = page
    .locator("[data-sessions-page]")
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", { name: reopened.title, exact: true }),
    });
  await item.getByRole("button", { name: "打开会话", exact: true }).click();
  await page.getByText(transcriptText, { exact: true }).first().waitFor();
  const previousTree = await close();
  console.log(
    JSON.stringify({
      from,
      to,
      darwin: release(),
      arch: process.arch,
      candidateTree,
      previousTree,
      draftOpened: true,
      externalTaskOpened: true,
      transcriptRead: true,
      mirrorVersion: mirror.schemaVersion,
    }),
  );
} catch (error) {
  console.error("Packaged downgrade failed at", root.home, error);
  throw error;
} finally {
  try {
    if (app) await close();
  } finally {
    if (canRemove) await root.cleanup();
  }
}
