import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomManager } from "./room-manager.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "room-pages-"));
  roots.push(root);
  const make = () =>
    new RoomManager({
      rootDir: root,
      createAgent: () => {
        throw new Error("unused");
      },
      onMessage() {},
    });
  const manager = make();
  const room = manager.createRoom({ cwd: "/synthetic" });
  const append = (text: string) =>
    (manager as any).append(room.id, { from: "agent", type: "text", text });
  return { root, manager, make, room, append, file: join(root, room.id, "messages.jsonl") };
}
test("frozen pages survive append and cold Host restart without changing their boundary", () => {
  const f = fixture();
  for (let n = 0; n < 11; n++) f.append(`message ${n}`);
  const first = f.manager.getHistoryPage(f.room.id, { limit: 3 });
  expect(first.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  expect(first.throughSeq).toBe(12);
  f.append("after freeze");
  const reopened = f.make();
  let page = first;
  const seqs = first.messages.map((m) => m.seq);
  while (page.nextCursor) {
    page = reopened.getHistoryPage(f.room.id, { cursor: page.nextCursor, limit: 3 });
    seqs.push(...page.messages.map((m) => m.seq));
    expect(page.throughSeq).toBe(12);
  }
  expect(seqs).toEqual(Array.from({ length: 12 }, (_, n) => n + 1));
  expect(page.complete).toBe(true);
  expect(reopened.getHistoryPage(f.room.id, { sinceSeq: 12 }).messages.map((m) => m.seq)).toEqual([
    13,
  ]);
});
test("initial filtering retains the frozen throughSeq and does not rescan a tail window", () => {
  const f = fixture();
  for (let n = 0; n < 10010; n++) f.append(`m${n}`);
  const page = f.manager.getHistoryPage(f.room.id, { sinceSeq: 0, limit: 2 });
  expect(page.messages.map((m) => m.seq)).toEqual([1, 2]);
  expect(page.throughSeq).toBe(10011);
  expect(
    f.manager.getHistoryPage(f.room.id, { sinceSeq: 10009 }).messages.map((m) => m.seq),
  ).toEqual([10010, 10011]);
}, 120000);
test("cursor is room scoped, authenticated, and rejects reset filters", () => {
  const f = fixture();
  f.append("one");
  const page = f.manager.getHistoryPage(f.room.id, { limit: 1 });
  const cursor = page.nextCursor!;
  const other = f.manager.createRoom({ cwd: "/other" });
  expect(() => f.manager.getHistoryPage(other.id, { cursor })).toThrow();
  const [body, signature] = cursor.split(".");
  const changed = JSON.parse(Buffer.from(body!, "base64url").toString());
  changed.offset++;
  expect(() =>
    f.manager.getHistoryPage(f.room.id, {
      cursor: `${Buffer.from(JSON.stringify(changed)).toString("base64url")}.${signature}`,
    }),
  ).toThrow("signature");
  expect(() => f.manager.getHistoryPage(f.room.id, { cursor, sinceSeq: 0 })).toThrow();
});
for (const [label, suffix] of [
  ["malformed", "{broken}\n"],
  ["torn", "{broken"],
  ["gap", JSON.stringify({ seq: 3, ts: 1, from: "agent", type: "text" }) + "\n"],
  ["invalid UTF-8", Buffer.from([0xff, 0x0a])],
] as const) {
  test(`${label} records block full history and cold sequence seeding`, () => {
    const f = fixture();
    appendFileSync(f.file, suffix);
    expect(() => f.manager.getHistoryPage(f.room.id)).toThrow();
    expect(() =>
      (f.make() as any).append(f.room.id, {
        from: "agent",
        type: "text",
        text: "must not conceal corruption",
      }),
    ).toThrow();
  });
}
test("modified frozen copies and symlink snapshot directories fail explicitly", () => {
  const f = fixture();
  f.append("one");
  const page = f.manager.getHistoryPage(f.room.id, { limit: 1 });
  const directory = join(f.root, f.room.id, "history-snapshots");
  const snapshotFile = join(directory, `${page.snapshotId}.jsonl`);
  writeFileSync(snapshotFile, readFileSync(snapshotFile).toString().replace("one", "two"));
  expect(() => f.manager.getHistoryPage(f.room.id, { cursor: page.nextCursor })).toThrow(
    "modified",
  );
  renameSync(directory, `${directory}.saved`);
  symlinkSync(`${directory}.saved`, directory);
  expect(() => f.manager.getHistoryPage(f.room.id)).toThrow("directory");
});
test("expired snapshot cursors fail instead of silently restarting from the live tail", () => {
  const f = fixture();
  f.append("one");
  const first = f.manager.getHistoryPage(f.room.id, { limit: 1 });
  for (let n = 0; n < 10; n++) f.manager.getHistoryPage(f.room.id, { limit: 1 });
  expect(
    readdirSync(join(f.root, f.room.id, "history-snapshots")).filter((n) => n.endsWith(".json"))
      .length,
  ).toBe(8);
  expect(() => f.manager.getHistoryPage(f.room.id, { cursor: first.nextCursor })).toThrow();
});
