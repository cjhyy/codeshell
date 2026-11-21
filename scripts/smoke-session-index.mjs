import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "../packages/core/dist/index.js";
import { SessionOutputJournal } from "../packages/core/dist/index.internal.js";
import { createSessionIndex, listDiskSessions } from "../packages/server/dist/index.storage.js";

const entry = fileURLToPath(import.meta.url);

async function fixture() {
  const owned = await mkdtemp(join(tmpdir(), "codeshell-session-index-"));
  const root = join(owned, "sessions");
  const options = { limit: 30 };
  const set = async (id, patch = {}) => {
    const dir = join(root, id);
    await mkdir(dir, { recursive: true });
    const staging = join(dir, "state.new");
    await writeFile(
      staging,
      JSON.stringify({
        cwd: "",
        title: id,
        origin: "desktop",
        parentSessionId: null,
        status: "completed",
        ...patch,
      }),
    );
    await rename(staging, join(dir, "state.json"));
  };
  let index;
  let writer;
  let output;
  try {
    await set("a");
    await set("b");
    await set("legacy-tui", { origin: "tui" });
    index = createSessionIndex(root);
    assert.deepEqual(await index.list(options), await listDiskSessions(options, root));
    const base = join(owned, ".codeshell-state");
    const [key] = await readdir(base);
    const file = join(base, key, "current", "state.sqlite");
    writer = new DatabaseSync(file);
    assert.equal(writer.prepare("SELECT count(*) AS n FROM sessions").get().n, 3);
    await set("a", { archivedAt: 100 });
    await index.changed("a");
    assert.deepEqual(await index.list(options), await listDiskSessions(options, root));
    const tui = writer.prepare("SELECT origin FROM sessions WHERE id=?").get("legacy-tui");
    assert.equal(tui.origin, "tui");
    // Simulate an old client that deletes a directory without emitting an invalidation.
    await rm(join(root, "b"), { recursive: true });
    await index.reconcile();
    assert.equal(writer.prepare("SELECT 1 FROM sessions WHERE id=?").get("b"), undefined);

    // A separate writer dies immediately after the durable write, before a callback.
    const crash = spawn(process.execPath, [entry, "crash", root], { stdio: "inherit" });
    const [code, signal] = await once(crash, "exit");
    assert.ok(code !== 0 || signal);
    await index.close();
    index = createSessionIndex(root);
    const refreshed = await index.list({ limit: 10, sessionId: "crash-record" });
    assert.equal(refreshed.sessions[0]?.title, "committed before exit");
    const activity = () =>
      writer.prepare("SELECT last_activity_at FROM sessions WHERE id='crash-record'").get()
        .last_activity_at;
    const originalActivity = activity();
    new SessionManager(root).setSessionArchived("crash-record", Date.now());
    await index.changed("crash-record");
    assert.ok(originalActivity > 0);
    assert.equal(
      activity(),
      originalActivity,
      "Archiving must not move the task's run activity time",
    );
    new SessionManager(root).setSessionArchived("crash-record", undefined);
    await index.changed("crash-record");
    await set("locked");
    await index.changed("locked");
    output = spawn(process.execPath, [entry, "output", root], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const outputSettled = once(output, "exit");
    await once(output, "message");
    writer.exec("BEGIN IMMEDIATE");
    await set("locked", { title: "new title" });
    const blocked = index.changed("locked");
    const observed = [];
    let frames = 0;
    output.on("message", () => {
      frames++;
    });
    const until = Date.now() + 1200;
    while (Date.now() < until) {
      const begin = performance.now();
      const page = await index.list(options);
      observed.push(performance.now() - begin);
      assert.ok(page.sessions.some((row) => row.id === "locked"));
      await delay(2);
    }
    writer.exec("COMMIT");
    await blocked;
    output.send("stop");
    assert.equal((await outputSettled)[0], 0);
    output = undefined;
    assert.ok(
      observed.length >= 40 && frames >= 5,
      "Expected overlapping list reads and durable stream output",
    );
    const p99 = observed.sort((a, b) => a - b)[Math.ceil(observed.length * 0.99) - 1];
    console.log(
      `WAL contention: ${observed.length} catalog reads and ${frames} output commits, p99 ${p99.toFixed(2)} ms`,
    );
    assert.ok(p99 < 10, "Indexed list p99 exceeded 10 ms under contention");
    assert.equal(
      (await index.list({ limit: 1, sessionId: "locked" })).sessions[0].title,
      "new title",
    );
    await index.close();
    writer.close();
    writer = undefined;
    await writeFile(file, "damaged fixture");
    index = createSessionIndex(root);
    assert.deepEqual(await index.list(options), await listDiskSessions(options, root));
    const quarantine = (await readdir(dirname(dirname(file)))).find((name) =>
      name.startsWith("quarantine-"),
    );
    assert.ok(quarantine);
    assert.equal(
      await readFile(join(dirname(dirname(file)), quarantine, "state.sqlite"), "utf8"),
      "damaged fixture",
    );
  } finally {
    output?.kill();
    writer?.close();
    await index?.close();
    await rm(owned, { recursive: true, force: true });
  }
}

if (process.argv[2] === "crash") {
  const root = process.argv[3];
  const manager = new SessionManager(root);
  const { state } = manager.create("", "fixture", "fixture", "crash-record", null, "desktop");
  state.title = "committed before exit";
  assert.ok(manager.saveState(state));
  process.kill(process.pid, "SIGKILL");
} else if (process.argv[2] === "output") {
  const root = process.argv[3];
  const manager = new SessionManager(root);
  const session = manager.create("", "fixture", "fixture", "output-writer", null, "desktop");
  const run = session.transcript.appendMessage("user", "fixture").id;
  manager.startSessionRun(session.state, run);
  const journal = new SessionOutputJournal(
    root,
    "output-writer",
    run,
    session.transcript.getEvents()[0].id,
  );
  process.send("ready");
  const tick = setInterval(() => {
    journal.append({ type: "text_delta", text: "fixture" });
    process.send("committed");
  }, 15);
  process.once("message", () => {
    clearInterval(tick);
    process.disconnect();
  });
} else {
  await fixture();
}
