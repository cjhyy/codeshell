/* Real scheduled one-shot Engine, utility, journal and workbench. */
/* global window */
import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
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
let model, app, job, win;
const logs = [];
try {
  model = await startMockProviderServer({
    scriptResponse: async () => {
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
  job = await win.evaluate(async () => {
    const job = await window.codeshell.createAutomation({
      name: "Host smoke",
      schedule: "0 0 1 1 *",
      prompt: "Synthetic automation fixture",
      permissionLevel: "read-only",
    });
    if (!(await window.codeshell.runAutomationNow(job.id)))
      throw Error("Automation was not accepted");
    return job;
  });
  await win.waitForFunction(
    (id) => window.__cron.sessions.some((entry) => entry.cronJobId === id),
    job.id,
    { timeout: 30000 },
  );
  const { sessionId } = await win.evaluate(
    (id) => window.__cron.sessions.find((entry) => entry.cronJobId === id),
    job.id,
  );
  const marker = join(isolated.home, "busy");
  const nativeWindow = await app.browserWindow(win);
  const stall = nativeWindow.evaluate((_window, marker) => {
    const from = Date.now();
    process.getBuiltinModule("node:fs").writeFileSync(marker, "", { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2800);
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
    "PASS: scheduled Host Engine streamed during a Main pause and its output matched the journal",
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
  try {
    await app?.close();
  } finally {
    await model?.close();
    await isolated.cleanup();
  }
}
