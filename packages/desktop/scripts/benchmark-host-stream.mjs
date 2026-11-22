/* global window, performance, document */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { release } from "node:os";
import { open, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import { startMockProviderServer } from "./mock-provider-server.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
  seedOfflinePluginBootstrap,
} from "./electron-harness.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use run-isolated-node-smoke.mjs");
assert.equal(process.argv.length, 3, "Pass a new evidence directory");
const evidence = resolve(process.argv[2]);
await mkdir(evidence, { mode: 0o700 });
const appDir = fileURLToPath(new URL("../", import.meta.url));
const isolated = await makeIsolatedElectronHome("codeshell-stream-benchmark-");
const startStream = Promise.withResolvers();
const releaseStream = Promise.withResolvers();
const prompt = "Benchmark stream to the local workbench.";
const tracePath = join(evidence, "trace.json");
let app,
  provider,
  writer,
  client,
  tracing = false,
  streamAt,
  emitted = 0;

async function sampleReads(page, count) {
  return page.evaluate(async (count) => {
    const samples = [];
    for (let i = 0; i < count; i++) {
      const start = performance.now();
      const page = await window.codeshell.listDiskSessions({ limit: 20 });
      if (!Array.isArray(page.sessions)) throw Error("Expected indexed session page");
      samples.push(performance.now() - start);
    }
    return samples;
  }, count);
}
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
try {
  provider = await startMockProviderServer({
    scriptResponse(body) {
      if (!JSON.stringify(body.messages).includes(prompt) || !body.stream) return;
      return {
        textChunks: Array.from({ length: 520 }, (_, i) => "word" + i + " "),
        async afterChunk(index) {
          if (index === 0) {
            startStream.resolve();
            await releaseStream.promise;
            streamAt = performance.now();
          }
          emitted++;
          await delay(Math.max(0, streamAt + (index + 1) * 44 - performance.now()));
        },
      };
    },
  });
  await seedOfflinePluginBootstrap(isolated.codeShellHome);
  const cwd = join(isolated.codeShellHome, "no-repo");
  await mkdir(cwd, { recursive: true });
  await writeFile(
    join(isolated.codeShellHome, "settings.json"),
    JSON.stringify({
      autoUpdates: false,
      credentials: [
        { id: "trace-key", catalogId: "openai", apiKey: "synthetic", baseUrl: provider.baseUrl },
      ],
      modelConnections: [
        {
          id: "trace",
          catalogId: "openai",
          tag: "text",
          model: "gpt-4o",
          credentialId: "trace-key",
        },
      ],
      defaults: { text: "trace" },
    }),
    { mode: 0o600 },
  );
  const fixture = await prepareConfinedElectronFixture({
    appDir,
    isolated,
    origin: provider.origin,
  });
  app = await launchCodeShellElectron({
    appDir,
    ...isolated,
    mainEntry: fixture.mainEntry,
    env: { ...fixture.env, CODESHELL_E2E_MOCK_KEYCHAIN: "1" },
    runtimeTimeoutMs: 150000,
  });
  const page = await findCodeShellWindow(app);
  await page.evaluate(() => {
    window.codeshell.onDesktopHostStatus((s) => {
      window.benchmarkHost = s;
    });
  });
  await page.waitForFunction(() => window.benchmarkHost === "ready");
  page.setDefaultTimeout(15000);
  const viewOnly = page
    .getByRole("dialog")
    .filter({ hasText: cwd })
    .getByRole("button", { name: /^(仅查看|View only)/i });
  await page.addLocatorHandler(viewOnly, (button) => button.click(), { times: 1 });
  const { pid, electron } = await app.evaluate(() => ({
    pid: process.pid,
    electron: process.versions.electron,
  }));
  await sampleReads(page, 10);
  const idle = await sampleReads(page, 200);
  const storage = join(isolated.codeShellHome, ".codeshell-state");
  const roots = await readdir(storage);
  assert.equal(roots.length, 1);
  const dbPath = join(storage, roots[0], "current", "state.sqlite");
  writer = new DatabaseSync(dbPath);
  assert.equal(writer.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  client = await page.context().newCDPSession(page);
  // Keep old and new revisions so a lifecycle transition can be distinguished
  // from updating a task record on each piece of assistant output.
  writer.exec(`CREATE TABLE benchmark_task_changes (
    at_ms INTEGER, event TEXT, task_key TEXT, source TEXT, previous_status TEXT, status TEXT,
    previous_revision TEXT, revision TEXT
  )`);
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    const old = (field) => (event === "INSERT" ? "NULL" : "OLD." + field);
    const next = (field) => (event === "DELETE" ? "NULL" : "NEW." + field);
    writer.exec(`CREATE TRIGGER benchmark_task_${event} AFTER ${event} ON tasks BEGIN
      INSERT INTO benchmark_task_changes VALUES (
        CAST(unixepoch('subsec') * 1000 AS INTEGER), '${event}',
        COALESCE(${next("task_key")}, ${old("task_key")}), COALESCE(${next("source")}, ${old("source")}), ${old("status")}, ${next("status")},
        ${old("source_revision")}, ${next("source_revision")}
      ); END`);
  }
  const textarea = page.locator('textarea[aria-autocomplete="list"]:visible').last();
  await textarea.click();
  await textarea.fill(prompt);
  await textarea.press("Enter");
  await fixture.assertWorker(app);
  await Promise.race([
    startStream.promise,
    delay(30000, undefined, { ref: false }).then(async () => {
      throw Error(
        "Workbench did not start the benchmark stream: " +
          JSON.stringify({
            requests: provider.requests.map((r) => [r.scenario, r.body.stream]),
            ui: (await page.locator("body").innerText()).slice(-2200),
          }),
      );
    }),
  ]);
  // Wait with the provider paused after its first token. Opening a turn and
  // publishing its cancellable state are lifecycle writes. Record those too,
  // then measure the following 20 s while text is actually arriving.
  console.log("Provider received the workbench turn; holding the first output frame");
  await page.waitForFunction(() => document.body.innerText.includes("word0"), undefined, {
    timeout: 15000,
  });
  await delay(1500);
  await page.evaluate(() => {
    window.benchmarkInput = [];
    document.addEventListener(
      "wheel",
      (event) => {
        if (event.isTrusted) window.benchmarkInput.push(performance.now());
      },
      { passive: true, capture: true },
    );
  });
  const trace = Promise.withResolvers();
  client.once("Tracing.tracingComplete", trace.resolve);
  await client.send("Tracing.start", {
    categories: "toplevel,ipc,devtools.timeline,blink.user_timing",
    transferMode: "ReturnAsStream",
    streamFormat: "json",
  });
  tracing = true;
  const changes = (epoch) =>
    writer
      .prepare(
        `SELECT at_ms - ? AS offsetMs, task_key AS taskKey,
    event, source, previous_status AS previousStatus, status, previous_revision AS previousRevision,
    revision FROM benchmark_task_changes ORDER BY rowid`,
      )
      .all(epoch);
  const wallStart = Date.now();
  const openingChanges = changes(wallStart);
  const started = performance.now();
  console.log("Tracing Main and dispatching wheel input");
  releaseStream.resolve();
  const contended = (async () => {
    await delay(1500);
    writer.exec("BEGIN IMMEDIATE");
    const lockStarted = performance.now();
    const release = delay(1200).then(() => writer.exec("ROLLBACK"));
    try {
      const samples = await sampleReads(page, 200);
      return { samples, elapsed: performance.now() - lockStarted };
    } finally {
      await release;
    }
  })();
  // A real Chromium wheel sequence goes through its input router while the
  // visible conversation consumes the same stream the user would see.
  const sentAt = [];
  const pending = new Set();
  let inputError;
  while (performance.now() - started < 20000) {
    if (inputError) throw inputError;
    if (pending.size >= 4) await Promise.race(pending);
    const now = performance.now();
    sentAt.push(now);
    const request = client
      .send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 320,
        y: 320,
        deltaX: 0,
        deltaY: sentAt.length % 2 ? 4 : -4,
      })
      .catch((error) => {
        inputError = error;
      })
      .finally(() => pending.delete(request));
    pending.add(request);
    // A mouse keeps sampling while Chromium consumes previous events. Waiting
    // for a compositor acknowledgment here would put harness latency in the input.
    const nextTick = started + (Math.floor((now - started) / 16) + 1) * 16;
    await delay(Math.max(1, Math.ceil(nextTick - performance.now())));
  }
  await Promise.all(pending);
  if (inputError) throw inputError;
  const traceDuration = performance.now() - started;
  const writes = await contended;
  const stamps = await page.evaluate(() => window.benchmarkInput);
  const changesDuringStream = changes(wallStart).slice(openingChanges.length);
  const traceChunks = emitted;
  await client.send("Tracing.end");
  const { stream } = await trace.promise;
  const output = await open(tracePath, "wx", 0o600);
  try {
    let chunk;
    do {
      chunk = await client.send("IO.read", { handle: stream, size: 1024 * 1024 });
      await output.writeFile(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
    } while (!chunk.eof);
  } finally {
    await output.close();
    await client.send("IO.close", { handle: stream });
  }
  tracing = false;
  await page
    .getByText(/word519/)
    .first()
    .waitFor({ timeout: 20000 });
  const traceBytes = await readFile(tracePath);
  const receipt = JSON.parse(traceBytes);
  const events = receipt.traceEvents;
  const main = events.find(
    (e) => e.pid === pid && e.name === "thread_name" && e.args?.name === "CrBrowserMain",
  );
  assert(main, "Missing native Main trace");
  const mainTasks = events.filter(
    (e) => e.pid === pid && e.tid === main.tid && e.ph === "X" && /RunTask/.test(e.name),
  );
  assert(mainTasks.length > 0, "Trace omitted Main task timing");
  const tasks = mainTasks.filter((e) => e.dur >= 50000);
  const gaps = stamps.slice(1).map((x, i) => x - stamps[i]);
  assert(gaps.length > 100 && emitted >= 500 && Math.max(...stamps) - Math.min(...stamps) > 19000);
  const result = {
    checkout: execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim(),
    electron,
    kernel: release(),
    traceSha256: createHash("sha256").update(traceBytes).digest("hex"),
    platform: process.platform,
    arch: process.arch,
    trace: basename(await realpath(tracePath)),
    traceDurationMs: traceDuration,
    input: {
      dispatched: sentAt.length,
      maxDispatchGapMs: Math.max(...sentAt.slice(1).map((at, i) => at - sentAt[i])),
      delivered: stamps.length,
      maxGapMs: Math.max(...gaps),
      p99GapMs: percentile(gaps, 0.99),
    },
    totalFrames: emitted,
    framesInTrace: traceChunks,
    openingChanges,
    taskRowChangesDuringStream: changesDuringStream.length,
    changesDuringStream,
    recordedMainTasks: mainTasks.length,
    mainTasksOver50Ms: tasks.map((t) => ({
      name: t.name,
      ms: t.dur / 1000,
      nested: [
        ...new Set(
          events
            .filter(
              (e) =>
                e.pid === pid &&
                e.tid === main.tid &&
                e.ph === "X" &&
                e.ts >= t.ts &&
                e.ts < t.ts + t.dur,
            )
            .map((e) => e.name),
        ),
      ].slice(0, 16),
    })),
    idleIndexedList: { count: idle.length, p99Ms: percentile(idle, 0.99) },
    streamingIndexedList: {
      count: writes.samples.length,
      p99Ms: percentile(writes.samples, 0.99),
      writerLockMs: 1200,
      sampleDurationMs: writes.elapsed,
    },
  };
  await writeFile(join(evidence, "metrics.json"), JSON.stringify(result, null, 2) + "\n", {
    flag: "wx",
  });
  console.log(JSON.stringify(result));
  assert(traceChunks >= 400 && traceChunks < 520, "Stream must span the full sampling window");
  assert(result.input.maxGapMs < 50, "Input event interval reached 50 ms");
  assert(result.idleIndexedList.p99Ms < 2, "Idle list p99 reached 2 ms");
  assert(
    result.streamingIndexedList.p99Ms < 10 && writes.elapsed < 1200,
    "Indexed reads must complete while the write lock is held",
  );
  assert.equal(tasks.length, 0, "Inspect native Main tasks lasting at least 50 ms");
  assert.equal(changesDuringStream.length, 0, "Task rows changed during text streaming");
} catch (error) {
  console.error(error);
  throw error;
} finally {
  releaseStream.resolve();
  if (tracing && client) await client.send("Tracing.end").catch(() => {});
  writer?.close();
  await app?.close();
  await provider?.close();
  await isolated.cleanup();
}
