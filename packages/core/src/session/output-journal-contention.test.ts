import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lock } from "../utils/lockfile.js";
import { SessionManager } from "./session-manager.js";
import { readOutputJournal, SessionOutputJournal } from "./output-journal.js";
import { buildWrappedOnStream, createRunOutputJournalPolicy } from "../engine/run-stream.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "journal-contention-"));
  const manager = new SessionManager(root);
  const id = "session";
  const session = manager.create(root, "fixture", "fixture", id);
  const run = session.transcript.appendMessage("user", "fixture").id;
  manager.startSessionRun(session.state, run);
  return { root, manager, session, run, id, state: join(root, id, "state.json") };
}

for (const phase of ["admission", "append"] as const)
  test(`a short state CAS in another Node process does not poison journal ${phase}`, async () => {
    const f = fixture();
    const events: unknown[] = [];
    const wrapped = buildWrappedOnStream({
      getSession: () => f.session,
      setLatestTodos() {},
      userOnStream: (event) => events.push(event),
      outputJournal: createRunOutputJournalPolicy(
        f.manager,
        () => f.session,
        () => f.run,
      ),
    });
    const started = { type: "session_started" as const, sessionId: f.id, promptTokens: 0 };
    if (phase === "append") wrapped(started);
    const module = createRequire(import.meta.url).resolve("proper-lockfile");
    const child = spawn(
      "node",
      [
        "-e",
        `
      const unlock = require(process.argv[1]).lockSync(process.argv[2], {realpath:false});
      const fs = require('node:fs');
      fs.writeSync(1, 'ready');
      while (!fs.existsSync(process.argv[3])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);
      unlock(); process.exit(0);
    `,
        module,
        f.state,
        join(f.root, "release"),
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
        child.once("exit", () => reject(new Error(stderr || "lock child exited before readiness")));
      });
      writeFileSync(join(f.root, "release"), "release soon");
      expect(() =>
        wrapped(phase === "admission" ? started : { type: "turn_complete", reason: "completed" }),
      ).not.toThrow();
      wrapped.finish();
      expect(f.manager.readSessionState(f.id)?.outputRecoveryIncomplete).not.toBe(true);
      expect(readOutputJournal(f.root, f.id).status).toBe("ok");
      expect(events).toHaveLength(phase === "admission" ? 1 : 2);
      expect(await closed).toBe(0);
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null) child.kill("SIGKILL");
      await closed;
      rmSync(f.root, { recursive: true, force: true });
    }
  });

test("a local asynchronous state lease is never synchronously waited on", async () => {
  const f = fixture();
  const writer = new SessionOutputJournal(f.root, f.id, f.run);
  const release = await lock(f.state, { realpath: false });
  let released = false;
  const completion = new Promise<void>((resolve, reject) =>
    setImmediate(() => {
      release().then(() => {
        released = true;
        resolve();
      }, reject);
    }),
  );
  try {
    const start = performance.now();
    expect(() => writer.append({ type: "text_delta", text: "retry later" })).toThrow();
    // The output failure policy's state CAS must not wait on that same holder either.
    expect(() =>
      f.manager.updateSessionState(f.id, { outputRecoveryIncomplete: true }, f.run),
    ).toThrow();
    expect(performance.now() - start).toBeLessThan(30);
    expect(released).toBe(false);
    await completion;
    expect(() => writer.append({ type: "text_delta", text: "retry later" })).not.toThrow();
    expect(readOutputJournal(f.root, f.id).status).toBe("ok");
  } finally {
    await completion;
    rmSync(f.root, { recursive: true, force: true });
  }
});
