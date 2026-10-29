import { expect, test } from "bun:test";
import type { MobileHistoryDetailResult, MobileHistoryView } from "@cjhyy/code-shell-core";
import { readMobileHistoryDetail, validateMobileHistoryView } from "./mobileHistoryView.js";

const cursor = (sequence: number, hash = "b".repeat(64)) =>
  Buffer.from(
    JSON.stringify({ identity: "a".repeat(64), sequence, offset: 100 + sequence * 10, hash }),
  ).toString("base64url");
function view(): MobileHistoryView {
  return {
    status: "ok",
    viewId: "view",
    through: cursor(30),
    coverageStart: cursor(0),
    coverageIdentity: "incarnation",
    snapshot: {
      epoch: "main",
      nextSeq: 30,
      outputCursor: cursor(30),
      unpaired: false,
      incarnation: "incarnation",
      journalIdentity: "b".repeat(64),
      inputIds: ["receipt"],
    },
    verifiedInputIds: ["receipt"],
    state: { sessionId: "s", run: "completed", seq: 30, liveByAgent: {} },
    items: [
      {
        kind: "assistant",
        id: "a",
        text: "answer",
        reasoning: "",
        reasoningDetailRef: "reasoning",
        done: true,
      },
      { kind: "tool", id: "tool", name: "Read", done: true, detailRef: "detail" },
    ],
    totalItems: 4,
    start: 2,
    end: 4,
    before: "earlier",
  };
}
test("verified views require bounded unique rows, whole-source receipts and a contiguous frozen range", () => {
  const initial = view();
  expect(validateMobileHistoryView(initial, "s")).toBe(initial);
  const earlier = {
    ...initial,
    items: [
      { kind: "user" as const, id: "user", text: "question", clientMessageId: "receipt" },
      { kind: "system" as const, id: "system", text: "context" },
    ],
    start: 0,
    end: 2,
    before: undefined,
  };
  expect(validateMobileHistoryView(earlier, "s", initial)).toBe(earlier);
  for (const change of [
    { items: [initial.items[0], initial.items[0]] },
    { snapshot: { ...initial.snapshot, unpaired: true } },
    { verifiedInputIds: [] },
    { through: cursor(29) },
    { coverageStart: cursor(0, "c".repeat(64)) },
    { state: { ...initial.state, sessionId: "other" } },
    { state: { ...initial.state, liveByAgent: { "": "outside-tail" } } },
    { items: [{ ...initial.items[0], text: "x".repeat(1024 * 1024) }, initial.items[1]] },
  ])
    expect(() => validateMobileHistoryView({ ...initial, ...change }, "s")).toThrow();
  for (const change of [
    { viewId: "replaced" },
    { end: 3 },
    { totalItems: 5 },
    { through: cursor(31) },
    { snapshot: { ...initial.snapshot, epoch: "new" } },
    { snapshot: { ...initial.snapshot, nextSeq: 31 } },
    { state: { ...initial.state, run: "running" } },
    { verifiedInputIds: ["receipt", "unexpected"] },
  ])
    expect(() => validateMobileHistoryView({ ...earlier, ...change }, "s", initial)).toThrow();
});
function chunks(text: string): MobileHistoryDetailResult[] {
  const data = Buffer.from(JSON.stringify({ result: text, args: { path: "owned" } }));
  const pages: MobileHistoryDetailResult[] = [];
  for (let index = 0; index < data.length; index += 256 * 1024) {
    const next = Math.min(index + 256 * 1024, data.length);
    pages.push({
      status: "ok",
      ref: "detail",
      index,
      data: data.subarray(index, next).toString("base64"),
      totalBytes: data.length,
      ...(next === data.length ? { complete: true } : { complete: false, next: `part-${next}` }),
    });
  }
  return pages;
}
test("a detail exceeding 1 MiB joins exact UTF-8 bytes only after its final bounded part", async () => {
  const original = "汉🙂".repeat(170000),
    pages = chunks(original);
  let reads = 0;
  const result = await readMobileHistoryDetail(
    "detail",
    async () => pages[reads++]!,
    () => true,
  );
  expect(reads).toBeGreaterThan(4);
  expect(result).toEqual({ result: original, args: { path: "owned" } });
});
test("detail join rejects late selection, mixed reference, offset gaps, changed size and false completion", async () => {
  const pages = chunks("x".repeat(300000));
  for (const change of [
    { ref: "other" },
    { index: 1 },
    { totalBytes: 32 * 1024 * 1024 + 1 },
    { complete: true },
    { data: "!!!!" },
    { next: undefined },
  ]) {
    await expect(
      readMobileHistoryDetail(
        "detail",
        async () => ({ ...pages[0], ...change }) as any,
        () => true,
      ),
    ).rejects.toThrow();
  }
  let current = true;
  await expect(
    readMobileHistoryDetail(
      "detail",
      async () => {
        current = false;
        return pages[0]!;
      },
      () => current,
    ),
  ).rejects.toThrow();
});
