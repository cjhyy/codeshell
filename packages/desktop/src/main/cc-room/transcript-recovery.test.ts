import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RoomManager } from "../../../../server/src/mobile-remote/room-manager.js";
import { TranscriptSubscriptionManager } from "./transcript-subscriptions.js";

const roots: string[] = [];
const managers: TranscriptSubscriptionManager[] = [];
afterEach(() => {
  for (const manager of managers.splice(0)) manager.closeAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const line = (text: string) =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "transcript-recovery-"));
  roots.push(root);
  const file = join(root, "transcript.jsonl");
  writeFileSync(file, line("initial"));
  const checkpoints = join(root, "checkpoints");
  const rooms = join(root, "rooms");
  const room = new RoomManager({
    rootDir: rooms,
    createAgent: () => {
      throw new Error("unused");
    },
    onMessage() {},
  }).createRoom({ cwd: "/fixture", kind: "claude-code", claudeSessionId: "external-id" });
  const target = {
    roomId: room.id,
    cwd: "/fixture",
    sessionId: "external-id",
    kind: "claude-code" as const,
    subscriberId: "desktop",
    limit: 50,
  };
  const failures: string[] = [];
  function open(failAfterFirst = false) {
    const roomManager = new RoomManager({
      rootDir: rooms,
      createAgent: () => {
        throw new Error("unused");
      },
      onMessage() {},
    });
    const manager = new TranscriptSubscriptionManager({
      checkpointDir: checkpoints,
      hasTranscriptHistory: (id) => roomManager.hasTranscriptHistory(id),
      resolveFile: () => file,
      onStart: (id) => roomManager.beginTranscriptFollow(id),
      onStop: (id) => roomManager.endTranscriptFollow(id),
      roomCursor: (id) => roomManager.latestSeq(id),
      onMessages: (id, messages) => {
        if (failAfterFirst) {
          roomManager.ingestTranscriptMessages(id, messages.slice(0, 1));
          throw new Error("synthetic crash after first Room fsync");
        }
        roomManager.ingestTranscriptMessages(id, messages);
      },
      onFailure: (_id, message) => failures.push(message),
      pollIntervalMs: 60_000,
    });
    managers.push(manager);
    return { manager, roomManager };
  }
  const checkpoint = () =>
    JSON.parse(
      readFileSync(
        join(checkpoints, readdirSync(checkpoints).find((name) => name.endsWith(".json"))!),
        "utf8",
      ),
    );
  return { root, file, checkpoints, target, failures, open, checkpoint };
}
test("cold Host uses durable newline checkpoint and persists output missed while closed", () => {
  const f = fixture();
  const first = f.open();
  first.manager.subscribe(f.target);
  first.manager.closeAll();
  const fragment = line("missed 😀 output");
  appendFileSync(f.file, fragment.slice(0, 22));
  const second = f.open();
  second.manager.subscribe(f.target);
  expect(
    second.roomManager.getHistoryPage(f.target.roomId).messages.filter((m) => m.from === "agent"),
  ).toHaveLength(0);
  appendFileSync(f.file, fragment.slice(22));
  second.manager.subscribe({ ...f.target, subscriberId: "mobile" });
  expect(
    second.roomManager
      .getHistoryPage(f.target.roomId)
      .messages.filter((m) => m.from === "agent")
      .map((m) => m.text),
  ).toEqual(["missed 😀 output"]);
  expect(f.checkpoint().offset).toBe(Buffer.byteLength(readFileSync(f.file)));
  second.manager.closeAll();
  const third = f.open();
  third.manager.subscribe(f.target);
  expect(
    third.roomManager.getHistoryPage(f.target.roomId).messages.filter((m) => m.from === "agent"),
  ).toHaveLength(1);
});
test("crash between Room append and checkpoint commit retries actual source keys without duplicates", () => {
  const f = fixture();
  const first = f.open(true);
  first.manager.subscribe(f.target);
  appendFileSync(f.file, line("first") + line("second"));
  expect(() => first.manager.subscribe({ ...f.target, subscriberId: "mobile" })).toThrow(
    "synthetic crash",
  );
  expect(f.checkpoint().status).toBe("pending");
  const second = f.open();
  second.manager.subscribe(f.target);
  const messages = second.roomManager
    .getHistoryPage(f.target.roomId)
    .messages.filter((m) => m.from === "agent");
  expect(messages.map((m) => m.text)).toEqual(["first", "second"]);
  expect(new Set(messages.map((m) => m.transcriptSource)).size).toBe(2);
  expect(f.checkpoint().status).toBe("committed");
});
for (const mode of [
  "shrink",
  "same-size rewrite",
  "longer rewrite",
  "rotation",
  "malformed",
  "oversize partial",
] as const)
  test(`${mode} latches a visible durable barrier across Host restart`, () => {
    const f = fixture();
    const first = f.open();
    first.manager.subscribe(f.target);
    if (mode === "shrink") truncateSync(f.file, 0);
    if (mode === "same-size rewrite") writeFileSync(f.file, line("changed"));
    if (mode === "longer rewrite")
      writeFileSync(f.file, line("replacement longer") + line("suffix"));
    if (mode === "rotation") {
      renameSync(f.file, `${f.file}.old`);
      writeFileSync(f.file, line("replacement"));
    }
    if (mode === "malformed") appendFileSync(f.file, "{broken}\n");
    if (mode === "oversize partial") appendFileSync(f.file, "x".repeat(4 * 1024 * 1024 + 1));
    expect(() => first.manager.subscribe({ ...f.target, subscriberId: "mobile" })).toThrow();
    expect(f.failures).toHaveLength(1);
    expect(f.checkpoint().status).toBe("failed");
    // Even restoring the exact old inode/prefix cannot silently revive this lease.
    if (mode === "rotation") {
      rmSync(f.file);
      renameSync(`${f.file}.old`, f.file);
    } else writeFileSync(f.file, line("initial"));
    expect(() => first.manager.subscribe(f.target)).toThrow();
    expect(() => f.open().manager.subscribe(f.target)).toThrow();
    expect(f.failures).toHaveLength(1);
  });
test("a room cannot reuse a follower or saved checkpoint for another native identity", () => {
  const f = fixture();
  const first = f.open();
  first.manager.subscribe(f.target);
  expect(() => first.manager.subscribe({ ...f.target, sessionId: "other" })).toThrow("identity");
  first.manager.closeAll();
  expect(() => f.open().manager.subscribe({ ...f.target, kind: "codex" })).toThrow("identity");
});
test("corrupt checkpoint fails instead of taking a fresh EOF baseline", () => {
  const f = fixture();
  const first = f.open();
  first.manager.subscribe(f.target);
  first.manager.closeAll();
  writeFileSync(
    join(f.checkpoints, readdirSync(f.checkpoints).find((name) => name.endsWith(".json"))!),
    "{broken",
  );
  appendFileSync(f.file, line("missed"));
  expect(() => f.open().manager.subscribe(f.target)).toThrow();
});

test("missing checkpoint with persisted transcript provenance cannot silently rebaseline EOF", () => {
  const f = fixture();
  const first = f.open();
  first.manager.subscribe(f.target);
  appendFileSync(f.file, line("persisted"));
  first.manager.subscribe({ ...f.target, subscriberId: "mobile" });
  first.manager.closeAll();
  rmSync(join(f.checkpoints, readdirSync(f.checkpoints).find((name) => name.endsWith(".json"))!));
  appendFileSync(f.file, line("missed"));
  expect(() => f.open().manager.subscribe(f.target)).toThrow("checkpoint is missing");
});

test("independent Node writer can keep appending during long-file capture, paging and cold recovery", async () => {
  const { spawn } = await import("node:child_process");
  const f = fixture();
  // 62 MiB of valid non-rendered CLI metadata exercises consumed-prefix checks
  // without making a synthetic giant assistant bubble dominate the UI test.
  const metadata = JSON.stringify({ type: "progress", detail: "m".repeat(128 * 1024) }) + "\n";
  writeFileSync(f.file, metadata.repeat(496));
  const writerSource = `
    import { appendFileSync, closeSync, openSync } from 'node:fs';
    const file = process.argv[1];
    const fd = openSync(file, 'a');
    try {
      console.log('ready');
      for (let n = 0; n < 120; n++) {
        const metadata = JSON.stringify({type:'progress', detail:'x'.repeat(128)})+'\\n';
        const message = JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'writer-'+n}]}})+'\\n';
        const bytes = Buffer.from(metadata + message);
        appendFileSync(fd, bytes.subarray(0, 100));
        await new Promise(resolve => setTimeout(resolve, 2));
        appendFileSync(fd, bytes.subarray(100));
        await new Promise(resolve => setTimeout(resolve, 50));
        if ((n + 1) % 20 === 0) console.log('progress:' + (n + 1));
      }
    } finally {
      closeSync(fd);
    }
    console.log('done:120');
  `;
  const child = spawn("node", ["--input-type=module", "-e", writerSource, f.file], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Keep consuming both pipes and bound diagnostics without assuming a pipe
  // caused an exit/close timeout. The writer emits only six progress records.
  let stdout = "",
    stderr = "",
    stdoutBytes = 0,
    completed = 0,
    lastProgressAt: number | undefined,
    loopDone = false;
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdout = (stdout + chunk.toString()).slice(-2000);
    const progress = [...stdout.matchAll(/progress:(\d+)\n/g)].at(-1);
    if (progress && Number(progress[1]) > completed) {
      completed = Number(progress[1]);
      lastProgressAt = Date.now();
    }
    loopDone ||= stdout.includes("done:120\n");
  });
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  let exitedYet = false;
  let exitEvent: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let closeEvent: typeof exitEvent;
  child.once("exit", (code, signal) => {
    exitedYet = true;
    exitEvent = { code, signal };
  });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      closeEvent = { code, signal };
      resolve(code);
    });
  });
  // Report the writer's state instead of an opaque test timeout if it never closes.
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  const settled = () =>
    Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        closeTimer = setTimeout(() => {
          let processPresence: string;
          try {
            process.kill(child.pid!, 0);
            processPresence = "present";
          } catch (error) {
            processPresence = (error as NodeJS.ErrnoException).code ?? String(error);
          }
          reject(
            new Error(
              `writer did not close: ${JSON.stringify({
                pid: child.pid,
                exitCode: child.exitCode,
                signalCode: child.signalCode,
                exitedYet,
                exitEvent: exitEvent ?? null,
                closeEvent: closeEvent ?? null,
                processPresence,
                completed,
                loopDone,
                progressAgeMs: lastProgressAt === undefined ? null : Date.now() - lastProgressAt,
                stdoutBytes,
                stdout,
                stdoutEnded: child.stdout.readableEnded,
                stderrEnded: child.stderr.readableEnded,
                stderr: stderr.slice(-2000),
              })}`,
            ),
          );
        }, 30_000);
      }),
    ]).finally(() => clearTimeout(closeTimer));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
    });
    const first = f.open();
    const started = performance.now();
    first.manager.subscribe(f.target);
    const initialMs = performance.now() - started;
    const drains: number[] = [];
    for (let n = 0; n < 6; n++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      const start = performance.now();
      first.manager.subscribe({ ...f.target, subscriberId: "mobile" });
      drains.push(performance.now() - start);
    }
    console.log("CCRoom ongoing writer capture", JSON.stringify({ initialMs, drains }));
    expect(child.exitCode).toBeNull();
    first.manager.subscribe(f.target);
    expect(f.failures).toEqual([]);
    expect(f.checkpoint().status).toBe("committed");
    const history = first.roomManager.getHistoryPage(f.target.roomId, { limit: 7 });
    let page = history;
    let count = page.messages.length;
    while (page.nextCursor) {
      page = first.roomManager.getHistoryPage(f.target.roomId, {
        cursor: page.nextCursor,
        limit: 7,
      });
      count += page.messages.length;
    }
    expect(count).toBe(history.throughSeq);
    expect(child.exitCode).toBeNull();
    first.manager.closeAll();
    const cold = f.open();
    const coldStart = performance.now();
    cold.manager.subscribe(f.target);
    const coldMs = performance.now() - coldStart;
    console.log("CCRoom ongoing writer cold", JSON.stringify({ coldMs }));
    expect(await settled()).toBe(0);
    expect(completed).toBe(120);
    expect(loopDone).toBe(true);
    const snapshot = cold.manager.subscribe(f.target);
    expect(snapshot.messages.map((message) => message.text)).toEqual(
      Array.from({ length: 50 }, (_, n) => `writer-${n + 70}`),
    );
    appendFileSync(f.file, line("offline-after-writer"));
    cold.manager.subscribe({ ...f.target, subscriberId: "mobile" });
    expect(
      cold.roomManager
        .getHistoryPage(f.target.roomId)
        .messages.filter((message) => message.text === "offline-after-writer"),
    ).toHaveLength(1);
    expect(f.failures).toEqual([]);
    // A measured regression bound prevents restoring full JSON parsing on each
    // poll. It allows slower shared CI hosts; the receipt records actual costs.
    expect(Math.max(initialMs, coldMs, ...drains)).toBeLessThan(2000);
    console.log(
      "CCRoom independent writer timing",
      JSON.stringify({
        bytes: readFileSync(f.file).length,
        initialMs: Math.round(initialMs),
        maxDrainMs: Math.round(Math.max(...drains)),
        coldMs: Math.round(coldMs),
      }),
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await closed;
  }
}, 90000);
