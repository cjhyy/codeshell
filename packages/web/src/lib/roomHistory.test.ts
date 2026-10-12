import { expect, test } from "bun:test";
import { collectRoomHistory, RoomHistoryAccumulator } from "./roomHistory.js";
const page = (messages: number[], complete = true, extra = {}) => ({
  snapshotId: "snapshot",
  throughSeq: 4,
  messages: messages.map((seq) => ({ seq })),
  complete,
  ...extra,
});
test("collects multiple frozen pages before committing a complete range", async () => {
  const requests: unknown[] = [];
  const messages = await collectRoomHistory(async (request) => {
    requests.push(request);
    return request.cursor ? page([3, 4]) : page([2], false, { nextCursor: "next" });
  }, 1);
  expect(messages).toEqual([{ seq: 2 }, { seq: 3 }, { seq: 4 }]);
  expect(requests).toEqual([
    { sinceSeq: 1, limit: 200 },
    { cursor: "next", limit: 200 },
  ]);
});
for (const [name, pages] of [
  ["gaps", [page([2, 4])]],
  ["duplicates", [page([2, 2, 3, 4])]],
  ["incomplete final", [page([2, 3])]],
  [
    "snapshot switch",
    [page([2], false, { nextCursor: "next" }), page([3, 4], true, { snapshotId: "other" })],
  ],
  [
    "boundary switch",
    [page([2], false, { nextCursor: "next" }), page([3], true, { throughSeq: 3 })],
  ],
  ["loop", [page([2], false, { nextCursor: "next" }), page([3], false, { nextCursor: "next" })]],
  ["empty intermediate", [page([], false, { nextCursor: "next" })]],
] as const)
  test(`rejects ${name}`, () => {
    const a = new RoomHistoryAccumulator(1);
    expect(() => {
      for (const p of pages) a.accept(p);
    }).toThrow();
  });
