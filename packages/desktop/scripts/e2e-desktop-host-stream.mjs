/* Real workbench, utility, stdio worker, journal and approval authority. */
/* global document, window */
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
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
import { discoveredFixtureCall } from "./operation-tool-discovery-fixture.mjs";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const isolated = await makeIsolatedElectronHome("codeshell-host-agent-e2e-");
const textTurn = "codeshell direct stream fixture";
const questionTurn = "codeshell restored question fixture";
const questionLabel = "Keep the fixture running?";
const textSession = "host-stream-session";
const questionSession = "host-question-session";
const expectedText = "The plain streaming smoke response completed.";
let providerReached = false;
let providerPhase = "text";
const releaseProvider = Promise.withResolvers();
const releaseSuffix = Promise.withResolvers();
let app, model, win;
const processLog = [];
async function waitFor(check, message, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

async function observe() {
  await win.evaluate(() => {
    window.__agentProbe = { events: [], states: [] };
    window.codeshell.onDesktopHostStatus((value) => window.__agentProbe.states.push(value));
    window.codeshell.onStreamEvent((env) =>
      window.__agentProbe.events.push({ env, at: Date.now() }),
    );
  });
  await win.waitForFunction(() => window.__agentProbe.states.at(-1) === "ready");
}

async function run(prompt, sessionId, cwd) {
  await win.evaluate(
    ({ prompt, sessionId, cwd }) => {
      // The UI can reload during a turn. Record only the response on this document.
      void window.codeshell
        .run(prompt, { sessionId, cwd, model: "local-mock", clientMessageId: sessionId + "-input" })
        .then(
          (result) => {
            window.__agentProbe.result = result;
          },
          (error) => {
            window.__agentProbe.error = String(error);
          },
        );
    },
    { prompt, sessionId, cwd },
  );
}

try {
  model = await startMockProviderServer({
    scriptResponse: async (body) => {
      const messages = body.messages ?? [];
      if (providerPhase === "text") {
        providerReached = true;
        await releaseProvider.promise;
        return { afterChunk: (index) => (index === 0 ? releaseSuffix.promise : undefined) };
      }
      if (
        messages.some(
          (message) => message.role === "tool" && message.tool_call_id === "fixture-question",
        )
      )
        return { scenario: "tool-call" };
      const discovery = messages.find(
        (message) => message.role === "tool" && message.tool_call_id === "fixture-discover",
      );
      const call = discoveredFixtureCall(
        body.tools?.map((tool) => tool.function.name) ?? [],
        discovery,
        { id: "fixture-question", toolName: "AskUserQuestion", args: { question: questionLabel } },
        "fixture-discover",
      );
      return { scenario: "tool-call", toolCall: call };
    },
  });
  const fixture = await prepareConfinedElectronFixture({ appDir, isolated, origin: model.origin });
  const cwd = join(isolated.codeShellHome, "no-repo");
  await mkdir(cwd, { recursive: true });
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
          tag: "text",
          model: "deepseek-v4-flash",
          credentialId: "local-mock",
        },
      ],
      defaults: { text: "local-mock" },
    }),
    { mode: 0o600 },
  );
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    env: fixture.env,
    mainEntry: fixture.mainEntry,
    runtimeTimeoutMs: 155_000,
  });
  for (const stream of [app.process().stdout, app.process().stderr])
    stream?.on("data", (data) => {
      processLog.push(String(data));
      if (processLog.length > 160) processLog.shift();
    });
  win = await findCodeShellWindow(app);
  await observe();
  await run(textTurn, textSession, cwd);
  const custody = await fixture.assertWorker(app);
  assert(custody.workerCreated);
  await waitFor(() => providerReached, "Provider did not receive the real worker turn");
  const marker = join(isolated.home, "main-paused");
  const nativeWindow = await app.browserWindow(win);
  const measure = nativeWindow.evaluate(async (_window, marker) => {
    const begin = Date.now();
    process.getBuiltinModule("node:fs").writeFileSync(marker, "", { mode: 0o600 });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2800);
    return { begin, end: Date.now() };
  }, marker);
  await waitFor(
    () =>
      access(marker).then(
        () => true,
        () => false,
      ),
    "Main did not enter the fixture pause",
  );
  releaseProvider.resolve();
  const pause = await measure;
  await nativeWindow.dispose();
  await win.waitForFunction(
    (id) =>
      window.__agentProbe.events.some(
        ({ env }) => env.sessionId === id && env.event.type === "text_delta",
      ),
    textSession,
  );
  const first = await win.evaluate(
    (id) =>
      window.__agentProbe.events.find(
        ({ env }) => env.sessionId === id && env.event.type === "text_delta",
      ),
    textSession,
  );
  const firstCursor = first.env.event.outputCursor;
  assert.ok(firstCursor, "Paired live text has its durable cursor");
  assert.ok(
    Number.isSafeInteger(first.env.seq) && first.env.epoch,
    "Live text belongs to a Host snapshot sequence",
  );
  assert(expectedText.startsWith(first.env.event.text) && first.env.event.text !== expectedText);
  const direct = first.at >= pause.begin && first.at < pause.end;
  // Drop the document with its outstanding agent/run and release the retained
  // provider suffix before installing this test's next live listener.
  await win.reload({ waitUntil: "domcontentloaded" });
  releaseSuffix.resolve();
  await observe();
  await waitFor(
    () =>
      win.evaluate(
        async (id) =>
          (await window.codeshell.subscribeSession(id, 0)).events.some(
            (row) => row.event.type === "turn_complete",
          ),
        textSession,
      ),
    "The worker did not finish the reloaded session",
  );
  const missed = await win.evaluate(
    async ({ id, cursor, seq }) => {
      const snapshot = await window.codeshell.subscribeSession(id, seq);
      const page = await window.codeshell.getSessionOutputJournal(id, { after: cursor });
      return { snapshot, page };
    },
    { id: textSession, cursor: firstCursor, seq: first.env.seq },
  );
  const suffix = missed.page.frames
    .filter((frame) => frame.event?.type === "text_delta")
    .map((frame) => frame.event.text)
    .join("");
  assert.equal(first.env.event.text + suffix, expectedText);
  assert(
    !missed.page.frames.some((frame) => frame.cursor === firstCursor),
    "The replay cursor is exclusive",
  );
  assert.equal(
    missed.snapshot.events
      .filter((row) => row.event.type === "text_delta")
      .map((row) => row.event.text)
      .join(""),
    suffix,
  );
  assert(
    missed.page.frames.some((frame) => frame.cursor === missed.snapshot.outputCursor),
    "Journal covered the snapshot tail",
  );
  providerPhase = "question";
  await run(questionTurn, questionSession, cwd);
  await fixture.assertWorker(app);
  let initialApproval;
  await waitFor(async () => {
    initialApproval = await win.evaluate(
      async (id) =>
        (await window.codeshell.getPendingApprovals()).find((row) => row.sessionId === id),
      questionSession,
    );
    return initialApproval;
  }, "The worker did not request its fixture question");
  assert.equal(initialApproval.request.toolName, "__ask_user__");
  await win.reload({ waitUntil: "domcontentloaded" });
  await observe();
  const recovered = await win.evaluate(
    async ({ textSession, questionSession, priorTail }) => {
      const snapshot = await window.codeshell.subscribeSession(textSession, 0);
      const after = await window.codeshell.getSessionOutputJournal(textSession, {
        after: priorTail,
      });
      const pending = (await window.codeshell.getPendingApprovals()).filter(
        (row) => row.sessionId === questionSession,
      );
      return { snapshot, after, pending };
    },
    { textSession, questionSession, priorTail: missed.snapshot.outputCursor },
  );
  assert.equal(
    recovered.snapshot.events
      .filter((row) => row.event.type === "text_delta")
      .map((row) => row.event.text)
      .join(""),
    expectedText,
  );
  // A trailing usage or accounting frame can legitimately follow turn_complete.
  assert(
    recovered.after.frames.every(
      (frame) =>
        frame.cursor !== missed.snapshot.outputCursor &&
        frame.event?.type !== "text_delta" &&
        frame.event?.type !== "turn_complete",
    ),
    "Resuming at the completed turn cannot repeat content or completion",
  );
  assert.deepEqual(
    recovered.pending.map((row) => row.requestId),
    [initialApproval.requestId],
  );
  await win.evaluate(
    ({ id, requestId }) => window.codeshell.approve(id, requestId, "approve", undefined, "yes"),
    { id: questionSession, requestId: initialApproval.requestId },
  );
  await waitFor(
    () =>
      win.evaluate(
        async (id) =>
          !(await window.codeshell.getPendingApprovals()).some((row) => row.sessionId === id),
        questionSession,
      ),
    "The answered question remained pending",
  );
  await win.waitForFunction(
    (id) =>
      window.__agentProbe.events.some(
        ({ env }) => env.sessionId === id && env.event.type === "turn_complete",
      ),
    questionSession,
  );
  assert(direct, "No text arrived on the workbench port during the Main pause");
  console.log(
    "PASS: real worker streams while Main is busy and resumes exactly the withheld suffix across a document reload",
  );
  console.log(
    "PASS: workbench reload rejoins the journal tail and restores exactly one actionable worker question",
  );
} catch (error) {
  console.error(processLog.join("").slice(-7000));
  console.error(
    "Provider requests",
    model?.requests.map(({ scenario, body }) => ({
      scenario,
      tools: body.tools?.length,
      role: body.messages?.at(-1)?.role,
      latestTool: body.messages?.findLast((row) => row.role === "tool")?.tool_call_id,
    })),
  );
  console.error(
    "Workbench",
    await win
      ?.evaluate(() => ({
        result: window.__agentProbe.result,
        error: window.__agentProbe.error,
        events: window.__agentProbe.events
          .slice(-10)
          .map(({ env }) => ({ id: env.sessionId, type: env.event.type })),
        body: document.body.innerText.slice(-800),
      }))
      .catch(() => undefined),
  );
  throw error;
} finally {
  releaseProvider.resolve();
  releaseSuffix.resolve();
  try {
    await app?.close();
  } finally {
    await model?.close();
    await isolated.cleanup();
  }
}
