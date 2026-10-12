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
