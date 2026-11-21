/* Real scheduled one-shot Engine, utility, journal and workbench. */
/* global window */
import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";
import { startMockProviderServer } from "./mock-provider-server.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const isolated = await makeIsolatedElectronHome("codeshell-hosted-automation-");
const release = Promise.withResolvers();
const releaseInterrupted = Promise.withResolvers();
const interrupted = Promise.withResolvers();
let interruptedRequests = 0;
let model, app, job, win;
let requestedAt = 0;
const logs = [];
try {
  model = await startMockProviderServer({
    scriptResponse: async (body) => {
      if (JSON.stringify(body.messages).includes("Synthetic interrupt fixture")) {
        interruptedRequests++;
        interrupted.resolve();
        await releaseInterrupted.promise;
        return;
      }
      requestedAt = Date.now();
      await release.promise;
    },
  });
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({
      autoUpdates: false,
      credentials: [
        { id: "local-mock", catalogId: "deepseek", apiKey: "fixture", baseUrl: model.baseUrl },
      ],
      modelConnections: [
        {
          id: "local-mock",
          catalogId: "deepseek",
          model: "deepseek-v4-flash",
          tag: "text",
          credentialId: "local-mock",
        },
      ],
      defaults: { text: "local-mock" },
    }),
    { mode: 0o600 },
  );
  const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: model.origin });
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: fixture.env,
    mainEntry: fixture.mainEntry,
  });
  for (const stream of [app.process().stdout, app.process().stderr])
    stream?.on("data", (chunk) => {
      logs.push(String(chunk));
      if (logs.length > 120) logs.shift();
    });
  win = await findCodeShellWindow(app);
  await win.evaluate(() => {
    window.__cron = { events: [], status: [], sessions: [] };
    window.codeshell.onStreamEvent((env) => window.__cron.events.push({ env, at: Date.now() }));
    window.codeshell.onAutomationSession((meta) => window.__cron.sessions.push(meta));
    window.codeshell.onDesktopHostStatus((status) => window.__cron.status.push(status));
  });
  await win.waitForFunction(() => window.__cron.status.at(-1) === "ready");
  const nativeWindow = await app.browserWindow(win);
  job = await win.evaluate(() =>
    window.codeshell.createAutomation({
      name: "Host smoke",
      schedule: "2s",
      once: true,
      prompt: "Synthetic automation fixture",
      permissionLevel: "read-only",
    }),
  );
  const marker = join(isolated.home, "busy");
  const stall = nativeWindow.evaluate((_window, marker) => {
    const from = Date.now();
    process.getBuiltinModule("node:fs").writeFileSync(marker, "", { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6000);
    return { from, to: Date.now() };
  }, marker);
  const deadline = Date.now() + 10000;
  while (
    !(await access(marker).then(
      () => true,
      () => false,
    ))
  ) {
    assert(Date.now() < deadline, "Main did not enter the fixture hold");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  release.resolve();
  const { from, to } = await stall;
  await nativeWindow.dispose();
  assert(
    requestedAt >= from && requestedAt < to,
    "The storage-thread deadline must fire while Main is busy",
  );
  await win.waitForFunction(
    (id) => window.__cron.sessions.some((entry) => entry.cronJobId === id),
    job.id,
    { timeout: 30000 },
  );
  const { sessionId } = await win.evaluate(
    (id) => window.__cron.sessions.find((entry) => entry.cronJobId === id),
    job.id,
  );

  await win.waitForFunction(
    (id) =>
      window.__cron.events.some(
        ({ env }) => env.sessionId === id && env.event.type === "turn_complete",
      ),
    sessionId,
  );
  const events = await win.evaluate(
    (id) => window.__cron.events.filter(({ env }) => env.sessionId === id),
    sessionId,
  );
  const text = events.filter(({ env }) => env.event.type === "text_delta");
  assert(
    text.length && text.some(({ at }) => at >= from && at < to),
    "Headless Engine must publish live output while Main is busy",
  );
  assert(
    text.every(({ env }) => env.event.outputCursor && env.epoch && env.seq),
    "Host output must have a journal cursor and sequence",
  );
  const { frames } = await win.evaluate(
    (id) => window.codeshell.getSessionOutputJournal(id, {}),
    sessionId,
  );
  assert.equal(
    frames
      .filter(({ event }) => event.type === "text_delta")
      .map(({ event }) => event.text)
      .join(""),
    text.map(({ env }) => env.event.text).join(""),
  );
  console.log(
    "PASS: Host timer fired and scheduled Engine streamed during a Main pause and its output matched the journal",
  );
  const uncertain = await win.evaluate(() =>
    window.codeshell.createAutomation({
      name: "Interrupted once",
      schedule: "1s",
      once: true,
      prompt: "Synthetic interrupt fixture",
      permissionLevel: "read-only",
    }),
  );
  await Promise.race([
    interrupted.promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Error("Interrupt fixture did not reach provider")), 15000).unref(),
    ),
  ]);
  const receiptPath = join(isolated.codeShellHome, "cron-deliveries.json");
  const readReceipts = async () => JSON.parse(await readFile(receiptPath, "utf8")).receipts;
  assert(
    (await readReceipts()).some(
      (row) => row.notice.job.id === uncertain.id && row.state === "running",
    ),
  );
  const launches = async () =>
    (await readFile(join(isolated.home, "spawned-hosts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const host = (await launches()).at(-1);
  const own = await app.evaluate(
    ({ app }, pid) => ({
      main: process.pid,
      utility: app.getAppMetrics().some((row) => row.type === "Utility" && row.pid === pid),
    }),
    host.pid,
  );
  assert(
    own.utility && own.main === host.ppid,
    "Only terminate the test's observed desktop utility",
  );
  process.kill(host.pid, "SIGKILL");
  releaseInterrupted.resolve();
  const recoveryDeadline = Date.now() + 15000;
  while (true) {
    const jobs = JSON.parse(await readFile(join(isolated.codeShellHome, "cron.json"), "utf8")).jobs;
    if (
      (await launches()).at(-1).pid !== host.pid &&
      !jobs.some((row) => row.id === uncertain.id) &&
      !(await readReceipts()).some((row) => row.notice.job.id === uncertain.id)
    )
      break;
    assert(
      Date.now() < recoveryDeadline,
      "Replacement Host did not recover the interrupted one-shot and acknowledge its notification",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.equal(await win.evaluate((id) => window.codeshell.getAutomation(id), uncertain.id), null);
  assert.equal(
    interruptedRequests,
    1,
    "Recovering a claimed one-shot must not run the model twice",
  );
  console.log(
    "PASS: fresh Host retired the interrupted one-shot and acknowledged its notification without replay",
  );
} catch (error) {
  console.error(logs.join("").slice(-7500));
  if (win && job)
    console.error(
      "Cron",
      await win.evaluate((id) => window.codeshell.getAutomation(id), job.id).catch(() => null),
    );
  throw error;
} finally {
  release.resolve();
  releaseInterrupted.resolve();
  try {
    await app?.close();
  } finally {
    await model?.close();
    await isolated.cleanup();
  }
}
