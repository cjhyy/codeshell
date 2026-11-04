import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "./room-manager.js";
import { scanRoomHistoryAsync } from "./room-history.js";

test("cold Room receipt preparation yields and primes synchronous send without another full scan", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "room-receipt-index-"));
  const inputs: string[] = [];
  const open = () =>
    new RoomManager({
      rootDir: root,
      onMessage() {},
      createAgent: () => {
        let running = false;
        return {
          start() {
            running = true;
          },
          isRunning() {
            return running;
          },
          stop() {
            running = false;
          },
          send(text) {
            inputs.push(text);
            return true;
          },
        };
      },
    });
  const room = open().createRoom({ cwd: root });
  const file = join(root, room.id, "messages.jsonl");
  fs.writeFileSync(
    file,
    Array.from(
      { length: 128 },
      (_, n) =>
        JSON.stringify({
          seq: n + 1,
          ts: 1,
          from: "system",
          type: "progress",
          text: "x".repeat(128 * 1024),
        }) + "\n",
    ).join(""),
  );
  const manager = open();
  const receipt = {
    clientMessageId: "intent",
    clientDeviceId: "phone",
    clientIntentHash: createHash("sha256").update("intent").digest("hex"),
  };
  const original = fs.readSync;
  let synchronousBytes = 0;
  const reader = spyOn(fs, "readSync").mockImplementation(((
    ...args: Parameters<typeof fs.readSync>
  ) => {
    const count = (original as any)(...args);
    if (fs.fstatSync(args[0]).size > 1024 * 1024) synchronousBytes += count;
    return count;
  }) as typeof fs.readSync);
  try {
    expect(() => manager.send(room.id, "hello", [], receipt)).toThrow("prepared");
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    await manager.prepareInputReceipts(room.id);
    expect(yielded).toBe(true);
    expect(manager.send(room.id, "hello", [], receipt)).toBe(true);
    expect(manager.send(room.id, "hello", [], receipt)).toBe(true);
    expect(inputs).toHaveLength(1);
    // A cold nextSeq must reuse the verified index's sequence, not rescan 16 MiB.
    expect(synchronousBytes).toBeLessThan(16);
    fs.appendFileSync(
      file,
      JSON.stringify({
        seq: manager.latestSeq(room.id) + 1,
        ts: 1,
        from: "system",
        type: "changed",
      }) + "\n",
    );
    expect(() => manager.hasAcceptedInput(room.id, receipt)).toThrow("changed");
  } finally {
    reader.mockRestore();
    manager.close(room.id);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("asynchronous receipt snapshots reject concurrent history mutation and malformed tails", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "room-receipt-proof-"));
  const file = join(root, "messages.jsonl");
  const raw = Array.from(
    { length: 16 },
    (_, n) => JSON.stringify({ seq: n + 1, text: "x".repeat(64 * 1024) }) + "\n",
  ).join("");
  try {
    fs.writeFileSync(file, raw);
    await expect(
      scanRoomHistoryAsync(
        file,
        (value: any) => value,
        (message) => {
          if (message.seq === 1) fs.appendFileSync(file, JSON.stringify({ seq: 17 }) + "\n");
        },
      ),
    ).rejects.toThrow("changed");
    fs.writeFileSync(file, raw + '{"partial":');
    await expect(scanRoomHistoryAsync(file, (value: any) => value)).rejects.toThrow("incomplete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
